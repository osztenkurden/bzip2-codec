import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compress, createCompressionStream, createDecompressionStream, decompress } from '../src/index.ts';

const collectStream = async (readable: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
	const chunks: Uint8Array[] = [];
	let length = 0;

	for await (const chunk of readable) {
		chunks.push(chunk);
		length += chunk.length;
	}

	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
};

const makeInput = (): Uint8Array => {
	const input = new Uint8Array(120_000);
	for (let index = 0; index < input.length; index++) input[index] = (index * 31 + (index >>> 8) * 17) & 0xff;
	return input;
};

test('round-trips empty and small inputs', () => {
	for (const value of ['', 'a', 'This is a test\n', 'banana banana banana', 'x'.repeat(300)]) {
		const input = new TextEncoder().encode(value);
		assert.deepEqual(decompress(compress(input, { blockSize: 1 })), input);
	}
});

test('writes the requested block-size marker', () => {
	const input = new TextEncoder().encode('block size');

	for (const blockSize of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
		const encoded = compress(input, { blockSize });
		assert.equal(new TextDecoder().decode(encoded.subarray(0, 4)), `BZh${blockSize}`);
		assert.deepEqual(decompress(encoded), input);
	}
});

test('round-trips a multi-block input', () => {
	const input = makeInput();
	assert.deepEqual(decompress(compress(input, { blockSize: 1 })), input);
});

test('streaming compression is independent of input chunk boundaries', async () => {
	const input = makeInput().subarray(0, 20_000);
	const stream = createCompressionStream({ blockSize: 1, outputChunkSize: 17 });
	const writer = stream.writable.getWriter();
	const outputPromise = collectStream(stream.readable);

	for (let offset = 0; offset < input.length; offset += 37) {
		await writer.write(input.subarray(offset, Math.min(offset + 37, input.length)));
	}
	await writer.close();

	assert.deepEqual(decompress(await outputPromise), input);
});

test('composes compression and decompression as a streaming pipeline', async () => {
	const input = makeInput().subarray(0, 30_000);
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let offset = 0; offset < input.length; offset += 113) {
				controller.enqueue(input.subarray(offset, Math.min(offset + 113, input.length)));
			}
			controller.close();
		}
	});

	const output = source
		.pipeThrough(createCompressionStream({ blockSize: 1, outputChunkSize: 29 }))
		.pipeThrough(createDecompressionStream({ outputChunkSize: 31 }));

	assert.deepEqual(await collectStream(output), input);
});

test('handles first-stage run-length boundaries', () => {
	for (const length of [3, 4, 5, 255, 256, 257, 259, 260, 261, 518, 519]) {
		const input = new Uint8Array(length).fill(0xa5);
		assert.deepEqual(decompress(compress(input, { blockSize: 1 })), input, `run length ${length}`);
	}
});

test('round-trips run-length expansion larger than the decoder block cache', () => {
	const input = new Uint8Array(250_000).fill(0xa5);
	assert.deepEqual(decompress(compress(input, { blockSize: 1 })), input);
});

test('validates compression options', () => {
	const input = new Uint8Array();
	assert.throws(() => compress(input, { blockSize: 0 as never }), RangeError);
	assert.throws(() => compress(input, { blockSize: 10 as never }), RangeError);
	assert.throws(() => compress(input, { blockSize: 1.5 as never }), RangeError);
	assert.throws(() => compress(input, { outputChunkSize: 0 }), RangeError);
	assert.throws(() => compress(input, null as never), TypeError);
});
