import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDecompressionStream } from '../src/index.ts';

const SAMPLE = Buffer.from('QlpoOTFBWSZTWeopNX0AAAJTgAAQQAAEACJgDAAgADEGTEEBkeoEPEnfEAvF3JFOFCQ6ik1fQA==', 'base64');

test('a worker failure rejects an idle stream reader and closes the pool', async () => {
	const originalWorker = globalThis.Worker;
	const failure = new Error('Worker module could not load');
	let reportFailure: (() => void) | undefined;
	let terminated = 0;
	class FailingWorker {
		onerror: ((event: { error: Error }) => void) | undefined;
		constructor() {
			reportFailure = () => this.onerror?.({ error: failure });
		}
		terminate() {
			terminated++;
		}
		postMessage() {
			assert.fail('A worker that has not loaded must not receive tasks');
		}
	}
	globalThis.Worker = FailingWorker as unknown as typeof Worker;
	const stream = createDecompressionStream({ concurrency: 2 });
	const writer = stream.writable.getWriter();
	const reader = stream.readable.getReader();
	try {
		const reading = assert.rejects(reader.read(), error => error === failure);
		const closed = assert.rejects(writer.closed, error => error === failure);
		await writer.write(SAMPLE);
		assert.ok(reportFailure);
		reportFailure();
		// The failure must propagate without another input chunk or a call to close().
		await Promise.race([
			Promise.all([reading, closed]),
			new Promise((_, reject) => {
				const timer = setTimeout(() => reject(new Error('Worker failure left the stream pending')), 1000);
				timer.unref();
			})
		]);
		assert.equal(terminated, 1);
	} finally {
		await writer.abort().catch(() => undefined);
		globalThis.Worker = originalWorker;
	}
});
