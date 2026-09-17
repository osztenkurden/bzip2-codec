import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockCollector } from '../src/codec/encoder.ts';
import { BzipCrc32 } from '../src/format/crc32.ts';
import { BitWriter } from '../src/internal/bit-writer.ts';
import { compress, decompress } from '../src/js.ts';

test('grouped MTF survives row transitions and repeated area compaction with partial alphabets', () => {
	let seed = 42;
	for (const alphabet of [1, 2, 3, 15, 16, 17, 31, 32, 33, 127, 128, 129, 255, 256]) {
		const input = new Uint8Array(50000);
		for (let i = 0; i < input.length; i++) {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			input[i] = 255 - ((seed >>> 0) % alphabet);
		}
		assert.deepEqual(decompress(compress(input)), input);
	}
});

test('bit writes match individual bits for every width, alignment, and signed CRC', () => {
	for (let alignment = 0; alignment < 8; alignment++) {
		for (let width = 0; width <= 32; width++) {
			for (const value of [0, -1, 0x80000000, 0x12345678, 0xffffffff]) {
				const chunks: Uint8Array[] = [],
					expected: Uint8Array[] = [];
				const a = new BitWriter(c => chunks.push(c), 1);
				const b = new BitWriter(c => expected.push(c), 1);
				a.writeBits(alignment, 0x55);
				b.writeBits(alignment, 0x55);
				a.writeBits(width, value);
				for (let bit = width - 1; bit >= 0; bit--) b.writeBit((value >>> bit) & 1);
				assert.equal(a.bitLength, b.bitLength);
				a.finish();
				b.finish();
				assert.deepEqual(Buffer.concat(chunks), Buffer.concat(expected));
			}
		}
	}
});

test('collector bulk CRC and RLE agree across chunk and full-block boundaries', () => {
	const input = new Uint8Array(310000);
	for (let i = 0; i < input.length; i++) input[i] = i % 251;
	for (const at of [99995, 199990, 299985]) input.fill(255, at, at + 520);
	const collect = (chunkSize: number) => {
		const blocks: { bytes: Uint8Array; crc: number }[] = [];
		const collector = new BlockCollector(1, (bytes, crc) => blocks.push({ bytes: bytes.slice(), crc }));
		for (let offset = 0; offset < input.length; offset += chunkSize)
			collector.push(input.subarray(offset, offset + chunkSize));
		collector.finish();
		return blocks;
	};
	const blocks = collect(input.length);
	for (const size of [1, 3, 4, 259, 65536, 100000]) assert.deepEqual(collect(size), blocks);
	const decoded: number[] = [];
	for (const block of blocks) {
		const start = decoded.length;
		let previous = -1,
			run = 0;
		for (const byte of block.bytes) {
			if (run === 4) {
				for (let i = 0; i < byte; i++) decoded.push(previous);
				previous = -1;
				run = 0;
			} else {
				decoded.push(byte);
				run = byte === previous ? run + 1 : 1;
				previous = byte;
			}
		}
		const crc = new BzipCrc32();
		crc.updateBytes(Uint8Array.from(decoded.slice(start)));
		assert.equal(block.crc, crc.value);
	}
	assert.deepEqual(Uint8Array.from(decoded), input);
});
