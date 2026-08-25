import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BzipError, compress, createDecompressionStream, decompress } from '../src/index.ts';

const SAMPLE = Buffer.from('QlpoOTFBWSZTWeopNX0AAAJTgAAQQAAEACJgDAAgADEGTEEBkeoEPEnfEAvF3JFOFCQ6ik1fQA==', 'base64');
const EXPECTED = new TextEncoder().encode('This is a test\n');

const collectStream = async (readable: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
	const chunks: Uint8Array[] = [];
	let length = 0;

	for await (const chunk of readable) {
		chunks.push(chunk);
		length += chunk.byteLength;
	}

	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
};

test('decompresses a known-good bzip2 member', () => {
	assert.deepEqual(decompress(SAMPLE), EXPECTED);
});

test('decompresses input fragmented at every byte boundary', async () => {
	const stream = createDecompressionStream({ outputChunkSize: 3 });
	const writer = stream.writable.getWriter();
	const outputPromise = collectStream(stream.readable);

	for (const byte of SAMPLE) await writer.write(Uint8Array.of(byte));
	await writer.close();

	assert.deepEqual(await outputPromise, EXPECTED);
});

test('only yields while decoding multiple blocks when configured', async () => {
	const input = new Uint8Array(250_000);
	for (let index = 0; index < input.length; index++) input[index] = (index * 31 + (index >>> 8) * 17) & 0xff;
	const encoded = compress(input, { blockSize: 1 });

	const synchronousStream = createDecompressionStream();
	const synchronousWriter = synchronousStream.writable.getWriter();
	const synchronousOutput = collectStream(synchronousStream.readable);
	let synchronousTimerRan = false;
	const synchronousTimer = new Promise<void>(resolve => {
		setTimeout(() => {
			synchronousTimerRan = true;
			resolve();
		}, 0);
	});

	await synchronousWriter.write(encoded);
	assert.equal(synchronousTimerRan, false);
	await synchronousWriter.close();
	await synchronousTimer;
	assert.deepEqual(await synchronousOutput, input);

	const stream = createDecompressionStream({ yieldAfterMs: 0 });
	const writer = stream.writable.getWriter();
	const outputPromise = collectStream(stream.readable);
	let timerRan = false;
	const timer = new Promise<void>(resolve => {
		setTimeout(() => {
			timerRan = true;
			resolve();
		}, 0);
	});

	await writer.write(encoded);
	assert.equal(timerRan, true);
	await writer.close();
	await timer;
	assert.deepEqual(await outputPromise, input);
});

test('rejects corrupt input with a structured error', () => {
	const corrupt = Uint8Array.from(SAMPLE);
	corrupt[0] = corrupt[0]! ^ 0xff;

	assert.throws(
		() => decompress(corrupt),
		(error: unknown) => error instanceof BzipError && error.code === 'INVALID_MAGIC'
	);
});

test('reports a block checksum mismatch without emitting corrupt output', async () => {
	const corrupt = Uint8Array.from(SAMPLE);
	corrupt[10] = corrupt[10]! ^ 1;
	const stream = createDecompressionStream({ yieldAfterMs: 0 });
	const writer = stream.writable.getWriter();
	const outputPromise = collectStream(stream.readable);

	await assert.rejects(
		writer.write(corrupt),
		(error: unknown) => error instanceof BzipError && error.code === 'BLOCK_CRC_MISMATCH'
	);
	await assert.rejects(outputPromise, (error: unknown) => error instanceof BzipError);
});

test('rejects truncated input only when final input is declared', () => {
	assert.throws(
		() => decompress(SAMPLE.subarray(0, SAMPLE.length - 1)),
		(error: unknown) => error instanceof BzipError && error.code === 'UNEXPECTED_EOF'
	);
});

test('reports truncated streamed input when the source closes', async () => {
	const stream = createDecompressionStream({ yieldAfterMs: 0 });
	const writer = stream.writable.getWriter();
	const outputPromise = collectStream(stream.readable);

	await writer.write(SAMPLE.subarray(0, SAMPLE.length - 1));
	await assert.rejects(
		writer.close(),
		(error: unknown) => error instanceof BzipError && error.code === 'UNEXPECTED_EOF'
	);
	await assert.rejects(outputPromise, (error: unknown) => error instanceof BzipError);
});

test('decodes concatenated members by default', () => {
	const concatenated = new Uint8Array(SAMPLE.length * 2);
	concatenated.set(SAMPLE);
	concatenated.set(SAMPLE, SAMPLE.length);

	const expected = new Uint8Array(EXPECTED.length * 2);
	expected.set(EXPECTED);
	expected.set(EXPECTED, EXPECTED.length);

	assert.deepEqual(decompress(concatenated), expected);
	assert.deepEqual(decompress(concatenated, { concatenated: false, trailingData: 'ignore' }), EXPECTED);
});

test('streams concatenated members across arbitrary source chunks', async () => {
	const concatenated = new Uint8Array(SAMPLE.length * 2);
	concatenated.set(SAMPLE);
	concatenated.set(SAMPLE, SAMPLE.length);

	const stream = createDecompressionStream();
	const writer = stream.writable.getWriter();
	const outputPromise = collectStream(stream.readable);
	for (let offset = 0; offset < concatenated.length; offset += 11) {
		await writer.write(concatenated.subarray(offset, Math.min(offset + 11, concatenated.length)));
	}
	await writer.close();

	const expected = new Uint8Array(EXPECTED.length * 2);
	expected.set(EXPECTED);
	expected.set(EXPECTED, EXPECTED.length);
	assert.deepEqual(await outputPromise, expected);
});

test('rejects trailing data by default and can explicitly ignore it', () => {
	const withTrailingData = new Uint8Array(SAMPLE.length + 2);
	withTrailingData.set(SAMPLE);
	withTrailingData.set([1, 2], SAMPLE.length);

	assert.throws(
		() => decompress(withTrailingData),
		(error: unknown) => error instanceof BzipError && error.code === 'TRAILING_DATA'
	);
	assert.deepEqual(decompress(withTrailingData, { trailingData: 'ignore' }), EXPECTED);
});

test('keeps accepting streamed trailing data when configured to ignore it', async () => {
	const stream = createDecompressionStream({ concatenated: false, trailingData: 'ignore' });
	const writer = stream.writable.getWriter();
	const outputPromise = collectStream(stream.readable);

	await writer.write(SAMPLE);
	await writer.write(Uint8Array.of(1));
	await writer.write(Uint8Array.of(2, 3, 4, 5));
	await writer.close();

	assert.deepEqual(await outputPromise, EXPECTED);
});

test('enforces the output limit before emitting an oversized block', async () => {
	assert.deepEqual(decompress(SAMPLE, { maxOutputBytes: EXPECTED.length }), EXPECTED);
	assert.throws(
		() => decompress(SAMPLE, { maxOutputBytes: EXPECTED.length - 1 }),
		(error: unknown) => error instanceof BzipError && error.code === 'OUTPUT_LIMIT_EXCEEDED'
	);

	const stream = createDecompressionStream({ maxOutputBytes: EXPECTED.length - 1 });
	const writer = stream.writable.getWriter();
	const outputPromise = collectStream(stream.readable);
	await assert.rejects(
		writer.write(SAMPLE),
		(error: unknown) => error instanceof BzipError && error.code === 'OUTPUT_LIMIT_EXCEEDED'
	);
	await assert.rejects(outputPromise, (error: unknown) => error instanceof BzipError);
});

test('validates decompression options', () => {
	assert.throws(() => decompress(SAMPLE, { maxOutputBytes: -1 }), RangeError);
	assert.throws(() => decompress(SAMPLE, { outputChunkSize: Number.POSITIVE_INFINITY }), RangeError);
	assert.throws(() => decompress(SAMPLE, { concatenated: 'yes' as never }), TypeError);
	assert.throws(() => decompress(SAMPLE, { trailingData: 'accept' as never }), TypeError);
	assert.throws(() => decompress(SAMPLE, null as never), TypeError);
	assert.throws(() => createDecompressionStream({ yieldAfterMs: -1 }), RangeError);
	assert.throws(() => createDecompressionStream({ yieldAfterMs: Number.POSITIVE_INFINITY }), RangeError);
	assert.throws(() => createDecompressionStream({ yieldAfterMs: Number.NaN }), RangeError);
});
