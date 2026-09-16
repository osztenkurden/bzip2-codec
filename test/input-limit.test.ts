import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DecoderEngine, decodeNextBlock } from '../src/codec/decoder.ts';
import { BzipError, compress, decompress } from '../src/js.ts';
import { resolveDecompressOptions } from '../src/options.ts';
import { decodeNextBlock as decodeWasmBlock } from '../src/wasm/decoder.ts';
import { decompress as decompressWasm } from '../src/wasm/index.ts';

for (const [name, decodeBlock] of [
	['JS', decodeNextBlock],
	['WASM', decodeWasmBlock]
] as const) {
	for (const blockSize of [1, 9] as const) {
		for (const cooperative of [false, true]) {
			test(`${name} bounds markerless input for block size ${blockSize}, cooperative ${cooperative}`, async () => {
				const engine = new DecoderEngine(resolveDecompressOptions({ maxOutputBytes: 1 }), decodeBlock);
				const emit = () => assert.fail('Malformed input must not emit output');
				const push = async (bytes: Uint8Array) => {
					if (cooperative) await engine.pushCooperatively(bytes, emit, 0);
					else engine.push(bytes, emit);
				};
				// A valid member header and opening block marker, followed by markerless garbage.
				await push(Uint8Array.of(0x42, 0x5a, 0x68, 0x30 + blockSize, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59));
				const maximumCompressedBytes = blockSize * 100_000 * 4 + 64 * 1024;
				const zeros = new Uint8Array(64 * 1024);
				// The four-byte member header is consumed; the six-byte block marker is still buffered.
				for (let buffered = 6; buffered < maximumCompressedBytes; buffered += zeros.length) {
					await push(zeros.subarray(0, Math.min(zeros.length, maximumCompressedBytes - buffered)));
				}
				// Reject the first excess byte without waiting for the source to close or another marker.
				await assert.rejects(
					push(Uint8Array.of(0)),
					(error: unknown) => error instanceof BzipError && error.code === 'COMPRESSED_BLOCK_TOO_LARGE'
				);
			});
		}
	}
}

test('a valid multi-block write may exceed the compressed size bound for one block', () => {
	const input = new Uint8Array(600_000);
	let state = 0x12345678;
	for (let index = 0; index < input.length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		input[index] = state & 0xff;
	}
	const encoded = compress(input, { blockSize: 1 });
	assert.ok(encoded.length > 100_000 * 4 + 64 * 1024);
	assert.deepEqual(decompress(encoded), input);
	assert.deepEqual(decompressWasm(encoded), input);
});
