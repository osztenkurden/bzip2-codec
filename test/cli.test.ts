import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { compress, decompress } from '../src/index.ts';

const plain = Buffer.from('CLI round trip\n'.repeat(100));
const encoded = compress(plain);
const runtimes = [
	...new Set(
		[process.execPath, 'node', 'bun']
			.map(runtime => spawnSync(runtime, ['--print', 'process.execPath'], { encoding: 'utf8' }).stdout?.trim())
			.filter((runtime): runtime is string => !!runtime)
	)
].filter(runtime => {
	const result = spawnSync(runtime, ['--version'], { encoding: 'utf8' });
	return (
		result.status === 0 && (!result.stdout.startsWith('v') || Number(result.stdout.slice(1).split('.')[0]) >= 22)
	);
});

for (const runtime of runtimes) {
	for (const built of [false, true]) {
		const entry = resolve(built ? 'dist/cli.mjs' : 'src/cli.ts');
		const label = `${runtime} ${built ? 'built' : 'source'} CLI`;
		const options = { skip: built && process.env.BZIP_BUILT_TESTS !== '1', timeout: 60000 };
		const run = (args: string[], input: Uint8Array = encoded) => {
			const result = spawnSync(runtime, [entry, ...args], { input, timeout: 20000 });
			assert.ifError(result.error);
			return result;
		};

		test(`${label}: streams, backends, help and validation`, options, () => {
			for (const args of [['--help'], ['compress', '-h'], ['decompress', '--help'], ['test', '-h']]) {
				const result = run(args);
				assert.equal(result.status, 0, result.stderr.toString());
				assert.match(result.stdout.toString(), /Usage:/);
				assert.match(result.stdout.toString(), /Decoder backend \(default: wasm\)/);
			}
			assert.match(run(['--version']).stdout.toString(), /^\d+\.\d+\.\d+\n$/);
			for (const args of [
				[],
				['unknown'],
				['compress', 'a', 'b'],
				['test', '-o', '-'],
				['test', '-f'],
				['compress', '-f'],
				['compress', '--backend', 'js'],
				['decompress', '-b', '1'],
				['test', '--unknown'],
				['compress', '-b', '10'],
				['compress', '-b', '0'],
				['test', '--backend', 'native'],
				['test', '--max-output-bytes', '-1'],
				['test', '--max-output-bytes', 'Infinity'],
				['test', '--max-output-bytes', '9007199254740992'],
				['test', '--concurrency', '0'],
				['test', '--concurrency', '1.5'],
				['test', '--concurrency', '9007199254740992'],
				['compress', '-o']
			]) {
				const result = run(args);
				assert.equal(result.status, 2, `${args}: ${result.stderr}`);
				assert.equal(result.stdout.length, 0);
			}
			for (const args of [['compress'], ['compress', '-', '-o', '-', '-b', '1']]) {
				const result = run(args, plain);
				assert.equal(result.status, 0, result.stderr.toString());
				assert.deepEqual(Buffer.from(decompress(result.stdout)), plain);
				assert.equal(result.stdout[3], args.length === 1 ? 57 : 49);
			}
			for (const backend of [undefined, 'js', 'wasm']) {
				const backendArgs = backend ? ['--backend', backend] : [];
				for (const concurrency of ['1', '2', 'auto']) {
					for (const command of ['decompress', 'test']) {
						const result = run([command, ...backendArgs, '--concurrency', concurrency]);
						assert.equal(result.status, 0, result.stderr.toString());
						assert.deepEqual(result.stdout, command === 'test' ? Buffer.alloc(0) : plain);
						const node = spawnSync(runtime, ['--version'], { encoding: 'utf8' }).stdout.startsWith('v');
						assert.equal(result.stderr.toString().includes('warning'), node && concurrency === '2');
					}
				}
				const limit = run(['test', ...backendArgs, '--max-output-bytes', '0']);
				assert.equal(limit.status, 1);
				assert.match(limit.stderr.toString(), /OUTPUT_LIMIT/);
				assert.equal(
					run(['test', ...backendArgs, '--max-output-bytes', '0'], compress(new Uint8Array())).status,
					0
				);
			}
			const corrupt = run(['test'], encoded.subarray(0, 15));
			assert.equal(corrupt.status, 1);
			assert.match(corrupt.stderr.toString(), /UNEXPECTED_EOF/);
			assert.equal(run(['test'], Buffer.concat([encoded, Buffer.from('junk')])).status, 1);
			const partial = run(['decompress'], Buffer.concat([encoded, encoded.subarray(0, 15)]));
			assert.equal(partial.status, 1);
			assert.deepEqual(partial.stdout, plain);
			const terminal = spawnSync(
				runtime,
				[
					'--eval',
					`process.stdout.isTTY = true; process.argv = ['runtime', 'cli', 'compress']; import(${JSON.stringify(new URL(`../${built ? 'dist/cli.mjs' : 'src/cli.ts'}`, import.meta.url).href)});`
				],
				{ input: plain, encoding: 'utf8' }
			);
			assert.equal(terminal.status, 2, terminal.stderr);
			assert.equal(terminal.stdout, '');
			assert.match(terminal.stderr, /terminal/);
		});

		test(`${label}: JS backend works without WASM, default requires WASM`, options, () => {
			for (const backend of [undefined, 'js', 'wasm']) {
				const args = ['decompress', ...(backend ? ['--backend', backend] : [])];
				const result = spawnSync(
					runtime,
					[
						'--eval',
						`
						// Node's TypeScript stripper itself needs WASM; initialize it first.
						if (!process.versions.bun) require('node:module').stripTypeScriptTypes('');
						globalThis.WebAssembly = undefined;
					process.argv = ['runtime', 'cli', ...${JSON.stringify(args)}];
					import(${JSON.stringify(new URL(`../${built ? 'dist/cli.mjs' : 'src/cli.ts'}`, import.meta.url).href)});
				`
					],
					{ input: encoded, timeout: 20000 }
				);
				assert.ifError(result.error);
				assert.equal(result.status, backend === 'js' ? 0 : 1, result.stderr.toString());
				assert.deepEqual(result.stdout, backend === 'js' ? plain : Buffer.alloc(0));
			}
		});

		test(`${label}: safe file output and aliases`, options, async () => {
			const directory = await mkdtemp(join(tmpdir(), 'bzip-cli-'));
			try {
				const input = join(directory, 'input');
				const output = join(directory, 'output');
				await writeFile(input, encoded);
				assert.equal(run(['decompress', input, '-o', output]).status, 0);
				assert.deepEqual(await readFile(output), plain);
				assert.equal(run(['decompress', input, '-o', output]).status, 1);
				assert.equal(run(['decompress', input, '-o', output, '-f'], plain).status, 0);
				assert.equal(run(['decompress', '-o', output, '-f'], encoded.subarray(0, 15)).status, 1);
				assert.deepEqual(await readFile(output), plain);
				assert.equal(run(['decompress', '-o', join(directory, 'failed')], encoded.subarray(0, 15)).status, 1);
				await link(input, join(directory, 'hard'));
				await symlink(input, join(directory, 'sym'));
				for (const alias of [
					input,
					join(directory, '.', 'input'),
					join(directory, 'hard'),
					join(directory, 'sym')
				]) {
					assert.equal(run(['decompress', input, '-o', alias, '-f']).status, 2);
				}
				assert.deepEqual(await readFile(input), Buffer.from(encoded));
				const fd = openSync(input, 'r');
				try {
					const redirected = spawnSync(runtime, [entry, 'decompress', '-o', input, '-f'], {
						stdio: [fd, 'pipe', 'pipe']
					});
					assert.equal(redirected.status, 2, redirected.stderr.toString());
				} finally {
					closeSync(fd);
				}
				assert.deepEqual((await readdir(directory)).sort(), ['hard', 'input', 'output', 'sym']);
				assert.equal(run(['test', join(directory, 'missing')]).status, 1);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});

		test(`${label}: no-clobber publication race`, options, async () => {
			const directory = await mkdtemp(join(tmpdir(), 'bzip-cli-'));
			const output = join(directory, 'output');
			const child = spawn(runtime, [entry, 'decompress', '-o', output], { stdio: ['pipe', 'pipe', 'pipe'] });
			const finished = new Promise<number | null>((resolve, reject) => {
				child.on('error', reject);
				child.on('close', resolve);
			});
			try {
				let ready = false;
				for (let i = 0; i < 500; i++) {
					if ((await readdir(directory)).some(name => name.endsWith('.tmp'))) {
						ready = true;
						break;
					}
					await new Promise(resolve => setTimeout(resolve, 10));
				}
				assert.ok(ready, 'CLI opened temporary output');
				await writeFile(output, 'concurrent output');
				child.stdin.end(encoded);
				assert.equal(await finished, 1);
				assert.equal(await readFile(output, 'utf8'), 'concurrent output');
				assert.deepEqual(await readdir(directory), ['output']);
			} finally {
				child.kill();
				await finished;
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
}

test(
	'built executable has Node shebang and runs directly',
	{ skip: process.env.BZIP_BUILT_TESTS !== '1' },
	async () => {
		const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
		const executable = resolve(manifest.bin['bzip2-codec']);
		assert.ok((await readFile(executable, 'utf8')).startsWith('#!/usr/bin/env node\n'));
		const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, `${manifest.version}\n`);
	}
);
