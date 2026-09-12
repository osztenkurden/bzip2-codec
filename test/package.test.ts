import assert from 'node:assert/strict';
import { test } from 'node:test';

const skip = process.env.BZIP_BUILT_TESTS !== '1';

for (const entry of ['bzip2-codec', 'bzip2-codec/wasm']) {
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

	for (const stage of ['constructor', 'loading', 'abort'] as const) {
		test(`${entry} revokes its worker Blob URL on ${stage}`, { skip }, async () => {
			const { createDecompressionStream } = await import(entry);
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
			const stream: TransformStream<Uint8Array, Uint8Array> = createDecompressionStream({ concurrency: 2 });
			const reader = stream.readable.getReader();
			const writer = stream.writable.getWriter();
			try {
				const reading = assert.rejects(reader.read(), error => error === failure);
				const closed = assert.rejects(writer.closed, error => error === failure);
				const input = Buffer.from(
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
