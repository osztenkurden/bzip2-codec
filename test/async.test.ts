import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as js from '../src/js.ts';
import * as wasm from '../src/wasm/index.ts';
import { createCompressionFunctions } from '../src/internal/compression.ts';

const random = (length: number) => {
	let state = 42;
	return Uint8Array.from({ length }, () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state & 255;
	});
};
const collect = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());

for (const [name, api] of [
	['JS', js],
	['WASM', wasm]
] as const) {
	test(`${name} async buffer APIs preserve sync output and option semantics`, async () => {
		for (const input of [new Uint8Array(), random(240007).subarray(7), new Uint8Array(500000).fill(65)]) {
			const encoded = api.compress(input, { blockSize: 1 });
			for (const yieldAfterMs of [undefined, 0, 8]) {
				assert.deepEqual(
					await api.compressAsync(input, { blockSize: 1, outputChunkSize: 997, yieldAfterMs }),
					encoded
				);
				assert.deepEqual(
					await api.decompressAsync(encoded, {
						maxOutputBytes: input.length,
						outputChunkSize: 991,
						yieldAfterMs
					}),
					input
				);
			}
		}
		const input = random(12345),
			encoded = api.compress(input);
		const adjacent = new Uint8Array(Buffer.concat([encoded, encoded]));
		assert.deepEqual(await api.decompressAsync(adjacent), new Uint8Array(Buffer.concat([input, input])));
		assert.deepEqual(await api.decompressAsync(adjacent, { concatenated: false, trailingData: 'ignore' }), input);
		await assert.rejects(
			api.decompressAsync(adjacent, { concatenated: false }),
			e => e instanceof api.BzipError && e.code === 'TRAILING_DATA'
		);
		await assert.rejects(
			api.decompressAsync(encoded, { maxOutputBytes: input.length - 1 }),
			e => e instanceof api.BzipError && e.code === 'OUTPUT_LIMIT_EXCEEDED'
		);
		await assert.rejects(
			api.decompressAsync(encoded.subarray(0, encoded.length - 2)),
			e => e instanceof api.BzipError && e.code === 'UNEXPECTED_EOF'
		);
	});

	test(`${name} cooperative compression yields within a large input chunk`, async () => {
		const input = random(400000);
		for (const yieldAfterMs of [undefined, 0]) {
			let yielded = false;
			const timer = setTimeout(() => {
				yielded = true;
			}, 0);
			try {
				const output = await collect(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(input);
							controller.close();
						}
					}).pipeThrough(api.createCompressionStream({ blockSize: 1, yieldAfterMs }))
				);
				assert.equal(yielded, yieldAfterMs === 0);
				assert.deepEqual(api.decompress(output), input);
			} finally {
				clearTimeout(timer);
			}
		}
	});

	test(`${name} async failures reject promises and preserve permissive inapplicable options`, async () => {
		for (const invoke of [api.compressAsync, api.decompressAsync]) {
			await assert.rejects(invoke('bad input' as never), TypeError);
			await assert.rejects(invoke(new Uint8Array(), null as never), TypeError);
			await assert.rejects(invoke(new Uint8Array(), { outputChunkSize: 0 }), RangeError);
		}
		for (const yieldAfterMs of [-1, NaN, Infinity]) {
			assert.throws(() => api.createCompressionStream({ yieldAfterMs }), RangeError);
			await assert.rejects(api.compressAsync(new Uint8Array(), { yieldAfterMs }), RangeError);
		}
		const input = random(1000);
		await assert.rejects(api.compressAsync(input, { concurrency: 0 }), RangeError);
		// The exclusive union is type-only. Valid runtime properties still follow existing behavior.
		// @ts-expect-error Deliberately exercise JavaScript callers passing both properties.
		assert.deepEqual(await api.compressAsync(input, { yieldAfterMs: 0, concurrency: 1 }), api.compress(input));
	});

	test(`${name} decompressAsync supports worker execution`, { skip: typeof Worker !== 'function' }, async () => {
		const input = random(310000);
		const encoded = api.compress(input, { blockSize: 1 });
		assert.deepEqual(await api.decompressAsync(encoded, { concurrency: 2 }), input);
		await assert.rejects(
			api.decompressAsync(encoded, { concurrency: 2, maxOutputBytes: 1 }),
			e => e instanceof api.BzipError && e.code === 'OUTPUT_LIMIT_EXCEEDED'
		);
	});
}

test('compression work budget accumulates across tiny writes', async () => {
	let pushes = 0,
		observed: number | undefined;
	const api = createCompressionFunctions((_options, sink) => ({
		push() {
			const until = performance.now() + 2;
			while (performance.now() < until) {}
			pushes++;
		},
		finish() {
			sink(Uint8Array.of(pushes));
		}
	}));
	let remaining = 20;
	const timer = setTimeout(() => {
		observed = pushes;
	}, 0);
	try {
		const result = await collect(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					if (!remaining--) return controller.close();
					controller.enqueue(Uint8Array.of(1));
				}
			}).pipeThrough(api.createCompressionStream({ yieldAfterMs: 5 }))
		);
		assert.deepEqual(result, Uint8Array.of(20));
		assert.ok(observed !== undefined && observed > 0 && observed < 20);
	} finally {
		clearTimeout(timer);
	}
});

test('canceling cooperative compression stops further work and closes its engine', async () => {
	let pushes = 0,
		closes = 0;
	const api = createCompressionFunctions((_options, sink) => ({
		push() {
			pushes++;
			sink(Uint8Array.of(1));
		},
		finish() {},
		close() {
			closes++;
		}
	}));
	const stream = api.createCompressionStream({ yieldAfterMs: 0 });
	const reader = stream.readable.getReader(),
		writer = stream.writable.getWriter();
	const reading = reader.read();
	const writing = writer.write(new Uint8Array(1024 * 1024));
	// Attach a rejection handler before canceling.
	const settled = writing.catch(() => {});
	await new Promise(resolve => setTimeout(resolve, 0));
	await reader.cancel();
	await Promise.all([reading, settled]);
	assert.ok(pushes < 16);
	assert.equal(closes, 1);
});
