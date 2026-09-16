import { BitWriter, type ByteSink } from '../internal/bit-writer.ts';
import { INPUT_SLICE_SIZE } from '../internal/async-buffer.ts';
import { BZIP_HEADER, STREAM_END_MARKER_HIGH, STREAM_END_MARKER_LOW } from '../format/constants.ts';
import { combineCrc } from '../format/crc32.ts';
import { WorkerPool, type WorkerDefinition } from './pool.ts';
import type { BlockSize, ResolvedCompressOptions } from '../types.ts';
import type { CompressionTask, CompressionOutcome, CollectedBlock } from './compression-protocol.ts';

interface Collector {
	push(chunk: Uint8Array): void;
	finish(): void;
	close?(): void;
}
export interface CompressionBackend {
	worker: WorkerDefinition;
	createCollector(blockSize: BlockSize, sink: (block: CollectedBlock) => void): Collector;
}
interface Job {
	result?: Extract<CompressionOutcome, { ok: true }>;
}

/** Ordered, single-member assembly with at most twice the worker count outstanding. */
export class ParallelEncoderEngine {
	readonly #pool: WorkerPool<CompressionTask, CompressionOutcome>;
	readonly #collector: Collector;
	readonly #writer: BitWriter;
	readonly #limit: number;
	readonly #options: ResolvedCompressOptions;
	readonly #onError: (error: unknown) => void;
	#jobs: Job[] = [];
	#waiters = new Set<() => void>();
	#id = 0;
	#crc = 0;
	#workMs = 0;
	#closed = false;
	#error: unknown;
	constructor(
		options: ResolvedCompressOptions,
		concurrency: number,
		sink: ByteSink,
		backend: CompressionBackend,
		onError: (error: unknown) => void
	) {
		this.#options = options;
		this.#onError = onError;
		this.#limit = concurrency * 2;
		this.#pool = new WorkerPool(concurrency, backend.worker);
		this.#writer = new BitWriter(sink, options.outputChunkSize);
		for (const byte of BZIP_HEADER) this.#writer.writeByte(byte);
		this.#writer.writeByte(0x30 + options.blockSize);
		this.#collector = backend.createCollector(options.blockSize, block => this.#schedule(block));
	}
	async push(chunk: Uint8Array): Promise<void> {
		try {
			this.#assertOpen();
			if (!(chunk instanceof Uint8Array)) throw new TypeError('Bzip2 input chunks must be Uint8Array values');
			for (let offset = 0; offset < chunk.length; offset += INPUT_SLICE_SIZE) {
				this.#assertOpen();
				const started = performance.now();
				this.#collector.push(chunk.subarray(offset, offset + INPUT_SLICE_SIZE));
				this.#workMs += performance.now() - started;
				while (this.#jobs.length >= this.#limit) {
					await this.#wait();
					this.#assertOpen();
				}
				// Block formation still runs locally; also yield on highly compressible input.
				if (this.#workMs >= 8) {
					this.#workMs = 0;
					await new Promise(resolve => setTimeout(resolve, 0));
					this.#assertOpen();
				}
			}
		} catch (error) {
			this.#fail(error);
			throw error;
		}
	}
	async finish(): Promise<void> {
		try {
			this.#assertOpen();
			this.#collector.finish();
			while (this.#jobs.length) {
				await this.#wait();
				this.#assertOpen();
			}
			this.#writer.writeMarker(STREAM_END_MARKER_HIGH, STREAM_END_MARKER_LOW);
			this.#writer.writeBits(32, this.#crc);
			this.#writer.finish();
		} catch (error) {
			this.#fail(error);
			throw error;
		} finally {
			this.close();
		}
	}
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#pool.close();
		this.#collector.close?.();
		this.#jobs.length = 0;
		this.#wake();
	}
	#assertOpen(): void {
		if (this.#closed) throw this.#error ?? new Error('Compression stream is closed');
	}
	#wait(): Promise<void> {
		return new Promise(resolve => this.#waiters.add(resolve));
	}
	#wake(): void {
		for (const resolve of this.#waiters) resolve();
		this.#waiters.clear();
	}
	#fail(error: unknown): void {
		if (this.#closed) return;
		this.#error = error;
		this.close();
		this.#onError(error);
	}
	#schedule(block: CollectedBlock): void {
		this.#assertOpen();
		const job: Job = {};
		this.#jobs.push(job);
		void this.#pool.run({ ...block, id: this.#id++, blockSize: this.#options.blockSize }).then(
			result => {
				if (this.#closed) return;
				if (!result.ok) {
					this.#fail(new Error(result.message));
					return;
				}
				job.result = result;
				try {
					while (this.#jobs[0]?.result) {
						const head = this.#jobs.shift()!.result!;
						this.#writer.writePacked(head.bytes, head.bitLength);
						this.#writer.flush();
						this.#crc = combineCrc(this.#crc, head.crc);
					}
					this.#wake();
				} catch (error) {
					this.#fail(error);
				}
			},
			error => this.#fail(error)
		);
	}
}
