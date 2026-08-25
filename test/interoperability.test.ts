import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { compress, decompress } from '../src/index.ts';

const runBzip2 = (arguments_: readonly string[], input: Uint8Array): Promise<Uint8Array> =>
	new Promise((resolve, reject) => {
		const child = spawn('bzip2', arguments_);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.on('error', reject);
		child.on('close', code => {
			if (code !== 0) {
				reject(new Error(`bzip2 exited with code ${code}: ${Buffer.concat(stderr).toString()}`));
				return;
			}
			resolve(Buffer.concat(stdout));
		});
		child.stdin.end(input);
	});

test(
	'interoperates with the system bzip2 implementation',
	{ skip: process.env.BZIP_INTEROP_TESTS !== '1' },
	async context => {
		const patterned = new Uint8Array(100_000);
		for (let index = 0; index < patterned.length; index++) patterned[index] = (index * 19 + (index >>> 4)) & 0xff;

		const pseudorandom = new Uint8Array(180_000);
		let state = 0x5eeda11;
		for (let index = 0; index < pseudorandom.length; index++) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			pseudorandom[index] = state;
		}

		const inputs = [
			new Uint8Array(),
			new TextEncoder().encode('banana banana banana\n'.repeat(1_000)),
			new Uint8Array(1_000).fill(0xa5),
			patterned,
			pseudorandom
		];

		try {
			for (const input of inputs) {
				assert.deepEqual(new Uint8Array(await runBzip2(['-dc'], compress(input, { blockSize: 1 }))), input);
				assert.deepEqual(decompress(await runBzip2(['-c', '-1'], input)), input);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				context.skip('bzip2 executable is unavailable');
				return;
			}
			throw error;
		}
	}
);
