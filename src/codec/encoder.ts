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
import type { BlockSize, ResolvedCompressOptions } from '../types.ts';

export const encodeMoveToFront = (
	lastColumn: Uint8Array,
	used: Uint8Array
): { readonly symbols: Uint16Array; readonly alphabetSize: number } => {
	const alphabetSize = used.reduce((count, value) => count + value, 0);
	const endOfBlock = alphabetSize + 1;
	const encoded = new Uint16Array(lastColumn.length + 1);
	// Logical little-endian words, built with shifts rather than aliased views:
	// host byte order is irrelevant. The first alphabetSize - 1 entries contain
	// every used byte except front; padding is never reached before a real match.
	const order = new Uint32Array(64);
	let front = -1;
	for (let byte = 0, index = 0; byte < 256; byte++) {
		if (used[byte] === 0) continue;
		if (front < 0) front = byte;
		else {
			order[index >>> 2]! |= byte << ((index & 3) * 8);
			index++;
		}
	}

	let outputLength = 0;
	let zeroRunLength = 0;

	for (let offset = 0; offset < lastColumn.length; offset++) {
		const byte = lastColumn[offset]!;
		if (front === byte) {
			zeroRunLength++;
		} else {
			let position = 1;
			if ((order[0]! & 255) === byte) {
				order[0] = (order[0]! & ~255) | front;
			} else {
				const repeated = Math.imul(byte, 0x01010101);
				let carry = front;
				for (let i = 0; ; i++) {
					const word = order[i]!;
					const x = word ^ repeated;
					// A borrow can flag later lanes too, but the lowest flagged lane
					// is always the first actual match. Shift only through that lane.
					const match = (x - 0x01010101) & ~x & 0x80808080;
					const shifted = (word << 8) | carry;
					if (match !== 0) {
						const slot = (31 - Math.clz32(match & -match)) >>> 3;
						const mask = 0xffffffff >>> ((3 - slot) * 8);
						order[i] = (word & ~mask) | (shifted & mask);
						position = i * 4 + slot + 1;
						break;
					}
					order[i] = shifted;
					carry = word >>> 24;
				}
			}
			front = byte;
			while (zeroRunLength > 0) {
				encoded[outputLength++] = (zeroRunLength & 1) !== 0 ? RUN_A : RUN_B;
				zeroRunLength = (zeroRunLength - 1) >>> 1;
			}
			encoded[outputLength++] = position + 1;
		}
	}

	while (zeroRunLength > 0) {
		encoded[outputLength++] = (zeroRunLength & 1) !== 0 ? RUN_A : RUN_B;
		zeroRunLength = (zeroRunLength - 1) >>> 1;
	}
	encoded[outputLength++] = endOfBlock;

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
		// Three 10-bit costs per word: a group's maximum cost is 50 * 20 = 1000.
		const costs012 = new Uint32Array(alphabetSize);
		const costs345 = new Uint32Array(alphabetSize);
		for (let symbol = 0; symbol < alphabetSize; symbol++) {
			costs012[symbol] =
				tables[0]!.lengths[symbol]! |
				(tables[1]!.lengths[symbol]! << 10) |
				((tables[2]?.lengths[symbol] ?? 0) << 20);
			costs345[symbol] =
				(tables[3]?.lengths[symbol] ?? 0) |
				((tables[4]?.lengths[symbol] ?? 0) << 10) |
				((tables[5]?.lengths[symbol] ?? 0) << 20);
		}
		const costs = new Uint16Array(6);

		for (let selector = 0; selector < selectorCount; selector++) {
			const start = selector * HUFFMAN_GROUP_SIZE;
			const end = Math.min(start + HUFFMAN_GROUP_SIZE, symbols.length);
			let c012 = 0,
				c345 = 0;
			for (let index = start; index < end; index++) {
				const symbol = symbols[index]!;
				c012 += costs012[symbol]!;
				c345 += costs345[symbol]!;
			}
			costs[0] = c012 & 1023;
			costs[1] = (c012 >>> 10) & 1023;
			costs[2] = c012 >>> 20;
			costs[3] = c345 & 1023;
			costs[4] = (c345 >>> 10) & 1023;
			costs[5] = c345 >>> 20;
			let bestGroup = 0;
			let bestCost = costs[0]!;

			for (let group = 1; group < groupCount; group++) {
				const cost = costs[group]!;
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

export const encodeBlock = (writer: BitWriter, block: Uint8Array, blockCrc: number): void => {
	const used = new Uint8Array(256);
	for (let index = 0; index < block.length; index++) used[block[index]!] = 1;

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
		const end = Math.min(index + HUFFMAN_GROUP_SIZE, mtf.symbols.length);
		writer.writeHuffmanGroup(mtf.symbols, index, end, table.lengths, table.codes);
		index = end;
	}
};

export class BlockCollector {
	readonly #sink: (block: Uint8Array, crc: number) => void;
	#block: Uint8Array;
	#blockLength = 0;
	#blockCrc = new BzipCrc32();
	#runByte = -1;
	#runLength = 0;
	#finished = false;

	constructor(blockSize: BlockSize, sink: (block: Uint8Array, crc: number) => void) {
		this.#sink = sink;
		this.#block = new Uint8Array(blockSize * 100_000);
	}

	push(chunk: Uint8Array): void {
		if (this.#finished) {
			throw new BzipError('INVALID_STATE', 'Cannot write to a bzip2 encoder after it has finished');
		}
		if (!(chunk instanceof Uint8Array)) throw new TypeError('Bzip2 input chunks must be Uint8Array values');

		const block = this.#block;
		let length = this.#blockLength;
		let runByte = this.#runByte;
		let runLength = this.#runLength;
		let crcStart = 0;
		for (let index = 0; index < chunk.length; index++) {
			const byte = chunk[index]!;
			const required = byte !== runByte || runLength < 3 || runLength === 259 ? 1 : runLength === 3 ? 2 : 0;
			if (block.length - length < required) {
				this.#blockLength = length;
				this.#blockCrc.updateBytes(chunk.subarray(crcStart, index));
				this.#finishBlock();
				crcStart = index;
				length = 0;
				runByte = -1;
				runLength = 0;
			}
			if (byte !== runByte || runLength === 259) {
				runByte = byte;
				runLength = 1;
				block[length++] = byte;
			} else if (++runLength <= 3) {
				block[length++] = byte;
			} else if (runLength === 4) {
				block[length++] = byte;
				block[length++] = 0;
			} else {
				block[length - 1] = runLength - 4;
			}
		}
		this.#blockLength = length;
		this.#runByte = runByte;
		this.#runLength = runLength;
		this.#blockCrc.updateBytes(chunk.subarray(crcStart));
	}

	finish(): void {
		if (this.#finished) return;
		this.#finishBlock();
		this.#finished = true;
	}

	close(): void {
		this.#finished = true;
		this.#block = new Uint8Array(0);
		this.#blockLength = 0;
	}

	#finishBlock(): void {
		if (this.#blockLength === 0) return;

		const crc = this.#blockCrc.value;
		this.#sink(this.#block.subarray(0, this.#blockLength), crc);
		this.#blockLength = 0;
		this.#blockCrc = new BzipCrc32();
		this.#runByte = -1;
		this.#runLength = 0;
	}
}

export class EncoderEngine {
	readonly #writer: BitWriter;
	readonly #collector: BlockCollector;
	#combinedCrc = 0;
	#finished = false;

	constructor(options: ResolvedCompressOptions, sink: ByteSink) {
		this.#writer = new BitWriter(sink, options.outputChunkSize);
		for (const byte of BZIP_HEADER) this.#writer.writeByte(byte);
		this.#writer.writeByte(0x30 + options.blockSize);
		this.#collector = new BlockCollector(options.blockSize, (block, crc) => {
			encodeBlock(this.#writer, block, crc);
			this.#writer.flush();
			this.#combinedCrc = combineCrc(this.#combinedCrc, crc);
		});
	}

	push(chunk: Uint8Array): void {
		this.#collector.push(chunk);
	}

	close(): void {
		this.#finished = true;
		this.#collector.close();
	}

	finish(): void {
		if (this.#finished) return;
		this.#collector.finish();
		this.#writer.writeMarker(STREAM_END_MARKER_HIGH, STREAM_END_MARKER_LOW);
		this.#writer.writeBits(32, this.#combinedCrc);
		this.#writer.finish();
		this.#finished = true;
	}
}
