#!/usr/bin/env node
import { createReadStream, fstatSync } from 'node:fs';
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { createCompressionStream, type BlockSize } from './js.ts';
import { supportsWorkers } from './parallel/pool.ts';

const help = `Usage: bzip2-codec compress|decompress|test [input] [options]

Input omitted or - reads stdin. compress/decompress write stdout by default.
  -o, --output PATH          Output file, or - for stdout (not test)
  -f, --force                Overwrite output file (not stdout or test)
  -b, --block-size 1..9      Compression block size (default: 9)
      --backend js|wasm     Decoder backend (default: wasm)
      --max-output-bytes N  Nonnegative safe integer limit (default: unlimited)
      --concurrency N|auto  Positive safe integer worker count (default: 1)
  -h, --help                Show help
      --version             Show version

Decoder options apply only to decompress/test. test discards output and is
silent on success. Node without workers warns and uses 1 for explicit N > 1;
auto falls back silently. Bun supports workers.
Files are published only on success; sources are never deleted. Binary stdout
is refused on a terminal and may contain partial output on failure.
Exit status: 0 success, 1 processing error, 2 usage error.
`;

class UsageError extends Error {}

const integer = (value: string, name: string, minimum: number): number => {
	const number = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum)
		throw new UsageError(`--${name} must be a ${minimum ? 'positive' : 'nonnegative'} safe integer`);
	return number;
};

async function main(): Promise<void> {
	let args;
	try {
		args = parseArgs({
			args: process.argv.slice(2),
			allowPositionals: true,
			options: {
				output: { type: 'string', short: 'o' },
				force: { type: 'boolean', short: 'f' },
				'block-size': { type: 'string', short: 'b' },
				backend: { type: 'string' },
				'max-output-bytes': { type: 'string' },
				concurrency: { type: 'string' },
				help: { type: 'boolean', short: 'h' },
				version: { type: 'boolean' }
			}
		});
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
	const { values, positionals } = args;
	const [command, input = '-'] = positionals;
	if (command !== undefined && !['compress', 'decompress', 'test'].includes(command))
		throw new UsageError(`Unknown command: ${command}`);
	if (positionals.length > 2) throw new UsageError('Expected at most one input');
	const output = values.output ?? '-';
	if (command === 'test' && (values.output !== undefined || values.force !== undefined))
		throw new UsageError('test does not accept --output or --force');
	if (values.force !== undefined && output === '-') throw new UsageError('--force requires an output file');
	if (command !== 'compress' && values['block-size'] !== undefined)
		throw new UsageError('--block-size applies only to compress');
	if (command === 'compress') {
		for (const option of ['backend', 'max-output-bytes', 'concurrency'] as const)
			if (values[option] !== undefined) throw new UsageError(`--${option} applies only to decompress/test`);
	}
	const blockSize = integer(values['block-size'] ?? '9', 'block-size', 1);
	if (blockSize > 9) throw new UsageError('--block-size must be between 1 and 9');
	const backend = values.backend ?? 'wasm';
	if (backend !== 'js' && backend !== 'wasm') throw new UsageError('--backend must be js or wasm');
	const maxOutputBytes =
		values['max-output-bytes'] === undefined
			? undefined
			: integer(values['max-output-bytes'], 'max-output-bytes', 0);
	let concurrency =
		values.concurrency === 'auto' ? ('auto' as const) : integer(values.concurrency ?? '1', 'concurrency', 1);
	if (values.help) {
		process.stdout.write(help);
		return;
	}
	if (values.version) {
		const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
		process.stdout.write(`${manifest.version}\n`);
		return;
	}
	if (command === undefined) throw new UsageError('Expected compress, decompress, or test (see --help)');
	if (command !== 'test' && output === '-' && process.stdout.isTTY)
		throw new UsageError('Refusing binary output to a terminal; use --output or redirect stdout');
	if (typeof concurrency === 'number' && concurrency > 1 && !supportsWorkers()) {
		process.stderr.write('bzip2-codec: warning: workers unavailable; using --concurrency 1\n');
		concurrency = 1;
	}
	const codec =
		command === 'compress'
			? createCompressionStream({ blockSize: blockSize as BlockSize })
			: (backend === 'wasm'
					? (await import('./wasm/index.ts')).createDecompressionStream
					: (await import('./js.ts')).createDecompressionStream)({ maxOutputBytes, concurrency });
	const sourceStat = input === '-' ? fstatSync(process.stdin.fd) : await stat(input);
	const checkOutput = async () => {
		const target = await stat(output).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== 'ENOENT') throw error;
			return undefined;
		});
		if (target && target.dev === sourceStat.dev && target.ino === sourceStat.ino)
			throw new UsageError('Input and output must not be the same file');
		if (target && !values.force) throw new Error(`Output already exists: ${output} (use --force)`);
	};
	let temporary: string | undefined;
	let handle;
	try {
		let destination: Writable;
		if (command === 'test')
			destination = new Writable({
				write(_chunk, _encoding, callback) {
					callback();
				}
			});
		else if (output === '-') destination = process.stdout;
		else {
			await checkOutput();
			const path = join(dirname(output), `.bzip2-codec-${randomUUID()}.tmp`);
			handle = await open(path, 'wx');
			temporary = path;
			destination = handle.createWriteStream();
		}
		const source = Readable.toWeb(
			input === '-' ? process.stdin : createReadStream(input)
		) as unknown as ReadableStream<Uint8Array>;
		await source.pipeThrough(codec).pipeTo(Writable.toWeb(destination));
		if (temporary) {
			await checkOutput();
			// link is an atomic no-clobber publish, unlike a check followed by rename.
			if (values.force) await rename(temporary, output);
			else await link(temporary, output);
		}
	} finally {
		await handle?.close();
		if (temporary)
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== 'ENOENT') throw error;
			});
	}
}

await main().catch((error: Error & { code?: string }) => {
	process.stderr.write(`bzip2-codec: ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
	process.exitCode = error instanceof UsageError ? 2 : 1;
});
