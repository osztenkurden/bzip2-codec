import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CancellableTransform } from '../src/internal/cancellable-transform.ts';

let supportsAbortSignal = false;
new WritableStream({
	start(controller) {
		supportsAbortSignal = controller.signal !== undefined;
	}
});

for (const side of ['readable', 'writable'] as const) {
	test(
		`cancellation interrupts a stalled transform from the ${side} side`,
		{
			skip: side === 'writable' && !supportsAbortSignal,
			timeout: 2000
		},
		async () => {
			let release!: () => void;
			let started!: () => void;
			let closed = false;
			const pending = new Promise<void>(resolve => {
				release = resolve;
			});
			const entered = new Promise<void>(resolve => {
				started = resolve;
			});
			const stream = new CancellableTransform<number, number>(
				{
					async transform() {
						started();
						await pending;
						throw new Error('engine closed');
					}
				},
				() => {
					closed = true;
					release();
				}
			);
			assert.ok(stream instanceof TransformStream);
			const writer = stream.writable.getWriter();
			const reader = stream.readable.getReader();
			const reading = reader.read().catch(() => {});
			const writing = writer.write(1).catch(() => {});
			try {
				await entered;
				if (side === 'readable') await reader.cancel();
				else await writer.abort(new Error('stop'));
				await Promise.all([reading, writing]);
				assert.ok(closed);
			} finally {
				release();
			}
		}
	);
}
