import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('compression trials validate raw input, including empty input, across encoders', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'bzip-compress-trial-'));
	try {
		for (const bytes of [Buffer.alloc(0), Buffer.from('compression benchmark\n'.repeat(1000))]) {
			const inputPath = join(directory, 'input');
			await writeFile(inputPath, bytes);
			for (const mode of ['js', 'bzip2', 'lbzip2']) {
				if (mode !== 'js' && spawnSync(mode, ['--help']).status !== 0) continue;
				const child = spawnSync(process.execPath, [resolve('scripts/benchmark/trial.ts')], {
					input: JSON.stringify({
						inputPath,
						bundle: resolve('src/js.ts'),
						mode,
						operation: 'compress',
						blockSize: 1,
						concurrency: 1,
						timeoutMs: 10000
					}),
					encoding: 'utf8',
					timeout: 15000
				});
				assert.ifError(child.error);
				assert.equal(child.status, 0, child.stderr);
				const result = JSON.parse(child.stdout);
				assert.equal(result.inputBytes, bytes.length);
				assert.equal(result.decodedBytes, bytes.length);
				assert.equal(result.decodedSha256, createHash('sha256').update(bytes).digest('hex'));
				assert.ok(result.outputBytes > 0);
				assert.ok(result.durationMs > 0);
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('compression trial refuses a valid archive containing the wrong bytes', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'bzip-compress-invalid-'));
	try {
		const inputPath = join(directory, 'input');
		const bundle = join(directory, 'invalid.mjs');
		await writeFile(inputPath, 'expected input');
		const codecUrl = new URL('../src/js.ts', import.meta.url).href;
		await writeFile(
			bundle,
			`
import { compress, createDecompressionStream } from ${JSON.stringify(codecUrl)};
export { createDecompressionStream };
export const createCompressionStream = () => new TransformStream({
  transform() {},
  flush(controller) { controller.enqueue(compress(new TextEncoder().encode('wrong'))); }
});
`
		);
		const child = spawnSync(process.execPath, [resolve('scripts/benchmark/trial.ts')], {
			input: JSON.stringify({
				inputPath,
				bundle,
				mode: 'js',
				operation: 'compress',
				concurrency: 1,
				timeoutMs: 10000
			}),
			encoding: 'utf8',
			timeout: 15000
		});
		assert.ifError(child.error);
		assert.equal(child.status, 1);
		assert.match(JSON.parse(child.stderr).error, /does not round-trip/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
