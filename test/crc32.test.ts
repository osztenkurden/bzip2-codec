import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BzipCrc32 } from '../src/format/crc32.ts';

// Bzip2 uses the non-reflected polynomial, with initial and final complements.
const referenceCrc = (bytes: Uint8Array): number => {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		for (let bit = 7; bit >= 0; bit--) {
			const feedback = (crc >>> 31) ^ ((byte >>> bit) & 1);
			crc <<= 1;
			if (feedback) crc ^= 0x04c11db7;
		}
	}
	return ~crc >>> 0;
};

const LENGTHS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 255, 256, 257, 259, 260, 261, 4095, 4096, 4097];

test('bulk CRC matches the bitwise bzip2 reference at slicing boundaries and byte offsets', () => {
	const check = new TextEncoder().encode('123456789');
	assert.equal(referenceCrc(check), 0xfc891918);
	const known = new BzipCrc32();
	known.updateBytes(check);
	assert.equal(known.value, 0xfc891918);

	const storage = Uint8Array.from({ length: 4103 }, (_, index) => (index * 73 + (index >>> 3) * 19) & 0xff);
	for (const length of LENGTHS) {
		for (const offset of [0, 1, 2, 3]) {
			const bytes = storage.subarray(offset, offset + length);
			const crc = new BzipCrc32();
			crc.updateBytes(bytes);
			assert.equal(crc.value, referenceCrc(bytes), `length ${length}, offset ${offset}`);
		}
	}
});

test('run CRC matches the bitwise reference at slicing and bzip2 run boundaries', () => {
	for (const byte of [0x00, 0x01, 0x7f, 0x80, 0xa5, 0xff]) {
		for (const length of LENGTHS) {
			const crc = new BzipCrc32();
			crc.updateRun(byte, length);
			assert.equal(crc.value, referenceCrc(new Uint8Array(length).fill(byte)), `byte ${byte}, length ${length}`);
		}
	}
});

test('mixed single-byte, bulk and run CRC updates preserve accumulated state', () => {
	const crc = new BzipCrc32();
	const bytes: number[] = [];
	for (const length of LENGTHS) {
		crc.update(0x80);
		bytes.push(0x80);
		const chunk = Uint8Array.from({ length }, (_, index) => (index * 31 + length) & 0xff);
		crc.updateBytes(chunk);
		bytes.push(...chunk);
		crc.updateRun(0xff, length);
		bytes.push(...new Uint8Array(length).fill(0xff));
		assert.equal(crc.value, referenceCrc(Uint8Array.from(bytes)), `after length ${length}`);
	}
});
