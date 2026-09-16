import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as js from '../src/js.ts';
import * as wasm from '../src/wasm/index.ts';
import { tryDecodeBlock } from '../src/wasm/block.ts';

const sample = Buffer.from('QlpoOTFBWSZTWeopNX0AAAJTgAAQQAAEACJgDAAgADEGTEEBkeoEPEnfEAvF3JFOFCQ6ik1fQA==', 'base64');
const hash = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const outcome = (decode: typeof js.decompress, bytes: Uint8Array, options?: js.DecompressOptions) => {
	try {
		return { output: hash(decode(bytes, options)) };
	} catch (error) {
		assert.ok(error instanceof js.BzipError);
		return { code: error.code };
	}
};

test('WASM exposes the same API and actually decodes a block', () => {
	assert.deepEqual(Object.keys(wasm).sort(), Object.keys(js).sort());
	assert.equal(wasm.BzipError, js.BzipError);
	assert.equal(wasm.compress, js.compress);
	assert.ok(tryDecodeBlock(sample.subarray(4), 0, 900000, Infinity));
	assert.deepEqual(wasm.decompress(sample), js.decompress(sample));
});

test('WASM synchronous decoding preserves errors, concatenation and output limits', () => {
	for (let end = 0; end < sample.length; end++)
		assert.deepEqual(
			outcome(wasm.decompress, sample.subarray(0, end)),
			outcome(js.decompress, sample.subarray(0, end))
		);
	for (const bytes of [sample, Buffer.concat([sample, sample]), Buffer.concat([sample, Buffer.from('trailing')])]) {
		for (const options of [
			{},
			{ concatenated: false },
			{ trailingData: 'ignore' as const },
			{ maxOutputBytes: 13 },
			{ maxOutputBytes: 14 }
		])
			assert.deepEqual(outcome(wasm.decompress, bytes, options), outcome(js.decompress, bytes, options));
	}
	for (let bit = 32; bit < sample.length * 8; bit++) {
		const bytes = Uint8Array.from(sample);
		bytes[bit >>> 3]! ^= 1 << (bit & 7);
		assert.deepEqual(outcome(wasm.decompress, bytes), outcome(js.decompress, bytes));
	}
});

for (const concurrency of [1, 2]) {
	test(
		`WASM streaming with concurrency ${concurrency} handles fragmented input and expanded output`,
		{ skip: concurrency > 1 && typeof Worker !== 'function' },
		async () => {
			for (const raw of [
				new Uint8Array(2400000).fill(42),
				Uint8Array.from({ length: 320000 }, (_, i) => (i * 31 + (i >>> 8)) & 255)
			]) {
				const encoded = js.compress(raw, { blockSize: 1 });
				let offset = 0;
				const source = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (offset === encoded.length) return controller.close();
						controller.enqueue(encoded.subarray(offset, offset + 997));
						offset = Math.min(offset + 997, encoded.length);
					}
				});
				const output = new Uint8Array(
					await new Response(
						source.pipeThrough(
							wasm.createDecompressionStream({ concurrency, yieldAfterMs: 0, maxOutputBytes: raw.length })
						)
					).arrayBuffer()
				);
				assert.deepEqual(output, raw);
				assert.deepEqual(wasm.decompress(encoded), raw);
			}
		}
	);
	test(
		`WASM concurrency ${concurrency} rejects bad CRC before emitting output`,
		{ skip: concurrency > 1 && typeof Worker !== 'function' },
		async () => {
			const bad = Uint8Array.from(sample);
			bad[10]! ^= 1;
			let emitted = 0;
			await assert.rejects(
				new Blob([bad])
					.stream()
					.pipeThrough(wasm.createDecompressionStream({ concurrency }))
					.pipeTo(
						new WritableStream({
							write(chunk) {
								emitted += chunk.length;
							}
						})
					),
				(e: unknown) => e instanceof js.BzipError && e.code === 'BLOCK_CRC_MISMATCH'
			);
			assert.equal(emitted, 0);
		}
	);
}
