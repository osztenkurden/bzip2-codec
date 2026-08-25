import {
	BLOCK_MARKER_HIGH,
	BLOCK_MARKER_LOW,
	BZIP_HEADER,
	HUFFMAN_GROUP_SIZE,
	MAX_HUFFMAN_GROUPS,
	RUN_A,
	RUN_B,
	STREAM_END_MARKER_HIGH,
	STREAM_END_MARKER_LOW
} from '../format/constants.ts';
import { BzipError } from '../errors.ts';
import { burrowsWheelerTransform } from '../format/block-sort.ts';
import { BzipCrc32, combineCrc } from '../format/crc32.ts';
import { createHuffmanEncodingTable, type HuffmanEncodingTable } from '../format/huffman-encoder.ts';
import { BitWriter, type ByteSink } from '../internal/bit-writer.ts';
import type { ResolvedCompressOptions } from '../types.ts';

const encodeMoveToFront = (
	lastColumn: Uint8Array,
	used: Uint8Array
): { readonly symbols: Uint16Array; readonly alphabetSize: number } => {
	const alphabetSize = used.reduce((count, value) => count + value, 0);
	const endOfBlock = alphabetSize + 1;
	const encoded = new Uint16Array(lastColumn.length + 1);
	const order = new Uint8Array(alphabetSize);
	const positions = new Uint8Array(256);

	for (let byte = 0, index = 0; byte < 256; byte++) {
		if (used[byte] === 0) continue;
		order[index] = byte;
		positions[byte] = index++;
	}

	let outputLength = 0;
	let zeroRunLength = 0;

	const emit = (symbol: number) => {
		encoded[outputLength++] = symbol;
	};

	const emitZeroRun = () => {
		while (zeroRunLength > 0) {
			if ((zeroRunLength & 1) !== 0) {
				emit(RUN_A);
				zeroRunLength--;
			} else {
				emit(RUN_B);
				zeroRunLength -= 2;
			}
			zeroRunLength >>>= 1;
		}
	};

	for (const byte of lastColumn) {
		const position = positions[byte]!;

		for (let index = position; index > 0; index--) {
			const moved = order[index - 1]!;
			order[index] = moved;
			positions[moved] = index;
		}
		order[0] = byte;
		positions[byte] = 0;

		if (position === 0) {
			zeroRunLength++;
		} else {
			emitZeroRun();
			emit(position + 1);
		}
	}

	emitZeroRun();
	emit(endOfBlock);

	return { symbols: encoded.subarray(0, outputLength), alphabetSize };
};

const emitSymbolMap = (writer: BitWriter, used: Uint8Array): void => {
	for (let group = 0; group < 16; group++) {
		let populated = false;
		for (let bit = 0; bit < 16; bit++) populated ||= used[group * 16 + bit] !== 0;
		writer.writeBit(populated);
	}

	for (let group = 0; group < 16; group++) {
		let populated = false;
		for (let bit = 0; bit < 16; bit++) populated ||= used[group * 16 + bit] !== 0;
		if (!populated) continue;

		for (let bit = 0; bit < 16; bit++) writer.writeBit(used[group * 16 + bit] !== 0);
	}
};

const emitHuffmanTable = (writer: BitWriter, table: HuffmanEncodingTable): void => {
	let currentLength = table.lengths[0]!;
	writer.writeBits(5, currentLength);

	for (const length of table.lengths) {
		while (currentLength < length) {
			writer.writeBits(2, 2);
			currentLength++;
		}
		while (currentLength > length) {
			writer.writeBits(2, 3);
			currentLength--;
		}
		writer.writeBit(0);
	}
};

const chooseGroupCount = (symbolCount: number): number => {
	if (symbolCount >= 2400) return MAX_HUFFMAN_GROUPS;
	if (symbolCount >= 1200) return 5;
	if (symbolCount >= 600) return 4;
	if (symbolCount >= 200) return 3;
	return 2;
};

const tableCost = (table: HuffmanEncodingTable, symbols: Uint16Array, start: number, end: number): number => {
	let cost = 0;
	for (let index = start; index < end; index++) cost += table.lengths[symbols[index]!]!;
	return cost;
};

const optimizeHuffmanTables = (
	symbols: Uint16Array,
	alphabetSize: number
): { readonly tables: HuffmanEncodingTable[]; readonly selectors: Uint8Array } => {
	const groupCount = chooseGroupCount(symbols.length);
	const selectorCount = Math.ceil(symbols.length / HUFFMAN_GROUP_SIZE);
	const selectors = new Uint8Array(selectorCount);
	let tables: HuffmanEncodingTable[] = [];

	for (let group = 0; group < groupCount; group++) {
		const frequencies = new Uint32Array(alphabetSize);
		frequencies.fill(1);
		const start = Math.floor((symbols.length * group) / groupCount);
		const end = Math.floor((symbols.length * (group + 1)) / groupCount);
		for (let index = start; index < end; index++) {
			const symbol = symbols[index]!;
			frequencies[symbol] = frequencies[symbol]! + 1;
		}
		tables.push(createHuffmanEncodingTable(frequencies));
	}

	for (let iteration = 0; iteration < 4; iteration++) {
		const groupFrequencies = Array.from({ length: groupCount }, () => new Uint32Array(alphabetSize));

		for (let selector = 0; selector < selectorCount; selector++) {
			const start = selector * HUFFMAN_GROUP_SIZE;
			const end = Math.min(start + HUFFMAN_GROUP_SIZE, symbols.length);
			let bestGroup = 0;
			let bestCost = tableCost(tables[0]!, symbols, start, end);

			for (let group = 1; group < groupCount; group++) {
				const cost = tableCost(tables[group]!, symbols, start, end);
				if (cost < bestCost) {
					bestGroup = group;
					bestCost = cost;
				}
			}

			selectors[selector] = bestGroup;
			const frequencies = groupFrequencies[bestGroup]!;
			for (let index = start; index < end; index++) {
				const symbol = symbols[index]!;
				frequencies[symbol] = frequencies[symbol]! + 1;
			}
		}

		tables = groupFrequencies.map(createHuffmanEncodingTable);
	}

	return { tables, selectors };
};

const emitSelectors = (writer: BitWriter, selectors: Uint8Array, groupCount: number): void => {
	const order = new Uint8Array(groupCount);
	for (let group = 0; group < groupCount; group++) order[group] = group;

	for (const selector of selectors) {
		let position = 0;
		while (order[position] !== selector) position++;
		for (let bit = 0; bit < position; bit++) writer.writeBit(1);
		writer.writeBit(0);

		const selected = order[position]!;
		for (let index = position; index > 0; index--) order[index] = order[index - 1]!;
		order[0] = selected;
	}
};

const encodeBlock = (writer: BitWriter, block: Uint8Array, blockCrc: number): void => {
	const used = new Uint8Array(256);
	for (const byte of block) used[byte] = 1;

	const { lastColumn, originalPointer } = burrowsWheelerTransform(block);
	const mtf = encodeMoveToFront(lastColumn, used);
	const optimized = optimizeHuffmanTables(mtf.symbols, mtf.alphabetSize + 2);

	writer.writeMarker(BLOCK_MARKER_HIGH, BLOCK_MARKER_LOW);
	writer.writeBits(32, blockCrc);
	writer.writeBit(0);
	writer.writeBits(24, originalPointer);
	emitSymbolMap(writer, used);
	writer.writeBits(3, optimized.tables.length);
	writer.writeBits(15, optimized.selectors.length);
	emitSelectors(writer, optimized.selectors, optimized.tables.length);
	for (const table of optimized.tables) emitHuffmanTable(writer, table);

	for (let selector = 0, index = 0; selector < optimized.selectors.length; selector++) {
		const table = optimized.tables[optimized.selectors[selector]!]!;
		for (let groupIndex = 0; groupIndex < HUFFMAN_GROUP_SIZE && index < mtf.symbols.length; groupIndex++) {
			const symbol = mtf.symbols[index++]!;
			writer.writeBits(table.lengths[symbol]!, table.codes[symbol]!);
		}
	}
};

export class EncoderEngine {
	readonly #options: ResolvedCompressOptions;
	readonly #writer: BitWriter;
	readonly #block: Uint8Array;
	#blockLength = 0;
	#blockCrc = new BzipCrc32();
	#combinedCrc = 0;
	#runByte = -1;
	#runLength = 0;
	#finished = false;

	constructor(options: ResolvedCompressOptions, sink: ByteSink) {
		this.#options = options;
		this.#writer = new BitWriter(sink, options.outputChunkSize);
		this.#block = new Uint8Array(options.blockSize * 100_000);

		for (const byte of BZIP_HEADER) this.#writer.writeByte(byte);
		this.#writer.writeByte(0x30 + options.blockSize);
	}

	push(chunk: Uint8Array): void {
		if (this.#finished) {
			throw new BzipError('INVALID_STATE', 'Cannot write to a bzip2 encoder after it has finished');
		}
		if (!(chunk instanceof Uint8Array)) throw new TypeError('Bzip2 input chunks must be Uint8Array values');

		for (const byte of chunk) {
			const required = this.#requiredEncodedBytes(byte);
			if (this.#block.length - this.#blockLength < required) this.#finishBlock();
			this.#appendByte(byte);
		}
	}

	finish(): void {
		if (this.#finished) return;
		this.#finishBlock();
		this.#writer.writeMarker(STREAM_END_MARKER_HIGH, STREAM_END_MARKER_LOW);
		this.#writer.writeBits(32, this.#combinedCrc);
		this.#writer.finish();
		this.#finished = true;
	}

	#requiredEncodedBytes(byte: number): number {
		if (byte !== this.#runByte) return 1;
		if (this.#runLength < 3 || this.#runLength === 259) return 1;
		if (this.#runLength === 3) return 2;
		return 0;
	}

	#appendByte(byte: number): void {
		this.#blockCrc.update(byte);

		if (byte !== this.#runByte) {
			this.#runByte = byte;
			this.#runLength = 1;
			this.#block[this.#blockLength++] = byte;
			return;
		}

		this.#runLength++;

		if (this.#runLength <= 3) {
			this.#block[this.#blockLength++] = byte;
			return;
		}

		if (this.#runLength === 4) {
			this.#block[this.#blockLength++] = byte;
			this.#block[this.#blockLength++] = 0;
			return;
		}

		if (this.#runLength <= 259) {
			this.#block[this.#blockLength - 1] = this.#runLength - 4;
			return;
		}

		this.#runLength = 1;
		this.#block[this.#blockLength++] = byte;
	}

	#finishBlock(): void {
		if (this.#blockLength === 0) return;

		const crc = this.#blockCrc.value;
		encodeBlock(this.#writer, this.#block.subarray(0, this.#blockLength), crc);
		this.#writer.flush();
		this.#combinedCrc = combineCrc(this.#combinedCrc, crc);
		this.#blockLength = 0;
		this.#blockCrc = new BzipCrc32();
		this.#runByte = -1;
		this.#runLength = 0;
	}
}
