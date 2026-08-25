import { BzipError, type BzipErrorCode, isNeedMoreInput } from '../errors.ts';
import {
	BLOCK_MARKER_HIGH,
	BLOCK_MARKER_LOW,
	BZIP_HEADER,
	HUFFMAN_GROUP_SIZE,
	MAX_HUFFMAN_CODE_BITS,
	MAX_HUFFMAN_GROUPS,
	MIN_HUFFMAN_GROUPS,
	RUN_A,
	RUN_B,
	STREAM_END_MARKER_HIGH,
	STREAM_END_MARKER_LOW
} from '../format/constants.ts';
import { BzipCrc32, combineCrc } from '../format/crc32.ts';
import { RANDOM_NUMBERS } from '../format/randomization.ts';
import { BitReader, InputBuffer } from '../internal/input-buffer.ts';
import type { ByteSink } from '../internal/bit-writer.ts';
import type { ResolvedDecompressOptions } from '../types.ts';

interface HuffmanTable {
	readonly minimumLength: number;
	readonly maximumLength: number;
	readonly limits: Uint32Array;
	readonly bases: Uint32Array;
	readonly symbols: Uint16Array;
	readonly symbolCount: number;
}

interface DecodedBlock {
	readonly kind: 'block';
	readonly storedCrc: number;
	readonly outputLength: number;
	emit(sink: ByteSink, chunkSize: number): void;
}

interface EndOfMember {
	readonly kind: 'end';
	readonly storedCombinedCrc: number;
}

type BlockResult = DecodedBlock | EndOfMember;
type DecoderState = 'header' | 'blocks' | 'after-member' | 'ignoring-trailing' | 'finished' | 'failed';

type ErrorFactory = (
	code: BzipErrorCode,
	message: string,
	reader?: BitReader,
	details?: { expected?: number; actual?: number }
) => BzipError;

const moveToFront = (values: Uint8Array, index: number): number => {
	const value = values[index]!;

	for (let position = index; position > 0; position--) {
		values[position] = values[position - 1]!;
	}

	values[0] = value;
	return value;
};

const createHuffmanTable = (lengths: Uint8Array, error: ErrorFactory, reader: BitReader): HuffmanTable => {
	let minimumLength = MAX_HUFFMAN_CODE_BITS;
	let maximumLength = 0;
	const counts = new Uint32Array(MAX_HUFFMAN_CODE_BITS + 1);

	for (const length of lengths) {
		if (length < 1 || length > MAX_HUFFMAN_CODE_BITS) {
			throw error('INVALID_HUFFMAN_TABLE', `Invalid Huffman code length ${length}`, reader);
		}

		minimumLength = Math.min(minimumLength, length);
		maximumLength = Math.max(maximumLength, length);
		counts[length] = counts[length]! + 1;
	}

	let remainingCodes = 1;
	for (let length = 1; length <= maximumLength; length++) {
		remainingCodes = remainingCodes * 2 - counts[length]!;
		if (remainingCodes < 0) {
			throw error('INVALID_HUFFMAN_TABLE', 'Oversubscribed Huffman table', reader);
		}
	}

	const symbols = new Uint16Array(lengths.length);
	let symbolPosition = 0;

	for (let length = minimumLength; length <= maximumLength; length++) {
		for (let symbol = 0; symbol < lengths.length; symbol++) {
			if (lengths[symbol] === length) symbols[symbolPosition++] = symbol;
		}
	}

	const limits = new Uint32Array(MAX_HUFFMAN_CODE_BITS + 1);
	const bases = new Uint32Array(MAX_HUFFMAN_CODE_BITS + 1);
	let code = 0;
	let symbolsBeforeLength = 0;

	for (let length = minimumLength; length <= maximumLength; length++) {
		const count = counts[length]!;
		limits[length] = code + count - 1;
		bases[length] = code - symbolsBeforeLength;
		code = (code + count) * 2;
		symbolsBeforeLength += count;
	}

	return {
		minimumLength,
		maximumLength,
		limits,
		bases,
		symbols,
		symbolCount: lengths.length
	};
};

const readHuffmanSymbol = (reader: BitReader, table: HuffmanTable, error: ErrorFactory): number => {
	let length = table.minimumLength;
	let code = reader.readBits(length);

	while (code > table.limits[length]!) {
		length++;
		if (length > table.maximumLength) {
			throw error('INVALID_HUFFMAN_TABLE', 'Huffman code exceeds the table maximum length', reader);
		}
		code = code * 2 + reader.readBits(1);
	}

	const symbolIndex = code - table.bases[length]!;
	if (symbolIndex < 0 || symbolIndex >= table.symbolCount) {
		throw error('INVALID_HUFFMAN_TABLE', 'Huffman code resolves outside the symbol table', reader);
	}

	return table.symbols[symbolIndex]!;
};

const walkDecodedBlock = (
	block: Uint32Array,
	blockLength: number,
	originalPointer: number,
	randomized: boolean,
	visitRun: (byte: number, count: number) => void
): void => {
	let randomPosition = 0;
	let randomCountdown = 0;
	const derandomize = (byte: number) => {
		if (!randomized) return byte;
		if (randomCountdown === 0) {
			randomCountdown = RANDOM_NUMBERS[randomPosition]!;
			randomPosition = (randomPosition + 1) & 511;
		}
		randomCountdown--;
		return randomCountdown === 1 ? byte ^ 1 : byte;
	};

	let packed = block[originalPointer]!;
	let position = packed >>> 8;
	let current = derandomize(packed & 0xff);
	let runLength = -1;

	for (let remaining = blockLength; remaining > 0; remaining--) {
		const previous = current;
		packed = block[position]!;
		current = derandomize(packed & 0xff);
		position = packed >>> 8;

		let copies: number;
		let outputByte: number;

		if (runLength++ === 3) {
			copies = current;
			outputByte = previous;
			current = -1;
		} else {
			copies = 1;
			outputByte = current;
		}

		visitRun(outputByte, copies);

		if (current !== previous) runLength = 0;
	}
};

const createBlockEmitter = (
	block: Uint32Array,
	blockLength: number,
	originalPointer: number,
	randomized: boolean
): ((sink: ByteSink, chunkSize: number) => void) => {
	return (sink, chunkSize) => {
		let output = new Uint8Array(chunkSize);
		let outputPosition = 0;

		const flush = () => {
			if (outputPosition === 0) return;
			sink(outputPosition === output.length ? output : output.slice(0, outputPosition));
			output = new Uint8Array(chunkSize);
			outputPosition = 0;
		};

		walkDecodedBlock(block, blockLength, originalPointer, randomized, (byte, count) => {
			while (count > 0) {
				const copyLength = Math.min(count, output.length - outputPosition);
				output.fill(byte, outputPosition, outputPosition + copyLength);
				outputPosition += copyLength;
				count -= copyLength;

				if (outputPosition === output.length) flush();
			}
		});

		flush();
	};
};

const decodeNextBlock = (
	reader: BitReader,
	maximumBlockLength: number,
	maximumOutputLength: number,
	error: ErrorFactory
): BlockResult => {
	const [markerHigh, markerLow] = reader.readMarker();

	if (markerHigh === STREAM_END_MARKER_HIGH && markerLow === STREAM_END_MARKER_LOW) {
		return { kind: 'end', storedCombinedCrc: reader.readUint32() };
	}

	if (markerHigh !== BLOCK_MARKER_HIGH || markerLow !== BLOCK_MARKER_LOW) {
		throw error('INVALID_BLOCK_HEADER', 'Invalid bzip2 block marker', reader);
	}

	const storedCrc = reader.readUint32();
	const randomized = reader.readBits(1) !== 0;

	const originalPointer = reader.readBits(24);
	if (originalPointer >= maximumBlockLength) {
		throw error('INVALID_BWT_POINTER', 'BWT origin pointer exceeds the declared block size', reader);
	}

	const symbolMap = new Uint8Array(256);
	let symbolCount = 0;
	const populatedGroups = reader.readBits(16);

	for (let group = 0; group < 16; group++) {
		if ((populatedGroups & (1 << (15 - group))) === 0) continue;

		const populatedSymbols = reader.readBits(16);
		for (let bit = 0; bit < 16; bit++) {
			if ((populatedSymbols & (1 << (15 - bit))) !== 0) {
				symbolMap[symbolCount++] = group * 16 + bit;
			}
		}
	}

	if (symbolCount === 0) {
		throw error('INVALID_BLOCK_HEADER', 'A bzip2 data block must contain at least one symbol', reader);
	}

	const groupCount = reader.readBits(3);
	if (groupCount < MIN_HUFFMAN_GROUPS || groupCount > MAX_HUFFMAN_GROUPS) {
		throw error('INVALID_HUFFMAN_TABLE', `Invalid Huffman group count ${groupCount}`, reader);
	}

	const selectorCount = reader.readBits(15);
	if (selectorCount === 0) {
		throw error('INVALID_HUFFMAN_TABLE', 'A bzip2 block must contain at least one Huffman selector', reader);
	}

	const selectorMtf = new Uint8Array(groupCount);
	for (let group = 0; group < groupCount; group++) selectorMtf[group] = group;

	const selectors = new Uint8Array(selectorCount);
	for (let selector = 0; selector < selectorCount; selector++) {
		let index = 0;
		while (reader.readBits(1) !== 0) {
			index++;
			if (index >= groupCount) {
				throw error('INVALID_HUFFMAN_TABLE', 'Huffman selector exceeds the group count', reader);
			}
		}
		selectors[selector] = moveToFront(selectorMtf, index);
	}

	const alphabetSize = symbolCount + 2;
	const tables: HuffmanTable[] = [];

	for (let group = 0; group < groupCount; group++) {
		const lengths = new Uint8Array(alphabetSize);
		let currentLength = reader.readBits(5);

		for (let symbol = 0; symbol < alphabetSize; symbol++) {
			while (reader.readBits(1) !== 0) {
				currentLength += reader.readBits(1) === 0 ? 1 : -1;
				if (currentLength < 1 || currentLength > MAX_HUFFMAN_CODE_BITS) {
					throw error('INVALID_HUFFMAN_TABLE', `Invalid Huffman code length ${currentLength}`, reader);
				}
			}
			lengths[symbol] = currentLength;
		}

		tables.push(createHuffmanTable(lengths, error, reader));
	}

	const frequencies = new Uint32Array(256);
	const moveToFrontSymbols = new Uint8Array(256);
	for (let symbol = 0; symbol < 256; symbol++) moveToFrontSymbols[symbol] = symbol;

	const block = new Uint32Array(maximumBlockLength);
	let blockLength = 0;
	let selectorIndex = 0;
	let symbolsRemainingForSelector = 0;
	let table: HuffmanTable | undefined;
	let runPower = 0;
	let pendingRun = 0;

	for (;;) {
		if (symbolsRemainingForSelector === 0) {
			if (selectorIndex >= selectors.length) {
				throw error('INVALID_HUFFMAN_TABLE', 'The block exhausted its Huffman selectors', reader);
			}
			table = tables[selectors[selectorIndex++]!];
			symbolsRemainingForSelector = HUFFMAN_GROUP_SIZE;
		}

		symbolsRemainingForSelector--;
		const nextSymbol = readHuffmanSymbol(reader, table!, error);

		if (nextSymbol === RUN_A || nextSymbol === RUN_B) {
			if (runPower === 0) {
				runPower = 1;
				pendingRun = 0;
			}

			pendingRun += nextSymbol === RUN_A ? runPower : runPower * 2;
			if (pendingRun > maximumBlockLength - blockLength) {
				throw error('BLOCK_OVERFLOW', 'Run-length data exceeds the declared block size', reader);
			}
			runPower *= 2;
			continue;
		}

		if (runPower !== 0) {
			const byte = symbolMap[moveToFrontSymbols[0]!]!;
			frequencies[byte] = frequencies[byte]! + pendingRun;
			block.fill(byte, blockLength, blockLength + pendingRun);
			blockLength += pendingRun;
			runPower = 0;
		}

		if (nextSymbol === symbolCount + 1) break;
		if (nextSymbol < 2 || nextSymbol > symbolCount) {
			throw error('INVALID_HUFFMAN_TABLE', 'Decoded an invalid bzip2 symbol', reader);
		}
		if (blockLength >= maximumBlockLength) {
			throw error('BLOCK_OVERFLOW', 'Decoded block exceeds the declared block size', reader);
		}

		const byte = symbolMap[moveToFront(moveToFrontSymbols, nextSymbol - 1)]!;
		frequencies[byte] = frequencies[byte]! + 1;
		block[blockLength++] = byte;
	}

	if (blockLength === 0 || originalPointer >= blockLength) {
		throw error('INVALID_BWT_POINTER', 'BWT origin pointer is outside the decoded block', reader);
	}

	let cumulative = 0;
	for (let byte = 0; byte < frequencies.length; byte++) {
		const count = frequencies[byte]!;
		frequencies[byte] = cumulative;
		cumulative += count;
	}

	for (let index = 0; index < blockLength; index++) {
		const byte = block[index]! & 0xff;
		const sortedPosition = frequencies[byte]!;
		block[sortedPosition] = (block[sortedPosition]! | (index << 8)) >>> 0;
		frequencies[byte] = sortedPosition + 1;
	}

	const crc = new BzipCrc32();
	let outputLength = 0;
	walkDecodedBlock(block, blockLength, originalPointer, randomized, (byte, count) => {
		if (count > maximumOutputLength - outputLength) {
			throw error('OUTPUT_LIMIT_EXCEEDED', 'Decompressed data exceeds maxOutputBytes', reader);
		}
		crc.updateRun(byte, count);
		outputLength += count;
	});

	if (crc.value !== storedCrc) {
		throw error('BLOCK_CRC_MISMATCH', 'Decoded block CRC does not match the stored CRC', reader, {
			expected: storedCrc,
			actual: crc.value
		});
	}

	return {
		kind: 'block',
		storedCrc,
		outputLength,
		emit: createBlockEmitter(block, blockLength, originalPointer, randomized)
	};
};

export class DecoderEngine {
	readonly #options: ResolvedDecompressOptions;
	readonly #input = new InputBuffer();
	#state: DecoderState = 'header';
	#member = 0;
	#block = 0;
	#maximumBlockLength = 0;
	#combinedCrc = 0;
	#outputLength = 0;
	#minimumBytesForBlockRetry = 0;

	constructor(options: ResolvedDecompressOptions) {
		this.#options = options;
	}

	push(chunk: Uint8Array, sink: ByteSink): void {
		if (!(chunk instanceof Uint8Array)) throw new TypeError('Bzip2 input chunks must be Uint8Array values');
		if (this.#state === 'ignoring-trailing') return;
		if (this.#state === 'finished' || this.#state === 'failed') {
			throw this.#createError('INVALID_STATE', 'Cannot write to a decoder after it has finished');
		}

		this.#input.append(chunk);
		this.#process(false, sink);
	}

	finish(sink: ByteSink): void {
		if (this.#state === 'finished') return;
		if (this.#state === 'ignoring-trailing') {
			this.#state = 'finished';
			return;
		}
		if (this.#state === 'failed') {
			throw this.#createError('INVALID_STATE', 'Cannot finish a decoder that has already failed');
		}

		this.#process(true, sink);
		if ((this.#state as DecoderState) === 'ignoring-trailing') {
			this.#state = 'finished';
			return;
		}

		if ((this.#state as DecoderState) !== 'finished') {
			this.#state = 'failed';
			throw this.#createError('UNEXPECTED_EOF', 'Compressed input ended before the bzip2 member was complete');
		}
	}

	#process(final: boolean, sink: ByteSink): void {
		try {
			for (;;) {
				if (this.#state === 'header') {
					if (!this.#readHeader(final)) return;
					continue;
				}

				if (this.#state === 'blocks') {
					if (!final && this.#input.byteLength < this.#minimumBytesForBlockRetry) return;

					const reader = new BitReader(this.#input.view, this.#input.bitOffset);
					let result: BlockResult;

					try {
						result = decodeNextBlock(
							reader,
							this.#maximumBlockLength,
							this.#options.maxOutputBytes - this.#outputLength,
							this.#errorFactory()
						);
					} catch (error) {
						if (!isNeedMoreInput(error)) throw error;
						if (final) {
							throw this.#createError(
								'UNEXPECTED_EOF',
								'Compressed input ended in the middle of a bzip2 block'
							);
						}

						const maximumCompressedBytes = this.#maximumBlockLength * 4 + 64 * 1024;
						if (this.#input.byteLength > maximumCompressedBytes) {
							throw this.#createError(
								'COMPRESSED_BLOCK_TOO_LARGE',
								'Compressed block exceeds the safe format-derived size bound'
							);
						}
						this.#minimumBytesForBlockRetry = Math.min(
							maximumCompressedBytes,
							Math.max(this.#input.byteLength + 1, this.#input.byteLength * 2)
						);
						return;
					}

					this.#minimumBytesForBlockRetry = 0;

					if (result.kind === 'block') {
						if (this.#outputLength + result.outputLength > this.#options.maxOutputBytes) {
							throw this.#createError(
								'OUTPUT_LIMIT_EXCEEDED',
								'Decompressed data exceeds maxOutputBytes'
							);
						}

						this.#input.commit(reader.position);
						this.#combinedCrc = combineCrc(this.#combinedCrc, result.storedCrc);
						this.#block++;
						this.#outputLength += result.outputLength;
						result.emit(sink, this.#options.outputChunkSize);
						continue;
					}

					if (result.storedCombinedCrc !== this.#combinedCrc) {
						throw this.#createError(
							'STREAM_CRC_MISMATCH',
							'Combined stream CRC does not match the stored CRC',
							reader,
							{
								expected: result.storedCombinedCrc,
								actual: this.#combinedCrc
							}
						);
					}

					const padding = reader.alignToByte();
					if (padding !== 0) {
						throw this.#createError('INVALID_PADDING', 'Non-zero padding follows the bzip2 member', reader);
					}

					this.#input.commit(reader.position);
					this.#state = 'after-member';
					continue;
				}

				if (this.#state === 'after-member') {
					if (!this.#options.concatenated) {
						if (this.#input.byteLength > 0) this.#handleTrailingData();
						if (final) this.#state = 'finished';
						else if (this.#options.trailingData === 'ignore') this.#state = 'ignoring-trailing';
						return;
					}

					if (this.#input.byteLength === 0) {
						if (final) this.#state = 'finished';
						return;
					}

					this.#state = 'header';
					continue;
				}

				if (this.#state === 'ignoring-trailing') {
					if (final) this.#state = 'finished';
					return;
				}

				return;
			}
		} catch (error) {
			if (isNeedMoreInput(error)) {
				if (!final) return;
				this.#state = 'failed';
				throw this.#createError('UNEXPECTED_EOF', 'Compressed input ended unexpectedly');
			}

			this.#state = 'failed';
			throw error;
		}
	}

	#readHeader(final: boolean): boolean {
		if (this.#input.bitOffset !== 0) {
			throw this.#createError('INVALID_STATE', 'A bzip2 member header must be byte-aligned');
		}

		if (this.#input.byteLength < 4) {
			if (!final) return false;
			if (this.#member > 0) {
				this.#handleTrailingData();
				return false;
			}
			throw this.#createError('UNEXPECTED_EOF', 'Input ended before the first bzip2 header was complete');
		}

		const reader = new BitReader(this.#input.view);
		const magicMatches = BZIP_HEADER.every(expected => reader.readByte() === expected);

		if (!magicMatches) {
			if (this.#member > 0) {
				this.#handleTrailingData();
				return false;
			}
			throw this.#createError('INVALID_MAGIC', 'Input does not begin with a bzip2 header', reader);
		}

		const blockSize = reader.readByte() - 0x30;
		if (blockSize < 1 || blockSize > 9) {
			throw this.#createError('INVALID_BLOCK_SIZE', `Invalid bzip2 block size ${blockSize}`, reader);
		}

		this.#input.commit(reader.position);
		this.#member++;
		this.#block = 0;
		this.#maximumBlockLength = blockSize * 100_000;
		this.#combinedCrc = 0;
		this.#minimumBytesForBlockRetry = 0;
		this.#state = 'blocks';
		return true;
	}

	#handleTrailingData(): void {
		if (this.#options.trailingData === 'error') {
			throw this.#createError('TRAILING_DATA', 'Unexpected data follows the final bzip2 member');
		}

		this.#input.clear();
		this.#state = 'ignoring-trailing';
	}

	#errorFactory(): ErrorFactory {
		return (code, message, reader, details) => this.#createError(code, message, reader, details);
	}

	#createError(
		code: BzipErrorCode,
		message: string,
		reader?: BitReader,
		details: { expected?: number; actual?: number } = {}
	): BzipError {
		const localPosition = reader ? reader.position - this.#input.bitOffset : 0;
		const absolutePosition = this.#input.totalBitsConsumed + Math.max(0, localPosition);

		return new BzipError(code, message, {
			byteOffset: Math.floor(absolutePosition / 8),
			bitOffset: absolutePosition & 7,
			member: this.#member || undefined,
			block: this.#state === 'blocks' ? this.#block + 1 : undefined,
			...details
		});
	}
}
