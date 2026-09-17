import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// bun wasm/check-mtf.ts: use recorded flags without replacing the shipped module.
const manifest = await Bun.file(join(import.meta.dirname, 'encoder-build.json')).json();
const directory = await mkdtemp(join(tmpdir(), 'bzip-mtf-'));
try {
	const output = join(directory, 'test.wasm');
	const child = Bun.spawn(
		[Bun.env.CLANG ?? 'clang', ...manifest.flags, 'test-mtf.c', 'vendor/divbwt.c', 'vendor/crctab.c', '-o', output],
		{ cwd: import.meta.dirname, stdout: 'inherit', stderr: 'inherit' }
	);
	assert.equal(await child.exited, 0);
	const module = new WebAssembly.Module(await Bun.file(output).arrayBuffer());
	const { test } = new WebAssembly.Instance(module).exports;
	assert.equal(typeof test, 'function');
	assert.equal((test as () => number)(), 165280);
	console.log('WASM word MTF: 165280 scalar-oracle cases passed');
} finally {
	await rm(directory, { recursive: true, force: true });
}
