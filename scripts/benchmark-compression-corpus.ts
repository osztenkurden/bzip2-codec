import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type * as Codec from '../src/js.ts';

// Compare revisions with identical generated input. File/module loading and all
// validation are outside timing. Usage: bun scripts/benchmark-compression-corpus.ts
// [path/to/src/js.ts] [report.json] [optional comparison module].
// Each block size gets three warmed trials. Comparison requires identical bytes.
const codec: typeof Codec = await import(pathToFileURL(resolve(process.argv[2] ?? 'src/js.ts')).href);
const comparison: typeof Codec | undefined = process.argv[4]
	? await import(pathToFileURL(resolve(process.argv[4])).href)
	: undefined;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const random = new Uint8Array(1_800_100);
let seed = 0x12345678;
for (let i = 0; i < random.length; i++) {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	random[i] = seed & 255;
}
const sentence = new TextEncoder().encode(
	'The quick brown fox jumps over the lazy dog. Compression preserves every byte.\n'
);
const inputs = {
	small: random.subarray(0, 127),
	random,
	text: Uint8Array.from(random, (_, i) => sentence[i % sentence.length]!),
	repetitive: new Uint8Array(random.length).fill(65),
	periodic: Uint8Array.from(random, (_, i) => i % 251)
};
const results = [];
for (const [name, input] of Object.entries(inputs)) {
	for (let blockSize = 1; blockSize <= 9; blockSize++) {
		const options = { blockSize: blockSize as Codec.BlockSize };
		const warm = codec.compress(input, options);
		const sha256 = hash(warm);
		if (comparison)
			assert.equal(sha256, hash(comparison.compress(input, options)), `${name}, block size ${blockSize}`);
		assert.deepEqual(codec.decompress(warm), input);
		const native = spawnSync('bzip2', ['-dc'], { input: warm, maxBuffer: input.length + 65536 });
		assert.equal(native.status, 0, native.stderr.toString());
		assert.deepEqual(new Uint8Array(native.stdout), input);
		const times = [];
		for (let round = 0; round < 3; round++) {
			const start = performance.now();
			const output = codec.compress(input, options);
			times.push(performance.now() - start);
			assert.deepEqual(output, warm);
		}
		const result = { name, inputBytes: input.length, blockSize, outputBytes: warm.length, sha256, times };
		results.push(result);
		console.log(JSON.stringify(result));
	}
}
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(results, null, 2) + '\n');
