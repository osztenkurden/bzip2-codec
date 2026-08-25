import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createDecompressionStream } from '../src/index.ts';

const FIXTURE = 'test_files/003838660961779056911_2094919404.dem.bz2';
const EXPECTED_BYTES = 170_219_877;
const EXPECTED_SHA256 = 'ab35a3acd4e23495bf21ee9bf89b4ba1762f0d5ff190d089b6c2212834d9db17';
const skipReason =
	process.env.BZIP_LARGE_TESTS !== '1'
		? 'Set BZIP_LARGE_TESTS=1 to run the local large-file test'
		: !existsSync(FIXTURE)
			? `Local fixture is missing: ${FIXTURE}`
			: false;

test('streams a large fixture into a constant-memory hash sink', { skip: skipReason }, async () => {
	const hash = createHash('sha256');
	let bytes = 0;
	let largestChunk = 0;
	const source = Readable.toWeb(
		createReadStream(FIXTURE, { highWaterMark: 128 * 1024 })
	) as unknown as ReadableStream<Uint8Array>;

	await source.pipeThrough(createDecompressionStream()).pipeTo(
		new WritableStream<Uint8Array>({
			write(chunk) {
				hash.update(chunk);
				bytes += chunk.byteLength;
				largestChunk = Math.max(largestChunk, chunk.byteLength);
			}
		})
	);

	assert.equal(bytes, EXPECTED_BYTES);
	assert.equal(hash.digest('hex'), EXPECTED_SHA256);
	assert.ok(largestChunk <= 64 * 1024);
});
