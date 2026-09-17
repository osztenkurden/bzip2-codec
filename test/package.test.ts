import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const skip = process.env.BZIP_BUILT_TESTS !== '1';

test('package entries default to WASM and share the public API', { skip }, async () => {
	const main = await import('bzip2-codec');
	const wasm = await import('bzip2-codec/wasm');
	const js = await import('bzip2-codec/js');
	assert.deepEqual(Object.keys(main).sort(), Object.keys(js).sort());
	assert.deepEqual(main, wasm);
	assert.notEqual(main.decompress, js.decompress);
	assert.notEqual(main.createDecompressionStream, js.createDecompressionStream);
	assert.notEqual(main.compress, js.compress);
	assert.notEqual(main.createCompressionStream, js.createCompressionStream);
	assert.equal(main.BzipError, js.BzipError);
	const result = spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'--eval',
			`
		globalThis.WebAssembly = undefined;
		const { compress, decompress, compressAsync, decompressAsync } = await import('bzip2-codec/js');
		const input = new TextEncoder().encode('JS without WebAssembly');
		const { default: assert } = await import('node:assert/strict');
		assert.deepEqual(decompress(compress(input)), input);
		assert.deepEqual(await decompressAsync(await compressAsync(input, { yieldAfterMs: 0 })), input);
	`
		],
		{ encoding: 'utf8' }
	);
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
});

for (const entry of ['bzip2-codec', 'bzip2-codec/js', 'bzip2-codec/wasm']) {
	test(`${entry} exposes asynchronous buffer helpers`, { skip }, async () => {
		const api = await import(entry);
		const input = Uint8Array.from({ length: 210000 }, (_, index) => (index * 31 + (index >>> 8)) & 255);
		const encoded = await api.compressAsync(input, { blockSize: 1, yieldAfterMs: 0 });
		assert.deepEqual(encoded, api.compress(input, { blockSize: 1 }));
		assert.deepEqual(await api.decompressAsync(encoded, { yieldAfterMs: 0 }), input);
		if (typeof Worker === 'function') {
			assert.deepEqual(await api.decompressAsync(encoded, { concurrency: 2 }), input);
			assert.deepEqual(await api.compressAsync(input, { concurrency: 2, blockSize: 1 }), encoded);
		}
	});

	test(`${entry} loads its worker and decodes a member`, { skip }, async () => {
		const { createDecompressionStream } = await import(entry);
		const encoded = Buffer.from(
			'QlpoOTFBWSZTWeopNX0AAAJTgAAQQAAEACJgDAAgADEGTEEBkeoEPEnfEAvF3JFOFCQ6ik1fQA==',
			'base64'
		);
		const source = new ReadableStream({
			start(controller) {
				controller.enqueue(encoded);
				controller.close();
			}
		});
		const output = await new Response(source.pipeThrough(createDecompressionStream({ concurrency: 2 }))).text();
		assert.equal(output, 'This is a test\n');
	});

	for (const direction of ['compress', 'decompress'] as const)
		for (const stage of ['constructor', 'loading', 'abort'] as const) {
			test(`${entry} ${direction} revokes its worker Blob URL on ${stage}`, { skip }, async () => {
				const api = await import(entry);
				const originalWorker = globalThis.Worker;
				const originalCreate = URL.createObjectURL;
				const originalRevoke = URL.revokeObjectURL;
				const created: string[] = [];
				const revoked: string[] = [];
				const failure = new Error(`Worker ${stage} failure`);
				let reportFailure: (() => void) | undefined;
				let terminated = 0;
				class TestWorker {
					onerror: ((event: { error: Error }) => void) | undefined;
					constructor(url: string | URL) {
						assert.equal(typeof url, 'string');
						assert.ok(String(url).startsWith('blob:'));
						if (stage === 'constructor') throw failure;
						reportFailure = () => this.onerror?.({ error: failure });
					}
					postMessage() {
						assert.fail('A worker that has not loaded must not receive tasks');
					}
					terminate() {
						terminated++;
					}
				}
				URL.createObjectURL = blob => {
					const url = originalCreate(blob);
					created.push(url);
					return url;
				};
				URL.revokeObjectURL = url => {
					revoked.push(url);
					originalRevoke(url);
				};
				globalThis.Worker = TestWorker as unknown as typeof Worker;
				const stream: TransformStream<Uint8Array, Uint8Array> =
					direction === 'compress'
						? api.createCompressionStream({ concurrency: 2, blockSize: 1 })
						: api.createDecompressionStream({ concurrency: 2 });
				const reader = stream.readable.getReader();
				const writer = stream.writable.getWriter();
				try {
					const reading = assert.rejects(reader.read(), error => error === failure);
					const closed = assert.rejects(writer.closed, error => error === failure);
					const input =
						direction === 'compress'
							? Uint8Array.from({ length: 110000 }, (_, i) => i & 255)
							: Buffer.from(
									'QlpoOTFBWSZTWeopNX0AAAJTgAAQQAAEACJgDAAgADEGTEEBkeoEPEnfEAvF3JFOFCQ6ik1fQA==',
									'base64'
								);
					await writer.write(input).catch(error => {
						assert.equal(error, failure);
					});
					if (stage === 'loading') {
						assert.ok(reportFailure);
						reportFailure();
					}
					if (stage === 'abort') await writer.abort(failure);
					await Promise.all([reading, closed]);
					assert.equal(created.length, 1);
					assert.deepEqual(revoked, created);
					assert.equal(terminated, stage === 'constructor' ? 0 : 1);
				} finally {
					await writer.abort(failure).catch(() => undefined);
					globalThis.Worker = originalWorker;
					URL.createObjectURL = originalCreate;
					URL.revokeObjectURL = originalRevoke;
				}
			});
		}
}
