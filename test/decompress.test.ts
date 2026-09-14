import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BzipError, compress, createDecompressionStream, decompress } from '../src/index.ts';
import { DecoderEngine, decodeNextBlock } from '../src/codec/decoder.ts';
import { resolveDecompressOptions } from '../src/options.ts';
import { findMarker } from '../src/parallel/marker-scanner.ts';

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
	const reader = stream.readable.getReader();
	const isCrcError = (error: unknown) => error instanceof BzipError && error.code === 'BLOCK_CRC_MISMATCH';
	await Promise.all([assert.rejects(reader.read(), isCrcError), assert.rejects(writer.write(corrupt), isCrcError)]);
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

// Block size 1 caches up to 200,000 expanded bytes. These mixed runs fit in one
// encoded block and exercise both crossing the cache in a run and continuing after it.
for (const length of [199_999, 200_000, 200_001, 200_517]) {
	test(`validates cached/fallback output of ${length} bytes before emission`, async () => {
		const input = Uint8Array.from({ length }, (_, index) => (Math.floor(index / 251) * 73) & 0xff);
		const encoded = compress(input, { blockSize: 1 });
		assert.deepEqual(decompress(encoded), input);
		assert.throws(
			() => decompress(encoded, { maxOutputBytes: length - 1 }),
			(error: unknown) => error instanceof BzipError && error.code === 'OUTPUT_LIMIT_EXCEEDED'
		);

		for (const yieldAfterMs of [undefined, 0]) {
			const stream = createDecompressionStream({ maxOutputBytes: length, outputChunkSize: 997, yieldAfterMs });
			const writer = stream.writable.getWriter();
			const outputPromise = collectStream(stream.readable);
			await writer.write(encoded);
			await writer.close();
			assert.deepEqual(await outputPromise, input);

			const corrupt = Uint8Array.from(encoded);
			corrupt[10] = corrupt[10]! ^ 1;
			for (const code of ['BLOCK_CRC_MISMATCH', 'OUTPUT_LIMIT_EXCEEDED'] as const) {
				const failingStream = createDecompressionStream({
					maxOutputBytes: code === 'OUTPUT_LIMIT_EXCEEDED' ? length - 1 : length,
					outputChunkSize: 997,
					yieldAfterMs
				});
				const failingWriter = failingStream.writable.getWriter();
				const reader = failingStream.readable.getReader();
				const isExpectedError = (error: unknown) => error instanceof BzipError && error.code === code;
				await Promise.all([
					assert.rejects(reader.read(), isExpectedError),
					assert.rejects(
						failingWriter.write(code === 'BLOCK_CRC_MISMATCH' ? corrupt : encoded),
						isExpectedError
					)
				]);
			}
		}
	});
}

test('streaming decodes each block once, after its end marker has arrived', () => {
	const input = new Uint8Array(400_000);
	for (let index = 0; index < input.length; index++) input[index] = (index * 31 + (index >>> 8) * 17) & 0xff;
	const encoded = compress(input, { blockSize: 1 });

	let blocks = 0;
	for (let marker = findMarker(encoded, 4, 32); marker !== undefined;) {
		if (marker.kind === 'block') blocks++;
		marker = findMarker(encoded, Math.ceil(marker.bit / 8) + 1, marker.bit + 48);
	}
	assert.ok(blocks > 3, 'the input should span several blocks');

	let attempts = 0;
	const engine = new DecoderEngine(resolveDecompressOptions({}), (...args) => {
		attempts++;
		return decodeNextBlock(...args);
	});
	const chunks: Uint8Array[] = [];
	const emit = (chunk: Uint8Array) => chunks.push(chunk);
	for (let offset = 0; offset < encoded.length; offset += 4096) {
		engine.push(encoded.subarray(offset, Math.min(offset + 4096, encoded.length)), emit);
	}
	engine.finish(emit);

	const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	assert.deepEqual(output, input);
	// One attempt per block plus the end-of-stream marker, which may need a retry for its CRC bits.
	assert.ok(
		attempts >= blocks + 1 && attempts <= blocks + 2,
		`decoder was invoked ${attempts} times for ${blocks} blocks`
	);
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
