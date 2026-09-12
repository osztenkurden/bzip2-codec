import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BzipError, compress, createDecompressionStream, decompress } from '../src/index.ts';
import { ParallelDecoderEngine, type MarkerFinder } from '../src/parallel/engine.ts';
import { findMarker } from '../src/parallel/marker-scanner.ts';
import { resolveDecompressOptions } from '../src/options.ts';
import type { DecompressionStreamOptions } from '../src/types.ts';

// Node.js has no global Worker; these tests run under `bun test` (see `npm run test:parallel`).
const HAS_WORKERS = typeof Worker === 'function';
const parallelTest = (name: string, fn: () => Promise<void> | void) =>
	test(name, { skip: HAS_WORKERS ? false : 'requires the Web Worker API; run with bun test' }, fn);

const SAMPLE = Buffer.from('QlpoOTFBWSZTWeopNX0AAAJTgAAQQAAEACJgDAAgADEGTEEBkeoEPEnfEAvF3JFOFCQ6ik1fQA==', 'base64');
const SAMPLE_TEXT = new TextEncoder().encode('This is a test\n');

const pseudoRandom = (length: number, seed: number): Uint8Array => {
	const output = new Uint8Array(length);
	let state = seed;
	for (let index = 0; index < length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		// Mix runs into the noise so the blocks exercise both RLE stages.
		output[index] = index % 191 < 40 ? (index >>> 6) & 0xff : state & 0xff;
	}
	return output;
};

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
	const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
};

const collect = async (readable: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
	const chunks: Uint8Array[] = [];
	for await (const chunk of readable) chunks.push(chunk);
	return concat(chunks);
};

const decodeStream = async (
	input: Uint8Array,
	options: DecompressionStreamOptions,
	chunkSize = input.byteLength
): Promise<Uint8Array> => {
	const stream = createDecompressionStream(options);
	const output = collect(stream.readable);
	const writer = stream.writable.getWriter();
	const writing = (async () => {
		for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
			await writer.write(input.subarray(offset, Math.min(offset + chunkSize, input.byteLength)));
		}
		await writer.close();
	})();
	// Surface stream errors from either side without leaving the other one dangling.
	const [result] = await Promise.all([output, writing.catch(() => undefined)]);
	return result;
};

const expectBzipError = async (promise: Promise<unknown>, code: string): Promise<BzipError> => {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof BzipError, `expected BzipError, got ${String(error)}`);
		assert.equal(error.code, code);
		return error;
	}
	assert.fail(`expected a BzipError with code ${code}`);
};

const ORIGINAL = pseudoRandom(700_000, 0x2545f491);
const ENCODED = compress(ORIGINAL, { blockSize: 1 });

parallelTest('parallel stream matches the sequential decoder on multi-block input', async () => {
	assert.deepEqual(decompress(ENCODED), ORIGINAL);
	assert.deepEqual(await decodeStream(ENCODED, { concurrency: 4 }), ORIGINAL);
	assert.deepEqual(await decodeStream(ENCODED, { concurrency: 'auto', outputChunkSize: 1000 }), ORIGINAL);
});

parallelTest('parallel stream accepts input fragmented at arbitrary boundaries', async () => {
	assert.deepEqual(await decodeStream(ENCODED, { concurrency: 3 }, 4097), ORIGINAL);
	assert.deepEqual(await decodeStream(ENCODED, { concurrency: 2 }, 13), ORIGINAL);
	assert.deepEqual(await decodeStream(SAMPLE, { concurrency: 2 }, 1), SAMPLE_TEXT);
});

parallelTest('parallel stream decodes concatenated members', async () => {
	const second = pseudoRandom(150_000, 0x9e3779b9);
	const input = concat([ENCODED, compress(second, { blockSize: 2 }), SAMPLE]);
	const expected = concat([ORIGINAL, second, SAMPLE_TEXT]);

	assert.deepEqual(await decodeStream(input, { concurrency: 4 }), expected);
	assert.deepEqual(await decodeStream(input, { concurrency: 4 }, 777), expected);
});

parallelTest('parallel stream honours concatenated: false and trailingData', async () => {
	const input = concat([ENCODED, SAMPLE]);
	await expectBzipError(decodeStream(input, { concurrency: 2, concatenated: false }), 'TRAILING_DATA');
	assert.deepEqual(
		await decodeStream(input, { concurrency: 2, concatenated: false, trailingData: 'ignore' }),
		ORIGINAL
	);

	const garbage = concat([ENCODED, new TextEncoder().encode('not bzip2 data at all')]);
	await expectBzipError(decodeStream(garbage, { concurrency: 2 }), 'TRAILING_DATA');
	await expectBzipError(decodeStream(garbage, { concurrency: 2 }, 5), 'TRAILING_DATA');
	assert.deepEqual(await decodeStream(garbage, { concurrency: 2, trailingData: 'ignore' }), ORIGINAL);
	assert.deepEqual(await decodeStream(garbage, { concurrency: 2, trailingData: 'ignore' }, 5), ORIGINAL);
});

parallelTest('parallel stream enforces maxOutputBytes', async () => {
	await expectBzipError(
		decodeStream(ENCODED, { concurrency: 4, maxOutputBytes: ORIGINAL.byteLength - 1 }),
		'OUTPUT_LIMIT_EXCEEDED'
	);
	assert.deepEqual(await decodeStream(ENCODED, { concurrency: 4, maxOutputBytes: ORIGINAL.byteLength }), ORIGINAL);
});

parallelTest('parallel stream reports truncated input', async () => {
	await expectBzipError(
		decodeStream(ENCODED.subarray(0, ENCODED.byteLength - 20), { concurrency: 2 }),
		'UNEXPECTED_EOF'
	);
	await expectBzipError(decodeStream(ENCODED.subarray(0, 2), { concurrency: 2 }), 'UNEXPECTED_EOF');
	await expectBzipError(decodeStream(ENCODED.subarray(0, 9), { concurrency: 2 }), 'UNEXPECTED_EOF');
});

parallelTest('parallel stream reports the same error codes as the sequential decoder for corrupt input', async () => {
	const offsets = [0, 3, 4, 10, 20, 500, 5000, 20_000, ENCODED.byteLength - 10, ENCODED.byteLength - 3];

	for (const offset of offsets) {
		const corrupt = ENCODED.slice();
		corrupt[offset] = corrupt[offset]! ^ 0x40;

		let sequential: BzipError | undefined;
		try {
			decompress(corrupt);
		} catch (error) {
			assert.ok(error instanceof BzipError);
			sequential = error;
		}
		assert.ok(sequential, `offset ${offset} should corrupt the stream`);

		const parallel = await expectBzipError(decodeStream(corrupt, { concurrency: 3 }), sequential.code);
		assert.equal(parallel.member, sequential.member, `member for offset ${offset}`);
	}
});

test('validates the concurrency option', async () => {
	assert.throws(() => createDecompressionStream({ concurrency: 0 }), RangeError);
	assert.throws(() => createDecompressionStream({ concurrency: 1.5 }), RangeError);
	assert.throws(() => createDecompressionStream({ concurrency: 'many' as never }), RangeError);
	assert.ok(createDecompressionStream({ concurrency: 1 }));

	if (HAS_WORKERS) {
		assert.ok(createDecompressionStream({ concurrency: 2 }));
	} else {
		// Without the Web Worker API an explicit worker count is an error, while 'auto' degrades.
		assert.throws(() => createDecompressionStream({ concurrency: 2 }), TypeError);
		assert.deepEqual(await decodeStream(ENCODED, { concurrency: 'auto' }), ORIGINAL);
	}
});

const decodeWithFinder = async (input: Uint8Array, finder: MarkerFinder, chunkSize: number): Promise<Uint8Array> => {
	const chunks: Uint8Array[] = [];
	const engine = new ParallelDecoderEngine(resolveDecompressOptions({}), 3, chunk => chunks.push(chunk), {
		findMarker: finder
	});
	try {
		for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
			await engine.push(input.subarray(offset, Math.min(offset + chunkSize, input.byteLength)));
		}
		await engine.finish();
	} finally {
		engine.close();
	}
	return concat(chunks);
};

/** Reports the real markers plus one fabricated marker at an absolute bit position. */
const withFakeMarker =
	(fakeBit: number, kind: 'block' | 'end'): MarkerFinder =>
	(bytes, fromByte, minimumBit, absoluteBase) => {
		const real = findMarker(bytes, fromByte, minimumBit);
		const fake = fakeBit - absoluteBase * 8;
		const earliest = Math.max(minimumBit, fromByte * 8 - 7);
		const latest = (bytes.length - 6) * 8;
		if (fake < earliest || fake >= latest) return real;
		if (real !== undefined && real.bit < fake) return real;
		return { bit: fake, kind };
	};

parallelTest('a spurious block marker inside a block is recovered by extending the segment', async () => {
	for (const chunkSize of [ENCODED.byteLength, 1000]) {
		assert.deepEqual(await decodeWithFinder(ENCODED, withFakeMarker(8 * 3000 + 5, 'block'), chunkSize), ORIGINAL);
	}
});

parallelTest('a spurious end marker inside a block is recovered by extending the segment', async () => {
	for (const chunkSize of [ENCODED.byteLength, 1000]) {
		assert.deepEqual(await decodeWithFinder(ENCODED, withFakeMarker(8 * 3000 + 5, 'end'), chunkSize), ORIGINAL);
	}
	const input = concat([ENCODED, SAMPLE]);
	assert.deepEqual(
		await decodeWithFinder(input, withFakeMarker(8 * 3000 + 5, 'end'), 999),
		concat([ORIGINAL, SAMPLE_TEXT])
	);
});

parallelTest('spurious markers in the final block are recovered at end of input', async () => {
	const lastBlockBit = 8 * (ENCODED.byteLength - 40) + 1;
	assert.deepEqual(await decodeWithFinder(ENCODED, withFakeMarker(lastBlockBit, 'block'), 4096), ORIGINAL);
	assert.deepEqual(await decodeWithFinder(ENCODED, withFakeMarker(lastBlockBit, 'end'), 4096), ORIGINAL);
});

test('findMarker locates block and end markers at every bit alignment', () => {
	const block = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59];
	const end = [0x17, 0x72, 0x45, 0x38, 0x50, 0x90];

	for (const [pattern, kind] of [
		[block, 'block'],
		[end, 'end']
	] as const) {
		for (let shift = 0; shift < 8; shift++) {
			const bytes = new Uint8Array(24);
			const bit = 8 * 5 + shift;
			for (let index = 0; index < 48; index++) {
				const value = (pattern[index >>> 3]! >>> (7 - (index & 7))) & 1;
				const target = (bit + index) >>> 3;
				bytes[target] = bytes[target]! | (value << (7 - ((bit + index) & 7)));
			}
			assert.deepEqual(findMarker(bytes, 0, 0), { bit, kind });
			assert.equal(findMarker(bytes, 0, bit + 1), undefined);
		}
	}
});

parallelTest('parallel errors match sequential errors at every truncation of a member', async () => {
	for (const input of [SAMPLE, concat([SAMPLE, SAMPLE])]) {
		for (let length = 0; length < input.byteLength; length++) {
			const truncated = input.subarray(0, length);
			let expected: BzipError | undefined;
			try {
				decompress(truncated);
			} catch (error) {
				assert.ok(error instanceof BzipError);
				expected = error;
			}
			for (const chunkSize of [Math.max(1, length), 1]) {
				if (expected === undefined) {
					assert.deepEqual(
						await decodeStream(truncated, { concurrency: 2 }, chunkSize),
						decompress(truncated)
					);
				} else {
					await expectBzipError(decodeStream(truncated, { concurrency: 2 }, chunkSize), expected.code);
				}
			}
		}
	}
});

parallelTest('parallel fallback output is validated before emission', async () => {
	// Expansion beyond twice the block size bypasses the decoder's bounded output cache.
	const original = new Uint8Array(3_000_000).fill(65);
	const encoded = compress(original, { blockSize: 1 });
	assert.deepEqual(await decodeStream(encoded, { concurrency: 2, outputChunkSize: 997 }), original);
	for (const code of ['BLOCK_CRC_MISMATCH', 'OUTPUT_LIMIT_EXCEEDED'] as const) {
		const corrupt = encoded.slice();
		corrupt[10] = corrupt[10]! ^ 1;
		let emitted = 0;
		const input = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(code === 'BLOCK_CRC_MISMATCH' ? corrupt : encoded);
				controller.close();
			}
		});
		await expectBzipError(
			input
				.pipeThrough(
					createDecompressionStream({
						concurrency: 2,
						maxOutputBytes: code === 'OUTPUT_LIMIT_EXCEEDED' ? original.length - 1 : Infinity
					})
				)
				.pipeTo(
					new WritableStream({
						write(chunk) {
							emitted += chunk.length;
						}
					})
				),
			code
		);
		assert.equal(emitted, 0);
	}
});

test('findMarker recognizes a complete marker at the end of the available bytes', () => {
	for (const [pattern, kind] of [
		[[0x31, 0x41, 0x59, 0x26, 0x53, 0x59], 'block'],
		[[0x17, 0x72, 0x45, 0x38, 0x50, 0x90], 'end']
	] as const) {
		const bytes = Uint8Array.from(pattern);
		assert.deepEqual(findMarker(bytes, 0, 0), { bit: 0, kind });
		assert.equal(findMarker(bytes.subarray(0, 5), 0, 0), undefined);
	}
});
