import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import * as js from '../src/js.ts';
import * as wasm from '../src/wasm/index.ts';
import { WASM_BASE64 } from '../src/wasm/encoder-bytes.ts';
import { WasmEncoderEngine } from '../src/wasm/encoder.ts';

const random = (length: number): Uint8Array => {
	let state = 0x12345678;
	return Uint8Array.from({ length }, () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state & 255;
	});
};
const streamEncode = async (bytes: Uint8Array, step: number, blockSize: js.BlockSize, outputChunkSize: number) => {
	let offset = 0;
	const source = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset === bytes.length) return controller.close();
			controller.enqueue(bytes.subarray(offset, offset + step));
			offset = Math.min(bytes.length, offset + step);
		}
	});
	const chunks: Uint8Array[] = [];
	for await (const chunk of source.pipeThrough(wasm.createCompressionStream({ blockSize, outputChunkSize }))) {
		assert.ok(chunk.length > 0 && chunk.length <= outputChunkSize);
		chunks.push(chunk);
	}
	return new Uint8Array(Buffer.concat(chunks));
};

test('WASM encoder is self-contained and round-trips multiblock input at all block sizes', () => {
	const module = new WebAssembly.Module(Buffer.from(WASM_BASE64, 'base64'));
	assert.deepEqual(WebAssembly.Module.imports(module), []);
	const exports = new WebAssembly.Instance(module).exports;
	assert.equal((exports.memory as WebAssembly.Memory).buffer.byteLength, 8 * 1024 * 1024);
	assert.equal((exports.init as CallableFunction)(900001), -1);
	const input = random(1_000_003).subarray(3);
	for (const blockSize of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
		const encoded = wasm.compress(input, { blockSize });
		assert.equal(encoded[3], 0x30 + blockSize);
		assert.deepEqual(js.decompress(encoded), input);
		assert.deepEqual(wasm.decompress(encoded), input);
	}
});

test('WASM block formation is independent of fragmentation and output chunk size', async () => {
	const inputs = [new Uint8Array(), random(210003), new Uint8Array(600000).fill(65)];
	for (const length of [3, 4, 259, 260, 518, 519]) inputs.push(new Uint8Array(length).fill(42));
	for (const input of inputs) {
		const expected = wasm.compress(input, { blockSize: 1 });
		for (const step of [37, 65536, 100001]) {
			assert.deepEqual(await streamEncode(input, step, 1, 997), expected);
		}
		assert.deepEqual(js.decompress(expected), input);
	}
	assert.deepEqual(await streamEncode(random(100), 1, 1, 1), wasm.compress(random(100), { blockSize: 1 }));
});

test('interleaved WASM streams keep independent state and stable output buffers', async () => {
	const first = random(230000),
		second = new Uint8Array(700000).fill(77);
	const [a, b] = await Promise.all([streamEncode(first, 4093, 1, 101), streamEncode(second, 259, 9, 103)]);
	const saved = a.slice();
	wasm.compress(random(500000), { blockSize: 1 });
	assert.deepEqual(a, saved);
	assert.deepEqual(js.decompress(a), first);
	assert.deepEqual(js.decompress(b), second);
});

test('WASM encoder handles close, finish, and invalid input', async () => {
	const encoder = new WasmEncoderEngine({ blockSize: 1, outputChunkSize: 17 }, () => {});
	encoder.push(Uint8Array.of(1));
	encoder.finish();
	encoder.finish();
	assert.throws(
		() => encoder.push(Uint8Array.of(2)),
		e => e instanceof wasm.BzipError && e.code === 'INVALID_STATE'
	);
	const stream = wasm.createCompressionStream();
	const result = new Response(stream.readable).arrayBuffer();
	const writer = stream.writable.getWriter();
	await Promise.all([assert.rejects(writer.write('invalid' as never), TypeError), assert.rejects(result, TypeError)]);
	const canceled = wasm.createCompressionStream();
	await canceled.readable.cancel();
	await assert.rejects(canceled.writable.getWriter().write(Uint8Array.of(1)));
});

for (const native of ['bzip2', 'lbzip2']) {
	test(
		`WASM compressed output interoperates with ${native}`,
		{ skip: spawnSync(native, ['--help']).status !== 0 },
		() => {
			for (const input of [new Uint8Array(), random(220000), new Uint8Array(1000000).fill(99)]) {
				const result = spawnSync(native, ['-d', '-c'], {
					input: wasm.compress(input, { blockSize: 1 }),
					maxBuffer: 2 * 1024 * 1024
				});
				assert.ifError(result.error);
				assert.equal(result.status, 0, result.stderr.toString());
				assert.deepEqual(new Uint8Array(result.stdout), input);
			}
		}
	);
}
