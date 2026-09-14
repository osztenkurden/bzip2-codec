import { BzipError, type BzipErrorCode, isNeedMoreInput, NEED_MORE_INPUT } from '../errors.ts';
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
import { findMarker, MARKER_SCAN_LOOKAHEAD } from '../parallel/marker-scanner.ts';
import type { ResolvedDecompressOptions } from '../types.ts';

interface HuffmanTable {
	readonly fastLookup: Uint16Array;
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
	/** Present when the whole block output fit in the bounded cache. */
	readonly validatedOutput: Uint8Array | undefined;
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

const HUFFMAN_FAST_BITS = 10;
const HUFFMAN_SYMBOL_BITS = 9;
const HUFFMAN_FAST_MASK = (1 << HUFFMAN_FAST_BITS) - 1;
const HUFFMAN_SYMBOL_MASK = (1 << HUFFMAN_SYMBOL_BITS) - 1;
const MAX_CACHED_BLOCK_EXPANSION = 2;
// The inverse move-to-front list is kept as 16 rows of 16 bytes that drift down a 4 KiB area, as in the
// reference decoder: a lookup shifts at most 15 bytes and 15 row bases instead of up to 255 bytes.
const MTF_ROW_WIDTH = 16;
const MTF_ROWS = 256 / MTF_ROW_WIDTH;
const MTF_AREA_SIZE = 4096;

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const moveToFront = (values: Uint8Array, index: number): number => {
	const value = values[index]!;

	if (index > 16) {
		// Native memmove is cheaper than a byte-wise shift for distant symbols.
		values.copyWithin(1, 0, index);
	} else {
		for (let position = index; position > 0; position--) {
			values[position] = values[position - 1]!;
		}
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
	const fastLookup = new Uint16Array(1 << HUFFMAN_FAST_BITS);
	let code = 0;
	let symbolsBeforeLength = 0;

	for (let length = minimumLength; length <= maximumLength; length++) {
		const count = counts[length]!;
		limits[length] = code + count - 1;
		bases[length] = code - symbolsBeforeLength;

		if (length <= HUFFMAN_FAST_BITS) {
			const suffixBits = HUFFMAN_FAST_BITS - length;
			const suffixCount = 1 << suffixBits;
			for (let offset = 0; offset < count; offset++) {
				const start = (code + offset) << suffixBits;
				const entry = (length << HUFFMAN_SYMBOL_BITS) | symbols[symbolsBeforeLength + offset]!;
				fastLookup.fill(entry, start, start + suffixCount);
			}
		}

		code = (code + count) * 2;
		symbolsBeforeLength += count;
	}

	return {
		fastLookup,
		minimumLength,
		maximumLength,
		limits,
		bases,
		symbols,
		symbolCount: lengths.length
	};
};

/**
 * Canonical decoding of a code the fast lookup table does not cover, from the low `bitCount` bits of
 * `bits` (at least 20 of them). Returns the code length in the high bits and the symbol in the low
 * HUFFMAN_SYMBOL_BITS. Kept out of the symbol loop so its rare paths never deoptimize the hot code.
 */
const readLongHuffmanCode = (
	bits: number,
	bitCount: number,
	bitPosition: number,
	totalBits: number,
	table: HuffmanTable,
	error: ErrorFactory,
	reader: BitReader
): number => {
	let length = table.minimumLength;
	if (bitPosition + length > totalBits) throw NEED_MORE_INPUT;
	// Every code up to the fast width is in the lookup table, so a miss is longer than that.
	if (length <= HUFFMAN_FAST_BITS) length = HUFFMAN_FAST_BITS + 1;

	for (;;) {
		if (length > table.maximumLength) {
			reader.position = Math.min(bitPosition + table.maximumLength, totalBits);
			throw error('INVALID_HUFFMAN_TABLE', 'Huffman code exceeds the table maximum length', reader);
		}
		if (bitPosition + length > totalBits) throw NEED_MORE_INPUT;

		const code = (bits >>> (bitCount - length)) & ((1 << length) - 1);
		if (code <= table.limits[length]!) {
			const symbolIndex = code - table.bases[length]!;
			if (symbolIndex < 0 || symbolIndex >= table.symbolCount) {
				reader.position = bitPosition + length;
				throw error('INVALID_HUFFMAN_TABLE', 'Huffman code resolves outside the symbol table', reader);
			}
			return (length << HUFFMAN_SYMBOL_BITS) | table.symbols[symbolIndex]!;
		}
		length++;
	}
};

const resetMoveToFront = (mtfArea: Uint8Array, mtfBase: Int32Array): void => {
	let fill = MTF_AREA_SIZE - 1;
	for (let row = MTF_ROWS - 1; row >= 0; row--) {
		for (let column = MTF_ROW_WIDTH - 1; column >= 0; column--) mtfArea[fill--] = row * MTF_ROW_WIDTH + column;
		mtfBase[row] = fill + 1;
	}
};

/** Inverse move-to-front for an index beyond the first row; the row bases slide down one slot. */
const moveToFrontFar = (mtfArea: Uint8Array, mtfBase: Int32Array, index: number): number => {
	let row = index >>> 4;
	const rowBase = mtfBase[row]!;
	let slot = rowBase + (index & (MTF_ROW_WIDTH - 1));
	const value = mtfArea[slot]!;
	while (slot > rowBase) {
		mtfArea[slot] = mtfArea[slot - 1]!;
		slot--;
	}
	mtfBase[row] = rowBase + 1;
	// Every row below moves down one slot and inherits the last entry of the row above it.
	while (row > 0) {
		const base = mtfBase[row]! - 1;
		mtfBase[row] = base;
		mtfArea[base] = mtfArea[mtfBase[row - 1]! + MTF_ROW_WIDTH - 1]!;
		row--;
	}
	const front = mtfBase[0]! - 1;
	mtfBase[0] = front;
	mtfArea[front] = value;

	if (front === 0) {
		// The rows reached the bottom of the area; pack them back at the top.
		let fill = MTF_AREA_SIZE - 1;
		for (let row = MTF_ROWS - 1; row >= 0; row--) {
			const base = mtfBase[row]!;
			for (let column = MTF_ROW_WIDTH - 1; column >= 0; column--) mtfArea[fill--] = mtfArea[base + column]!;
			mtfBase[row] = fill + 1;
		}
	}
	return value;
};

/**
 * Decodes the Huffman-coded MTF/RLE2 symbols of a block into `block` and returns the block length.
 * This is the decoder's hottest loop, so it keeps its state in locals, reads input through a bit
 * accumulator, and delegates every rare path to a separate function.
 */
const decodeBlockSymbols = (
	reader: BitReader,
	tables: readonly HuffmanTable[],
	selectors: Uint8Array,
	symbolMap: Uint8Array,
	symbolCount: number,
	block: Uint32Array,
	maximumBlockLength: number,
	frequencies: Uint32Array,
	error: ErrorFactory
): number => {
	const mtfArea = new Uint8Array(MTF_AREA_SIZE);
	const mtfBase = new Int32Array(MTF_ROWS);
	resetMoveToFront(mtfArea, mtfBase);

	// The low `bitCount` bits of `bits` are unread input. Refills past the end re-read the last byte,
	// and any symbol that would consume bits beyond the input is rejected before it is used, so
	// truncated input still surfaces as NEED_MORE_INPUT.
	const bytes = reader.bytes;
	const lastByte = bytes.byteLength - 1;
	const totalBits = bytes.byteLength * 8;
	let bytePosition = reader.position >>> 3;
	let bits = 0;
	let bitCount = 0;
	if ((reader.position & 7) !== 0) {
		bits = bytes[bytePosition++]!;
		bitCount = 8 - (reader.position & 7);
	}

	const endOfBlock = symbolCount + 1;
	let blockLength = 0;
	let selectorIndex = 0;
	let symbolsRemainingForSelector = 0;
	let table = tables[0]!;
	let fastLookup = table.fastLookup;
	let runPower = 0;
	let pendingRun = 0;

	for (;;) {
		if (symbolsRemainingForSelector === 0) {
			if (selectorIndex >= selectors.length) {
				reader.position = bytePosition * 8 - bitCount;
				throw error('INVALID_HUFFMAN_TABLE', 'The block exhausted its Huffman selectors', reader);
			}
			table = tables[selectors[selectorIndex++]!]!;
			fastLookup = table.fastLookup;
			symbolsRemainingForSelector = HUFFMAN_GROUP_SIZE;
		}
		symbolsRemainingForSelector--;

		while (bitCount <= 24) {
			bits = (bits << 8) | bytes[Math.min(bytePosition, lastByte)]!;
			bytePosition++;
			bitCount += 8;
		}

		let entry = fastLookup[(bits >>> (bitCount - HUFFMAN_FAST_BITS)) & HUFFMAN_FAST_MASK]!;
		if (entry === 0) {
			entry = readLongHuffmanCode(bits, bitCount, bytePosition * 8 - bitCount, totalBits, table, error, reader);
		}
		const length = entry >>> HUFFMAN_SYMBOL_BITS;
		if (bytePosition * 8 - bitCount + length > totalBits) throw NEED_MORE_INPUT;
		bitCount -= length;
		const nextSymbol = entry & HUFFMAN_SYMBOL_MASK;

		if (nextSymbol <= RUN_B) {
			if (runPower === 0) {
				runPower = 1;
				pendingRun = 0;
			}
			pendingRun += nextSymbol === RUN_A ? runPower : runPower * 2;
			if (pendingRun > maximumBlockLength - blockLength) {
				reader.position = bytePosition * 8 - bitCount;
				throw error('BLOCK_OVERFLOW', 'Run-length data exceeds the declared block size', reader);
			}
			runPower *= 2;
			continue;
		}

		if (runPower !== 0) {
			const byte = symbolMap[mtfArea[mtfBase[0]!]!]!;
			frequencies[byte] = frequencies[byte]! + pendingRun;
			if (pendingRun === 1) block[blockLength] = byte;
			else block.fill(byte, blockLength, blockLength + pendingRun);
			blockLength += pendingRun;
			runPower = 0;
		}

		if (nextSymbol >= endOfBlock) {
			if (nextSymbol === endOfBlock) break;
			reader.position = bytePosition * 8 - bitCount;
			throw error('INVALID_HUFFMAN_TABLE', 'Decoded an invalid bzip2 symbol', reader);
		}
		if (blockLength >= maximumBlockLength) {
			reader.position = bytePosition * 8 - bitCount;
			throw error('BLOCK_OVERFLOW', 'Decoded block exceeds the declared block size', reader);
		}

		// Inverse move-to-front of index nextSymbol - 1, which is at least 1 here.
		let index = nextSymbol - 1;
		let value: number;
		if (index < MTF_ROW_WIDTH) {
			const front = mtfBase[0]!;
			value = mtfArea[front + index]!;
			while (index > 0) {
				mtfArea[front + index] = mtfArea[front + index - 1]!;
				index--;
			}
			mtfArea[front] = value;
		} else {
			value = moveToFrontFar(mtfArea, mtfBase, index);
		}

		const byte = symbolMap[value]!;
		frequencies[byte] = frequencies[byte]! + 1;
		block[blockLength++] = byte;
	}

	reader.position = bytePosition * 8 - bitCount;
	return blockLength;
};

const validateDecodedBlock = (
	block: Uint32Array,
	blockLength: number,
	originalPointer: number,
	randomized: boolean,
	maximumOutputLength: number,
	error: ErrorFactory,
	reader: BitReader
): { readonly crc: number; readonly output?: Uint8Array; readonly outputLength: number } => {
	let randomPosition = 0;
	let randomCountdown = 0;
	let outputLength = 0;
	let output: Uint8Array | undefined = new Uint8Array(
		Math.min(block.length * MAX_CACHED_BLOCK_EXPANSION, maximumOutputLength)
	);
	const crc = new BzipCrc32();
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
	let remaining = blockLength;

	if (!randomized) {
		// Fast path while the cache is guaranteed to hold another byte or a run of up to 255 copies;
		// the general loop below finishes the rare remainder.
		const cache = output;
		const limit = cache.length - 255;
		while (remaining > 0 && outputLength < limit) {
			const previous = current;
			packed = block[position]!;
			current = packed & 0xff;
			position = packed >>> 8;
			remaining--;

			if (runLength++ === 3) {
				// Four equal bytes were emitted; this symbol is the count of further copies.
				if (current !== 0) cache.fill(previous, outputLength, outputLength + current);
				outputLength += current;
				current = -1;
				runLength = 0;
			} else {
				cache[outputLength++] = current;
				if (current !== previous) runLength = 0;
			}
		}
	}

	for (; remaining > 0; remaining--) {
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

		if (copies > maximumOutputLength - outputLength) {
			throw error('OUTPUT_LIMIT_EXCEEDED', 'Decompressed data exceeds maxOutputBytes', reader);
		}
		if (output !== undefined) {
			if (copies <= output.length - outputLength) {
				if (copies === 1) output[outputLength] = outputByte;
				else output.fill(outputByte, outputLength, outputLength + copies);
			} else {
				crc.updateBytes(output.subarray(0, outputLength));
				output = undefined;
			}
		}
		if (output === undefined) crc.updateRun(outputByte, copies);
		outputLength += copies;

		if (current !== previous) runLength = 0;
	}

	if (output !== undefined) crc.updateBytes(output.subarray(0, outputLength));
	return {
		crc: crc.value,
		output: output?.subarray(0, outputLength),
		outputLength
	};
};

const createBlockEmitter = (
	block: Uint32Array,
	blockLength: number,
	originalPointer: number,
	randomized: boolean,
	validatedOutput?: Uint8Array
): ((sink: ByteSink, chunkSize: number) => void) => {
	if (validatedOutput !== undefined) {
		return (sink, chunkSize) => {
			for (let offset = 0; offset < validatedOutput.length; offset += chunkSize) {
				sink(validatedOutput.subarray(offset, Math.min(offset + chunkSize, validatedOutput.length)));
			}
		};
	}

	return (sink, chunkSize) => {
		let output = new Uint8Array(chunkSize);
		let outputPosition = 0;
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

		const flush = () => {
			if (outputPosition === 0) return;
			sink(outputPosition === output.length ? output : output.slice(0, outputPosition));
			output = new Uint8Array(chunkSize);
			outputPosition = 0;
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

			let count: number;
			let outputByte: number;

			if (runLength++ === 3) {
				count = current;
				outputByte = previous;
				current = -1;
			} else {
				count = 1;
				outputByte = current;
			}

			if (count === 1) {
				output[outputPosition++] = outputByte;
				if (outputPosition === output.length) flush();
			} else {
				while (count > 0) {
					const copyLength = Math.min(count, output.length - outputPosition);
					output.fill(outputByte, outputPosition, outputPosition + copyLength);
					outputPosition += copyLength;
					count -= copyLength;

					if (outputPosition === output.length) flush();
				}
			}

			if (current !== previous) runLength = 0;
		}

		flush();
	};
};

export const decodeNextBlock = (
	reader: BitReader,
	maximumBlockLength: number,
	maximumOutputLength: number,
	block: Uint32Array,
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
	const blockLength = decodeBlockSymbols(
		reader,
		tables,
		selectors,
		symbolMap,
		symbolCount,
		block,
		maximumBlockLength,
		frequencies,
		error
	);

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

	const validation = validateDecodedBlock(
		block,
		blockLength,
		originalPointer,
		randomized,
		maximumOutputLength,
		error,
		reader
	);

	if (validation.crc !== storedCrc) {
		throw error('BLOCK_CRC_MISMATCH', 'Decoded block CRC does not match the stored CRC', reader, {
			expected: storedCrc,
			actual: validation.crc
		});
	}

	return {
		kind: 'block',
		storedCrc,
		outputLength: validation.outputLength,
		validatedOutput: validation.output,
		emit: createBlockEmitter(block, blockLength, originalPointer, randomized, validation.output)
	};
};

export interface StandaloneBlock {
	readonly storedCrc: number;
	/** Exact-length view; its underlying buffer is freshly allocated and may be transferred. */
	readonly output: Uint8Array;
	/** Bit position immediately after the block, relative to `bytes`. */
	readonly endPosition: number;
}

/**
 * Decodes one complete bzip2 block whose 48-bit marker begins at `bitOffset` within `bytes`.
 * Used by worker threads that decode blocks independently of the surrounding stream.
 */
export const decodeStandaloneBlock = (
	bytes: Uint8Array,
	bitOffset: number,
	maximumBlockLength: number,
	maximumOutputLength: number,
	workspace: Uint32Array,
	error: ErrorFactory
): StandaloneBlock => {
	const reader = new BitReader(bytes, bitOffset);
	const result = decodeNextBlock(reader, maximumBlockLength, maximumOutputLength, workspace, error);

	if (result.kind !== 'block') {
		throw error('INVALID_BLOCK_HEADER', 'Expected a bzip2 block marker', reader);
	}

	let output: Uint8Array;
	if (result.validatedOutput !== undefined) {
		output = result.validatedOutput;
	} else {
		output = new Uint8Array(result.outputLength);
		let offset = 0;
		result.emit(chunk => {
			output.set(chunk, offset);
			offset += chunk.byteLength;
		}, 1 << 20);
	}

	return { storedCrc: result.storedCrc, output, endPosition: reader.position };
};

export class DecoderEngine {
	readonly #options: ResolvedDecompressOptions;
	readonly #decodeBlock: typeof decodeNextBlock;
	readonly #input = new InputBuffer();
	#state: DecoderState = 'header';
	#member = 0;
	#block = 0;
	#blockBuffer = new Uint32Array(0);
	#maximumBlockLength = 0;
	#combinedCrc = 0;
	#outputLength = 0;
	#minimumBytesForBlockRetry = 0;
	/** True once the marker that ends the current block has been seen in the buffered input. */
	#blockEndSeen = false;
	/** Byte offset within the input view up to which the search for that marker has progressed. */
	#blockEndScanByte = 0;

	constructor(options: ResolvedDecompressOptions, decodeBlock = decodeNextBlock) {
		this.#options = options;
		this.#decodeBlock = decodeBlock;
	}

	push(chunk: Uint8Array, sink: ByteSink): void {
		if (!this.#appendInput(chunk)) return;
		this.#process(false, sink);
	}

	async pushCooperatively(chunk: Uint8Array, sink: ByteSink, yieldAfterMs: number): Promise<void> {
		if (!this.#appendInput(chunk)) return;
		await this.#processCooperatively(false, sink, yieldAfterMs);
	}

	finish(sink: ByteSink): void {
		if (!this.#beginFinish()) return;
		this.#process(true, sink);
		this.#completeFinish();
	}

	async finishCooperatively(sink: ByteSink, yieldAfterMs: number): Promise<void> {
		if (!this.#beginFinish()) return;
		await this.#processCooperatively(true, sink, yieldAfterMs);
		this.#completeFinish();
	}

	#appendInput(chunk: Uint8Array): boolean {
		if (!(chunk instanceof Uint8Array)) throw new TypeError('Bzip2 input chunks must be Uint8Array values');
		if (this.#state === 'ignoring-trailing') return false;
		if (this.#state === 'finished' || this.#state === 'failed') {
			throw this.#createError('INVALID_STATE', 'Cannot write to a decoder after it has finished');
		}

		this.#input.append(chunk);
		return true;
	}

	#beginFinish(): boolean {
		if (this.#state === 'finished') return false;
		if (this.#state === 'ignoring-trailing') {
			this.#state = 'finished';
			return false;
		}
		if (this.#state === 'failed') {
			throw this.#createError('INVALID_STATE', 'Cannot finish a decoder that has already failed');
		}
		return true;
	}

	#completeFinish(): void {
		if ((this.#state as DecoderState) === 'ignoring-trailing') {
			this.#state = 'finished';
			return;
		}

		if ((this.#state as DecoderState) !== 'finished') {
			this.#state = 'failed';
			throw this.#createError('UNEXPECTED_EOF', 'Compressed input ended before the bzip2 member was complete');
		}
	}

	async #processCooperatively(final: boolean, sink: ByteSink, yieldAfterMs: number): Promise<void> {
		for (;;) {
			const deadline = performance.now() + yieldAfterMs;
			if (!this.#process(final, sink, deadline)) return;
			await yieldToEventLoop();
		}
	}

	#process(final: boolean, sink: ByteSink, deadline?: number): boolean {
		try {
			for (;;) {
				if (this.#state === 'header') {
					if (!this.#readHeader(final)) return false;
					continue;
				}

				if (this.#state === 'blocks') {
					if (!final && this.#input.byteLength < this.#minimumBytesForBlockRetry) return false;
					// A block can only be decoded once all of it has arrived, so wait for the marker that
					// follows it instead of decoding speculatively and discarding the partial work.
					if (!final && !this.#blockEndBuffered()) return false;

					const reader = new BitReader(this.#input.view, this.#input.bitOffset);
					let result: BlockResult;

					try {
						result = this.#decodeBlock(
							reader,
							this.#maximumBlockLength,
							this.#options.maxOutputBytes - this.#outputLength,
							this.#blockBuffer,
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
						const retryGrowth =
							this.#input.byteLength < 64 * 1024
								? Math.max(1, this.#input.byteLength)
								: this.#maximumBlockLength;
						this.#minimumBytesForBlockRetry = Math.min(
							maximumCompressedBytes,
							this.#input.byteLength + retryGrowth
						);
						return false;
					}

					this.#minimumBytesForBlockRetry = 0;
					this.#blockEndSeen = false;
					this.#blockEndScanByte = 0;

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
						if (deadline !== undefined && performance.now() >= deadline) return true;
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
						return false;
					}

					if (this.#input.byteLength === 0) {
						if (final) this.#state = 'finished';
						return false;
					}

					this.#state = 'header';
					continue;
				}

				if (this.#state === 'ignoring-trailing') {
					if (final) this.#state = 'finished';
					return false;
				}

				return false;
			}
		} catch (error) {
			if (isNeedMoreInput(error)) {
				if (!final) return false;
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
		if (this.#blockBuffer.length !== this.#maximumBlockLength) {
			this.#blockBuffer = new Uint32Array(this.#maximumBlockLength);
		}
		this.#combinedCrc = 0;
		this.#minimumBytesForBlockRetry = 0;
		this.#blockEndSeen = false;
		this.#blockEndScanByte = 0;
		this.#state = 'blocks';
		return true;
	}

	/**
	 * Reports whether the buffered input reaches the marker that follows the current block. An
	 * end-of-stream marker or an invalid marker at the current position needs no lookahead; the
	 * decoder handles both. Each buffered byte is scanned at most once.
	 */
	#blockEndBuffered(): boolean {
		if (this.#blockEndSeen) return true;

		const view = this.#input.view;
		const startBit = this.#input.bitOffset;
		if (view.byteLength * 8 < startBit + 48) return false;

		const current = findMarker(view, startBit >>> 3, startBit);
		if (current === undefined || current.bit !== startBit || current.kind === 'end') {
			this.#blockEndSeen = true;
			return true;
		}

		const from = Math.max(this.#blockEndScanByte, (startBit + 48) >>> 3);
		if (findMarker(view, from, startBit + 48) === undefined) {
			this.#blockEndScanByte = Math.max(from, view.byteLength - MARKER_SCAN_LOOKAHEAD);
			return false;
		}

		this.#blockEndSeen = true;
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
