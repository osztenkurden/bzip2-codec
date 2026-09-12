import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { BzipError, compress, createDecompressionStream } from '../src/index.ts';

const skip = process.env.BZIP_LARGE_TESTS !== '1' || typeof Worker !== 'function';

test('parallel offsets remain valid beyond 512 MiB of compressed input', { skip, timeout: 120_000 }, async () => {
	const original = new Uint8Array(800_000);
	let state = 0x2545f491;
	for (let index = 0; index < original.length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		original[index] = state & 0xff;
	}
	const encoded = compress(original);
	const members = Math.ceil((512 * 1024 * 1024) / encoded.length) + 2;
	const expected = createHash('sha256');
	for (let member = 0; member < members; member++) expected.update(original);
	const corrupt = encoded.slice();
	corrupt[10] = corrupt[10]! ^ 1;
	let member = 0;
	let bytes = 0;
	const actual = createHash('sha256');
	const source = new ReadableStream<Uint8Array>({
		pull(controller) {
			// Reuse one member to cross the boundary without holding the file in memory.
			if (member++ < members) controller.enqueue(encoded);
			else {
				controller.enqueue(corrupt);
				controller.close();
			}
		}
	});
	await assert.rejects(
		source.pipeThrough(createDecompressionStream({ concurrency: 4 })).pipeTo(
			new WritableStream({
				write(chunk) {
					actual.update(chunk);
					bytes += chunk.length;
				}
			})
		),
		(error: unknown) =>
			error instanceof BzipError &&
			error.code === 'BLOCK_CRC_MISMATCH' &&
			error.member === members + 1 &&
			error.byteOffset !== undefined &&
			error.byteOffset > 512 * 1024 * 1024
	);
	assert.equal(bytes, members * original.length);
	assert.equal(actual.digest('hex'), expected.digest('hex'));
});
