import { BzipError, type BzipErrorCode } from '../errors.ts';
import { BZIP_HEADER } from '../format/constants.ts';
import { combineCrc } from '../format/crc32.ts';
import type { ByteSink } from '../internal/bit-writer.ts';
import type { ResolvedDecompressOptions } from '../types.ts';
import { findMarker, MARKER_SCAN_LOOKAHEAD, type Marker, type MarkerKind } from './marker-scanner.ts';
import { WorkerPool, type WorkerDefinition } from './pool.ts';

type SegmentKind = 'unknown' | MarkerKind;

/** `findMarker` plus the absolute byte index of `bytes[0]`; tests use it to inject false markers. */
export type MarkerFinder = (
	bytes: Uint8Array,
	fromByte: number,
	minimumBit: number,
	absoluteBase: number
) => Marker | undefined;
type SegmentResult =
	| { state: 'pending' | 'running' }
	| { state: 'done'; storedCrc: number; output: Uint8Array }
	| { state: 'failed'; failure: Failure };
type EngineState = 'decoding' | 'after-member' | 'ignoring-trailing' | 'finished' | 'failed';

interface Failure {
	readonly code: BzipErrorCode;
	readonly message: string;
	/** Absolute bit position in the compressed stream. */
	readonly position: number;
	readonly expected?: number;
	readonly actual?: number;
}

/**
 * A run of compressed bits that starts at a marker candidate and ends at the next one.
 * Its bytes cover `floor(startBit / 8)` up to `ceil(endBit / 8)` once the segment is closed.
 */
interface Segment {
	kind: SegmentKind;
	readonly startBit: number;
	endBit: number | undefined;
	bytes: Uint8Array | undefined;
	maximumBlockLength: number | undefined;
	result: SegmentResult;
	/** Incremented whenever the segment is re-dispatched so stale worker results are ignored. */
	generation: number;
}

const HEADER_BYTES = 4;
const END_MARKER_BITS = 48 + 32;
const INITIAL_CAPACITY = 256 * 1024;

const maximumCompressedBytes = (maximumBlockLength: number): number => maximumBlockLength * 4 + 64 * 1024;

const readBits = (bytes: Uint8Array, bit: number, count: number): number => {
	let result = 0;
	for (let index = 0; index < count; index++) {
		const position = bit + index;
		result = (result << 1) | ((bytes[Math.floor(position / 8)]! >>> (7 - (position & 7))) & 1);
	}
	return result >>> 0;
};

/**
 * Splits a bzip2 stream at block markers and decodes the blocks on worker threads while
 * emitting their output in stream order. Marker candidates are verified by decoding: a
 * segment that fails to decode is extended over the following segment and retried, so a
 * marker pattern occurring by chance inside compressed data does not corrupt the result.
 */
export class ParallelDecoderEngine {
	readonly #options: ResolvedDecompressOptions;
	readonly #sink: ByteSink;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #pool: WorkerPool;
	readonly #inFlightLimit: number;

	#buffer = new Uint8Array(INITIAL_CAPACITY);
	/** Absolute byte index of `#buffer[0]`. */
	#bufferBase = 0;
	#bufferLength = 0;
	/** Absolute byte index from which marker scanning resumes. */
	#scanByte = 0;
	#scanning = false;
	/** Absolute byte index at which a member header is expected, if one is pending. */
	#pendingHeaderByte: number | undefined = 0;
	#currentBlockLength: number | undefined;
	#membersScanned = 0;

	readonly #segments: Segment[] = [];
	#nextTaskId = 0;

	#state: EngineState = 'decoding';
	#member = 0;
	#blocksInMember = 0;
	#combinedCrc = 0;
	#outputLength = 0;
	#final = false;
	#failure: Error | undefined;
	#waiters: (() => void)[] = [];

	readonly #findMarker: MarkerFinder;

	constructor(
		options: ResolvedDecompressOptions,
		concurrency: number,
		sink: ByteSink,
		hooks: { findMarker?: MarkerFinder; onError?: (error: Error) => void; worker?: WorkerDefinition } = {}
	) {
		this.#options = options;
		this.#sink = sink;
		this.#onError = hooks.onError;
		this.#pool = new WorkerPool(concurrency, hooks.worker);
		this.#inFlightLimit = concurrency * 2;
		this.#findMarker = hooks.findMarker ?? findMarker;
	}

	async push(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) throw new TypeError('Bzip2 input chunks must be Uint8Array values');
		if (this.#failure !== undefined) throw this.#failure;
		if (this.#state === 'ignoring-trailing') return;
		if (this.#state === 'finished') {
			throw this.#fail(this.#createError('INVALID_STATE', 'Cannot write to a decoder after it has finished'));
		}
		if (this.#state === 'after-member') {
			if (chunk.byteLength === 0) return;
			this.#run(() => this.#handleTrailingData());
			if (this.#failure !== undefined) throw this.#failure;
			return;
		}

		this.#append(chunk);
		this.#run(() => {
			this.#scan();
			this.#advance();
		});

		for (;;) {
			if (this.#failure !== undefined) throw this.#failure;
			if (this.#state !== 'decoding') return;
			if (this.#inFlight() < this.#inFlightLimit && !this.#openSegmentOverflowed()) return;
			await this.#progress();
		}
	}

	async finish(): Promise<void> {
		try {
			if (this.#failure !== undefined) throw this.#failure;
			if (this.#state === 'finished') return;
			if (this.#state === 'ignoring-trailing' || this.#state === 'after-member') {
				this.#state = 'finished';
				return;
			}

			this.#final = true;
			this.#run(() => {
				this.#scan();
				this.#closeOpenSegment(this.#bufferEnd() * 8);
				this.#dispatch();
				this.#advance();
			});

			while (this.#failure === undefined && this.#segments.length > 0 && this.#state === 'decoding') {
				await this.#progress();
			}
			if (this.#failure !== undefined) throw this.#failure;

			if (this.#state === 'decoding') {
				this.#run(() => {
					if (this.#member === 0 && this.#pendingHeaderByte !== undefined) {
						throw this.#createError(
							'UNEXPECTED_EOF',
							'Input ended before the first bzip2 header was complete'
						);
					}
					throw this.#createError(
						'UNEXPECTED_EOF',
						'Compressed input ended before the bzip2 member was complete'
					);
				});
				throw this.#failure!;
			}

			this.#state = 'finished';
		} finally {
			this.#pool.close();
		}
	}

	close(): void {
		// Cancellation owns the stream's error; late pool rejections must not replace it.
		for (const segment of this.#segments) segment.generation++;
		this.#segments.length = 0;
		this.#state = 'finished';
		this.#pool.close();
		this.#notify();
	}

	// ---------------------------------------------------------------------------------------
	// Input buffering and marker scanning
	// ---------------------------------------------------------------------------------------

	#bufferEnd(): number {
		return this.#bufferBase + this.#bufferLength;
	}

	#append(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return;

		// Bytes before the open segment (or the pending header) are no longer needed.
		const open = this.#openSegment();
		const keepFrom = Math.min(
			open === undefined ? Number.POSITIVE_INFINITY : Math.floor(open.startBit / 8),
			this.#pendingHeaderByte ?? Number.POSITIVE_INFINITY,
			this.#bufferEnd()
		);
		const discard = keepFrom - this.#bufferBase;
		const retained = this.#bufferLength - discard;
		const required = retained + chunk.byteLength;

		if (required > this.#buffer.length) {
			let capacity = this.#buffer.length;
			while (capacity < required) capacity *= 2;
			const replacement = new Uint8Array(capacity);
			replacement.set(this.#buffer.subarray(discard, this.#bufferLength));
			this.#buffer = replacement;
		} else if (discard > 0 && this.#buffer.length - this.#bufferLength < chunk.byteLength) {
			this.#buffer.copyWithin(0, discard, this.#bufferLength);
		} else if (discard > 0) {
			// Enough room remains; defer compaction until it is needed.
			this.#buffer.set(chunk, this.#bufferLength);
			this.#bufferLength += chunk.byteLength;
			return;
		}

		this.#bufferBase = keepFrom;
		this.#bufferLength = retained;
		this.#buffer.set(chunk, this.#bufferLength);
		this.#bufferLength += chunk.byteLength;
	}

	#bytesFrom(absoluteByte: number, absoluteEnd: number): Uint8Array {
		return this.#buffer.subarray(absoluteByte - this.#bufferBase, absoluteEnd - this.#bufferBase);
	}

	#openSegment(): Segment | undefined {
		const last = this.#segments[this.#segments.length - 1];
		return last !== undefined && last.endBit === undefined ? last : undefined;
	}

	#scan(): void {
		for (;;) {
			if (this.#pendingHeaderByte !== undefined) {
				if (!this.#readHeader()) return;
			}
			if (!this.#scanning) return;

			const open = this.#openSegment();
			if (open === undefined) return;

			const view = this.#bytesFrom(this.#bufferBase, this.#bufferEnd());
			const marker = this.#findMarker(
				view,
				this.#scanByte - this.#bufferBase,
				open.startBit - this.#bufferBase * 8,
				this.#bufferBase
			);

			if (marker === undefined) {
				this.#scanByte = Math.max(this.#scanByte, this.#bufferEnd() - MARKER_SCAN_LOOKAHEAD);
				this.#checkOpenSegment(open);
				return;
			}

			const bit = marker.bit + this.#bufferBase * 8;
			this.#scanByte = Math.ceil(marker.bit / 8) + this.#bufferBase + 1;

			if (open.kind === 'unknown' && bit === open.startBit) {
				open.kind = marker.kind;
			} else {
				this.#closeOpenSegment(bit);
				this.#segments.push(this.#createSegment(marker.kind, bit));
			}

			if (marker.kind === 'end') {
				// The member ends after the combined CRC and padding; a header may follow.
				this.#pendingHeaderByte = Math.ceil((bit + END_MARKER_BITS) / 8);
				this.#currentBlockLength = undefined;
			}

			this.#dispatch();
		}
	}

	/** Parses the member header at `#pendingHeaderByte` once its bytes are available. */
	#readHeader(): boolean {
		const headerByte = this.#pendingHeaderByte!;
		const available = this.#bufferEnd() - headerByte;
		if (available < HEADER_BYTES) return false;

		const header = this.#bytesFrom(headerByte, headerByte + HEADER_BYTES);
		const magicMatches = BZIP_HEADER.every((expected, index) => header[index] === expected);
		const blockSize = header[3]! - 0x30;
		const valid = magicMatches && blockSize >= 1 && blockSize <= 9;

		if (this.#membersScanned === 0) {
			// Nothing precedes the first header, so its problems are reported immediately.
			if (!magicMatches) {
				throw this.#createError(
					'INVALID_MAGIC',
					'Input does not begin with a bzip2 header',
					headerByte * 8 + 24
				);
			}
			if (!valid) {
				throw this.#createError(
					'INVALID_BLOCK_SIZE',
					`Invalid bzip2 block size ${blockSize}`,
					headerByte * 8 + 32
				);
			}
		}

		this.#pendingHeaderByte = undefined;
		if (!valid) {
			// Whatever follows is trailing data or corruption; the stream-order processor decides.
			this.#currentBlockLength = undefined;
			return true;
		}

		if (this.#membersScanned === 0) this.#member = 1;
		this.#membersScanned++;
		this.#currentBlockLength = blockSize * 100_000;
		this.#scanning = true;
		this.#scanByte = Math.max(this.#scanByte, headerByte + HEADER_BYTES);

		if (this.#openSegment() === undefined) {
			this.#segments.push(this.#createSegment('unknown', (headerByte + HEADER_BYTES) * 8));
		}
		return true;
	}

	#createSegment(kind: SegmentKind, startBit: number): Segment {
		return {
			kind,
			startBit,
			endBit: undefined,
			bytes: undefined,
			maximumBlockLength: this.#currentBlockLength,
			result: { state: 'pending' },
			generation: 0
		};
	}

	#closeOpenSegment(endBit: number): void {
		const open = this.#openSegment();
		if (open === undefined) return;

		open.endBit = endBit;
		open.bytes = this.#bytesFrom(Math.floor(open.startBit / 8), Math.ceil(endBit / 8)).slice();

		if (open.kind === 'unknown') {
			const bits = endBit - open.startBit;
			const failure: Failure =
				bits < 48 && this.#final
					? { code: 'UNEXPECTED_EOF', message: 'Compressed input ended unexpectedly', position: endBit }
					: { code: 'INVALID_BLOCK_HEADER', message: 'Invalid bzip2 block marker', position: open.startBit };
			open.result = { state: 'failed', failure };
		}
	}

	/** Detects open segments that can no longer become valid blocks. */
	#checkOpenSegment(open: Segment): void {
		if (open.kind === 'unknown' && this.#scanByte > Math.ceil(open.startBit / 8)) {
			// The byte boundary inside a marker at startBit has been scanned without a match.
			const failure: Failure = {
				code: 'INVALID_BLOCK_HEADER',
				message: 'Invalid bzip2 block marker',
				position: open.startBit
			};
			open.result = { state: 'failed', failure };
			return;
		}

		if (open.kind === 'block' && open.maximumBlockLength !== undefined && open.result.state === 'pending') {
			const bytes = this.#bufferEnd() - Math.floor(open.startBit / 8);
			if (bytes > maximumCompressedBytes(open.maximumBlockLength)) {
				const failure: Failure = {
					code: 'COMPRESSED_BLOCK_TOO_LARGE',
					message: 'Compressed block exceeds the safe format-derived size bound',
					position: open.startBit
				};
				open.result = { state: 'failed', failure };
			}
		}
	}

	/** True when the open segment has grown past any size a real block could have. */
	#openSegmentOverflowed(): boolean {
		const open = this.#openSegment();
		if (open === undefined || this.#segments.length === 1) return false;
		const bound = maximumCompressedBytes(open.maximumBlockLength ?? this.#largestBlockLength());
		return this.#bufferEnd() - Math.floor(open.startBit / 8) > bound;
	}

	#largestBlockLength(): number {
		let largest = 100_000;
		for (const segment of this.#segments) {
			if (segment.maximumBlockLength !== undefined) largest = Math.max(largest, segment.maximumBlockLength);
		}
		return largest;
	}

	// ---------------------------------------------------------------------------------------
	// Worker dispatch
	// ---------------------------------------------------------------------------------------

	#inFlight(): number {
		let count = 0;
		for (const segment of this.#segments) {
			if (segment.result.state === 'running' || segment.result.state === 'done') count++;
		}
		return count;
	}

	#dispatch(): void {
		let inFlight = this.#inFlight();
		for (const segment of this.#segments) {
			// The head is always dispatched so a retried head cannot starve behind completed segments.
			if (inFlight >= this.#inFlightLimit && segment !== this.#segments[0]) return;
			if (
				segment.result.state !== 'pending' ||
				segment.kind !== 'block' ||
				segment.bytes === undefined ||
				segment.maximumBlockLength === undefined
			) {
				continue;
			}
			this.#runSegment(segment);
			inFlight++;
		}
	}

	#runSegment(segment: Segment): void {
		const generation = ++segment.generation;
		const bytes = segment.bytes!;
		segment.result = { state: 'running' };
		segment.bytes = undefined;

		this.#pool
			.run({
				id: this.#nextTaskId++,
				bytes,
				bitOffset: segment.startBit & 7,
				maximumBlockLength: segment.maximumBlockLength!,
				maximumOutputLength: this.#options.maxOutputBytes
			})
			.then(
				outcome => {
					if (segment.generation !== generation || segment.result.state !== 'running') return;
					segment.bytes = outcome.bytes;
					const base = Math.floor(segment.startBit / 8) * 8;

					if (!outcome.ok) {
						const failure: Failure = {
							code: outcome.code,
							message: outcome.message,
							position: base + outcome.position,
							expected: outcome.expected,
							actual: outcome.actual
						};
						segment.result = { state: 'failed', failure };
					} else if (segment.endBit !== undefined && base + outcome.endPosition !== segment.endBit) {
						// At EOF the next marker may be incomplete rather than invalid.
						const truncated = this.#final && segment.endBit - (base + outcome.endPosition) < 48;
						const failure: Failure = {
							code: truncated ? 'UNEXPECTED_EOF' : 'INVALID_BLOCK_HEADER',
							message: truncated ? 'Compressed input ended unexpectedly' : 'Invalid bzip2 block marker',
							position: base + outcome.endPosition
						};
						segment.result = { state: 'failed', failure };
					} else {
						segment.result = { state: 'done', storedCrc: outcome.storedCrc, output: outcome.output };
					}

					this.#run(() => this.#advance());
				},
				error => {
					if (segment.generation !== generation || this.#failure !== undefined) return;
					this.#fail(error instanceof Error ? error : new Error(String(error)));
				}
			);
	}

	// ---------------------------------------------------------------------------------------
	// Stream-order processing
	// ---------------------------------------------------------------------------------------

	/** Runs a step, converting thrown errors into the terminal failure state. */
	#run(step: () => void): void {
		if (this.#failure !== undefined) return;
		try {
			step();
		} catch (error) {
			this.#fail(error instanceof Error ? error : new Error(String(error)));
		}
		this.#notify();
	}

	#fail(error: Error): Error {
		if (this.#failure === undefined) {
			this.#failure = error;
			this.#state = 'failed';
			this.#pool.close();
			this.#onError?.(error);
			this.#notify();
		}
		return this.#failure;
	}

	#notify(): void {
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const resolve of waiters) resolve();
	}

	#progress(): Promise<void> {
		return new Promise(resolve => this.#waiters.push(resolve));
	}

	#advance(): void {
		while (this.#state === 'decoding') {
			const head = this.#segments[0];
			if (head === undefined) return;

			if (head.kind === 'end') {
				if (!this.#processEnd(head)) return;
				continue;
			}

			if (head.result.state === 'done') {
				this.#emit(head.result);
				this.#segments.shift();
				this.#dispatch();
				continue;
			}

			if (head.result.state === 'failed') {
				if (!this.#extendFailedHead(head, head.result.failure)) return;
				continue;
			}

			if (head.kind === 'block' && head.maximumBlockLength === undefined) {
				// Block size is unknown until the preceding member end is confirmed; that cannot
				// happen with this segment at the head, so the header before it was invalid.
				this.#handleTrailingData();
				return;
			}

			return;
		}
	}

	/** Extends a failed head segment over the next one and retries, or reports the failure. */
	#extendFailedHead(head: Segment, failure: Failure): boolean {
		const next = this.#segments[1];

		if (head.kind !== 'block') throw this.#errorFromFailure(failure);

		// A closed segment is always followed by another, so a lone failed head cannot recover.
		if (next === undefined) throw this.#errorFromFailure(failure);

		if (next.result.state === 'running') return false;
		if (next.endBit === undefined) {
			if (!this.#final) return false;
			this.#closeOpenSegment(this.#bufferEnd() * 8);
		}

		const headBytes = head.bytes!;
		const nextBytes = next.bytes!;
		const boundary = Math.floor(next.startBit / 8) - Math.floor(head.startBit / 8);
		const merged = new Uint8Array(boundary + nextBytes.byteLength);
		merged.set(headBytes.subarray(0, boundary));
		merged.set(nextBytes, boundary);

		if (merged.byteLength > maximumCompressedBytes(head.maximumBlockLength!)) {
			throw this.#errorFromFailure(failure);
		}

		head.bytes = merged;
		head.endBit = next.endBit;
		head.result = { state: 'pending' };
		this.#segments.splice(1, 1);

		if (next.kind === 'end') this.#revokeEndMarker(next, head.maximumBlockLength!);

		if (head.endBit !== undefined) this.#dispatch();
		return true;
	}

	/**
	 * An end marker inside a block was spurious: segments up to the next end marker belong to
	 * the current member, and the header the scanner expected after it does not exist.
	 */
	#revokeEndMarker(end: Segment, maximumBlockLength: number): void {
		let reachedAnotherEnd = false;
		for (let index = 1; index < this.#segments.length; index++) {
			const segment = this.#segments[index]!;
			if (segment.kind === 'end') {
				reachedAnotherEnd = true;
				break;
			}
			segment.maximumBlockLength ??= maximumBlockLength;
		}

		if (!reachedAnotherEnd) this.#currentBlockLength ??= maximumBlockLength;
		if (this.#pendingHeaderByte === Math.ceil((end.startBit + END_MARKER_BITS) / 8))
			this.#pendingHeaderByte = undefined;
	}

	#emit(result: Extract<SegmentResult, { state: 'done' }>): void {
		const output = result.output;
		if (this.#outputLength + output.byteLength > this.#options.maxOutputBytes) {
			throw this.#createError('OUTPUT_LIMIT_EXCEEDED', 'Decompressed data exceeds maxOutputBytes');
		}

		this.#combinedCrc = combineCrc(this.#combinedCrc, result.storedCrc);
		this.#blocksInMember++;
		this.#outputLength += output.byteLength;

		const chunkSize = this.#options.outputChunkSize;
		for (let offset = 0; offset < output.byteLength; offset += chunkSize) {
			this.#sink(output.subarray(offset, Math.min(offset + chunkSize, output.byteLength)));
		}
	}

	/** Handles an end-of-stream marker at the head. Returns false while more input is needed. */
	#processEnd(head: Segment): boolean {
		const startByte = Math.floor(head.startBit / 8);
		const view = head.endBit === undefined ? this.#bytesFrom(startByte, this.#bufferEnd()) : head.bytes!;
		const viewEnd = head.endBit ?? this.#bufferEnd() * 8;
		const bitOffset = head.startBit & 7;

		if (viewEnd - head.startBit < END_MARKER_BITS) {
			if (this.#final) throw this.#createError('UNEXPECTED_EOF', 'Compressed input ended unexpectedly');
			return false;
		}

		const storedCombinedCrc = readBits(view, bitOffset + 48, 32);
		if (storedCombinedCrc !== this.#combinedCrc) {
			throw this.#createError(
				'STREAM_CRC_MISMATCH',
				'Combined stream CRC does not match the stored CRC',
				head.startBit + END_MARKER_BITS,
				{ expected: storedCombinedCrc, actual: this.#combinedCrc }
			);
		}

		const paddingBits = (8 - ((bitOffset + END_MARKER_BITS) & 7)) & 7;
		if (paddingBits !== 0 && readBits(view, bitOffset + END_MARKER_BITS, paddingBits) !== 0) {
			throw this.#createError(
				'INVALID_PADDING',
				'Non-zero padding follows the bzip2 member',
				head.startBit + END_MARKER_BITS + paddingBits
			);
		}

		const memberEnd = Math.ceil((head.startBit + END_MARKER_BITS) / 8);
		const availableEnd = head.endBit === undefined ? this.#bufferEnd() : Math.ceil(head.endBit / 8);
		const remaining = availableEnd - memberEnd;

		if (!this.#options.concatenated) {
			this.#segments.shift();
			if (remaining > 0) {
				this.#handleTrailingData();
				return false;
			}
			this.#state = this.#final ? 'finished' : 'after-member';
			return false;
		}

		if (remaining === 0) {
			if (!this.#final) return false;
			this.#segments.shift();
			this.#state = 'finished';
			return false;
		}

		if (remaining < HEADER_BYTES) {
			if (!this.#final) return false;
			this.#segments.shift();
			this.#handleTrailingData();
			return false;
		}

		const header = view.subarray(memberEnd - startByte, memberEnd - startByte + HEADER_BYTES);
		if (!BZIP_HEADER.every((expected, index) => header[index] === expected)) {
			this.#segments.shift();
			this.#handleTrailingData();
			return false;
		}

		const blockSize = header[3]! - 0x30;
		if (blockSize < 1 || blockSize > 9) {
			throw this.#createError('INVALID_BLOCK_SIZE', `Invalid bzip2 block size ${blockSize}`, (memberEnd + 4) * 8);
		}

		// A valid header: the next member must begin with a marker immediately after it.
		const firstMarkerBit = (memberEnd + HEADER_BYTES) * 8;
		if (head.endBit !== firstMarkerBit) {
			const scannedPastMarker = this.#scanByte > memberEnd + HEADER_BYTES;
			if (head.endBit === undefined && !scannedPastMarker) return false;
			if (this.#final && this.#bufferEnd() * 8 - firstMarkerBit < 48) {
				throw this.#createError('UNEXPECTED_EOF', 'Compressed input ended unexpectedly');
			}
			throw this.#createError('INVALID_BLOCK_HEADER', 'Invalid bzip2 block marker', firstMarkerBit);
		}

		this.#segments.shift();
		this.#member++;
		this.#blocksInMember = 0;
		this.#combinedCrc = 0;
		return true;
	}

	#handleTrailingData(): void {
		if (this.#options.trailingData === 'error') {
			throw this.#createError('TRAILING_DATA', 'Unexpected data follows the final bzip2 member');
		}

		this.#state = 'ignoring-trailing';
		this.#scanning = false;
		this.#pendingHeaderByte = undefined;
		for (const segment of this.#segments) segment.generation++;
		this.#segments.length = 0;
		this.#bufferBase = this.#bufferEnd();
		this.#bufferLength = 0;
		this.#pool.close();
	}

	#errorFromFailure(failure: Failure): BzipError {
		return this.#createError(failure.code, failure.message, failure.position, {
			expected: failure.expected,
			actual: failure.actual
		});
	}

	#createError(
		code: BzipErrorCode,
		message: string,
		position?: number,
		details: { expected?: number; actual?: number } = {}
	): BzipError {
		const inMember = this.#state === 'decoding' && this.#member > 0;
		return new BzipError(code, message, {
			byteOffset: position === undefined ? undefined : Math.floor(position / 8),
			bitOffset: position === undefined ? undefined : position & 7,
			member: this.#member || undefined,
			block: inMember ? this.#blocksInMember + 1 : undefined,
			...details
		});
	}
}
