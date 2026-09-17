import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as js from '../src/js.ts';
import * as wasm from '../src/wasm/index.ts';
import { ParallelEncoderEngine } from '../src/parallel/compression-engine.ts';
import { BitWriter } from '../src/internal/bit-writer.ts';
import { encodeBlock } from '../src/codec/encoder.ts';
import type { CompressionTask } from '../src/parallel/compression-protocol.ts';

const hasWorkers = typeof Worker === 'function';
const random = (length: number) => {
	let seed = 42;
	return Uint8Array.from({ length }, () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return seed & 255;
	});
};
const encodeStream = async (api: typeof js, input: Uint8Array, step: number) => {
	let offset = 0;
	const source = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset === input.length) return controller.close();
			controller.enqueue(input.subarray(offset, offset + step));
			offset = Math.min(input.length, offset + step);
		}
	});
	const chunks: Uint8Array[] = [];
	for await (const chunk of source.pipeThrough(
		api.createCompressionStream({ blockSize: 1, concurrency: 2, outputChunkSize: 997 })
	)) {
		assert.ok(chunk.length <= 997);
		chunks.push(chunk);
	}
	return new Uint8Array(Buffer.concat(chunks));
};

for (const [name, api] of [
	['JS', js],
	['WASM', wasm]
] as const) {
	test(
		`${name} worker compression matches synchronous bytes at every block size`,
		{ skip: !hasWorkers, timeout: 60000 },
		async () => {
			const input = random(1_000_003).subarray(3),
				original = input.slice();
			for (const blockSize of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
				const encoded = await api.compressAsync(input, { blockSize, concurrency: 3 });
				assert.deepEqual(encoded, api.compress(input, { blockSize }));
				assert.deepEqual(js.decompress(encoded, { concatenated: false }), input);
			}
			assert.deepEqual(input, original);
		}
	);
	test(
		`${name} worker compression preserves fragmented RLE boundaries and empty members`,
		{ skip: !hasWorkers },
		async () => {
			for (const input of [
				new Uint8Array(),
				random(230000),
				new Uint8Array(5500000).fill(65),
				Uint8Array.from({ length: 310000 }, (_, i) => Math.floor(i / 259) & 255)
			]) {
				for (const step of [997, 65536])
					assert.deepEqual(await encodeStream(api, input, step), api.compress(input, { blockSize: 1 }));
			}
		}
	);
	test(`${name} auto compression resolves worker availability like decompression`, async () => {
		const input = random(120003);
		assert.deepEqual(
			await api.compressAsync(input, { concurrency: 'auto', blockSize: 1 }),
			api.compress(input, { blockSize: 1 })
		);
		for (const concurrency of [0, -1, 1.5, NaN, Infinity])
			assert.throws(() => api.createCompressionStream({ concurrency }), RangeError);
		if (!hasWorkers) assert.throws(() => api.createCompressionStream({ concurrency: 2 }), TypeError);
	});
	test(
		`${name} parallel compression interoperates with native bzip2`,
		{ skip: !hasWorkers || spawnSync('bzip2', ['--help']).status !== 0 },
		async () => {
			const input = random(310000);
			const result = spawnSync('bzip2', ['-dc'], {
				input: await api.compressAsync(input, { concurrency: 2, blockSize: 1 }),
				maxBuffer: 1e6
			});
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr.toString());
			assert.deepEqual(new Uint8Array(result.stdout), input);
		}
	);
}

test('compression bounds outstanding jobs when workers stall and releases them on close', async () => {
	const originalWorker = globalThis.Worker;
	let pushes = 0,
		started = 0,
		terminated = 0;
	class StalledWorker {
		onmessage?: (event: { data: unknown }) => void;
		constructor() {
			started++;
			queueMicrotask(() => this.onmessage?.({ data: 'ready' }));
		}
		postMessage() {}
		terminate() {
			terminated++;
		}
	}
	globalThis.Worker = StalledWorker as unknown as typeof Worker;
	const engine = new ParallelEncoderEngine(
		{ blockSize: 1, outputChunkSize: 65536 },
		2,
		() => {},
		{
			worker: new URL('file:///unused'),
			createCollector: (_size, sink) => ({
				push() {
					pushes++;
					sink({ bytes: Uint8Array.of(1), crc: 0 });
				},
				finish() {}
			})
		},
		() => {}
	);
	try {
		const pending = assert.rejects(engine.push(new Uint8Array(65536 * 20)), /closed/);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(pushes, 4);
		assert.equal(started, 2);
		engine.close();
		await pending;
		assert.equal(terminated, 2);
	} finally {
		engine.close();
		globalThis.Worker = originalWorker;
	}
});

test('out-of-order JS blocks retain bit alignment, order, and member CRC', async () => {
	const originalWorker = globalThis.Worker;
	let first: (() => void) | undefined;
	const completed: number[] = [];
	class ReorderingWorker {
		onmessage?: (event: { data: unknown }) => void;
		constructor() {
			queueMicrotask(() => this.onmessage?.({ data: 'ready' }));
		}
		postMessage(task: CompressionTask) {
			const complete = () => {
				const chunks: Uint8Array[] = [],
					writer = new BitWriter(bytes => chunks.push(bytes));
				encodeBlock(writer, task.bytes, task.crc!);
				const bitLength = writer.bitLength;
				writer.finish();
				completed.push(task.id);
				this.onmessage?.({
					data: {
						id: task.id,
						ok: true,
						bytes: new Uint8Array(Buffer.concat(chunks)),
						bitLength,
						crc: task.crc
					}
				});
			};
			if (task.id === 0) first = complete;
			else
				queueMicrotask(() => {
					complete();
					const callback = first;
					first = undefined;
					callback?.();
				});
		}
		terminate() {}
	}
	globalThis.Worker = ReorderingWorker as unknown as typeof Worker;
	try {
		const input = random(320000);
		assert.deepEqual(
			await js.compressAsync(input, { blockSize: 1, concurrency: 2 }),
			js.compress(input, { blockSize: 1 })
		);
		assert.notEqual(completed[0], 0);
	} finally {
		globalThis.Worker = originalWorker;
	}
});

for (const stage of ['loading', 'postMessage', 'result', 'cancel'] as const) {
	test(`compression worker ${stage} closes the pool and settles pending streams`, async () => {
		const originalWorker = globalThis.Worker;
		const failure = new Error('compression worker failed');
		let report: (() => void) | undefined,
			terminated = 0;
		class FailingWorker {
			onerror?: (event: { error: Error }) => void;
			onmessage?: (event: { data: unknown }) => void;
			constructor() {
				if (stage === 'loading') report = () => this.onerror?.({ error: failure });
				else queueMicrotask(() => this.onmessage?.({ data: 'ready' }));
			}
			postMessage(task: CompressionTask) {
				if (stage === 'postMessage') throw failure;
				if (stage === 'result')
					queueMicrotask(() =>
						this.onmessage?.({ data: { id: task.id, ok: false, message: failure.message } })
					);
			}
			terminate() {
				terminated++;
			}
		}
		globalThis.Worker = FailingWorker as unknown as typeof Worker;
		const stream = js.createCompressionStream({ blockSize: 1, concurrency: 2 });
		const writer = stream.writable.getWriter(),
			reader = stream.readable.getReader();
		try {
			if (stage === 'cancel') {
				const reading = reader.read();
				const writing = writer.write(random(700000)).catch(() => {});
				await new Promise(resolve => setTimeout(resolve, 20));
				await reader.cancel();
				await Promise.all([reading, writing]);
			} else {
				const reading = assert.rejects(reader.read(), /compression worker failed/);
				const closed = assert.rejects(writer.closed, /compression worker failed/);
				await writer.write(random(110000)).catch(() => {});
				if (stage === 'loading') {
					assert.ok(report);
					report();
				}
				await Promise.all([reading, closed]);
			}
			assert.ok(terminated > 0);
		} finally {
			await writer.abort().catch(() => {});
			globalThis.Worker = originalWorker;
		}
	});
}

test('packed block assembly preserves every partial-byte alignment', () => {
	for (let prefix = 0; prefix < 8; prefix++)
		for (let tail = 0; tail < 8; tail++) {
			const actual: Uint8Array[] = [],
				expected: Uint8Array[] = [];
			const a = new BitWriter(chunk => actual.push(chunk), 3),
				b = new BitWriter(chunk => expected.push(chunk), 3);
			a.writeBits(prefix, 0x55);
			b.writeBits(prefix, 0x55);
			const bytes = Uint8Array.of(0xaa, 0x5b, 0x39, 0x7e, 0xd1),
				length = 32 + tail;
			a.writePacked(bytes, length);
			for (let bit = 0; bit < length; bit++) b.writeBit((bytes[bit >>> 3]! >>> (7 - (bit & 7))) & 1);
			assert.equal(a.bitLength, b.bitLength);
			a.writeBits(5, 0x13);
			b.writeBits(5, 0x13);
			a.finish();
			b.finish();
			assert.deepEqual(Buffer.concat(actual), Buffer.concat(expected));
		}
});

test('parallel block collection yields across tiny writes even before a block fills', async () => {
	const originalWorker = globalThis.Worker;
	globalThis.Worker = class {
		constructor() {
			assert.fail('No complete blocks yet');
		}
	} as unknown as typeof Worker;
	let calls = 0,
		observed: number | undefined;
	const engine = new ParallelEncoderEngine(
		{ blockSize: 9, outputChunkSize: 65536 },
		2,
		() => {},
		{
			worker: new URL('file:///unused'),
			createCollector: () => ({
				push() {
					const end = performance.now() + 2;
					while (performance.now() < end) {}
					calls++;
				},
				finish() {}
			})
		},
		() => {}
	);
	const timer = setTimeout(() => {
		observed = calls;
	}, 0);
	try {
		for (let i = 0; i < 20; i++) await engine.push(Uint8Array.of(1));
		assert.ok(observed !== undefined && observed > 0 && observed < 20);
	} finally {
		clearTimeout(timer);
		engine.close();
		globalThis.Worker = originalWorker;
	}
});
