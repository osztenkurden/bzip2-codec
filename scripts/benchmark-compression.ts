import { cpus, platform, arch } from 'node:os';
import { readFile, writeFile, stat, rename, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { format } from 'prettier';
import { spawnProcess } from './benchmark/process.ts';
import { resolveHardwareConcurrency, supportsWorkers } from '../src/parallel/pool.ts';
import { median, updateCpuSection } from './benchmark/report.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const source = process.argv[2] ?? process.env.BZIP_COMPRESS_FILE;
if (!source) throw new Error('Usage: bun run benchmark:compress <uncompressed-file> [rounds]');
const inputPath = resolve(source);
if (!(await stat(inputPath)).isFile()) throw new Error(`Not a file: ${inputPath}`);
const integer = (value: string, name: string, maximum = Number.MAX_SAFE_INTEGER) => {
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
		throw new Error(`${name} must be an integer between 1 and ${maximum}`);
	return result;
};
const rounds = integer(process.argv[3] ?? process.env.BZIP_COMPRESS_RUNS ?? '3', 'Rounds');
const blockSize = integer(process.env.BZIP_COMPRESS_BLOCK_SIZE ?? '9', 'Block size', 9);
const timeoutMs = integer(process.env.BZIP_COMPRESS_TIMEOUT_MS ?? '1800000', 'Timeout');
const reportPath = resolve(process.env.BZIP_COMPRESS_REPORT ?? join(repository, 'benchmark-compress.md'));
const rawPath = `${reportPath}.json`;
if (inputPath === reportPath || inputPath === rawPath) throw new Error('Input and report paths must differ');
const cpu = (cpus()[0]?.model ?? `${platform()} ${arch()} CPU`).replace(/\s+/g, ' ').trim();
const workers = Math.max(1, cpus().length);
const autoConcurrency = supportsWorkers() ? resolveHardwareConcurrency() : 1;
const command = async (args: string[]) => {
	const child = spawnProcess(args, { cwd: repository, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited
	]);
	if (code !== 0) throw new Error(`${args[0]} failed: ${stderr}`);
	return stdout.trim();
};
type Case = {
	name: string;
	mode: 'js' | 'bzip2' | 'lbzip2';
	entry?: 'js' | 'wasm';
	concurrency: number | 'auto';
	available: boolean;
};
type Result = {
	durationMs: number;
	inputBytes: number;
	inputSha256: string;
	outputBytes: number;
	sha256: string;
	decodedBytes: number;
	decodedSha256: string;
};
const lbzip2Available = spawnSync('lbzip2', ['--help']).status === 0;
const cases: Case[] = [
	{ name: 'bzip2', mode: 'bzip2', concurrency: 1, available: spawnSync('bzip2', ['--help']).status === 0 },
	{ name: 'bzip2-codec (JS, 1)', mode: 'js', entry: 'js', concurrency: 1, available: true },
	{ name: 'bzip2-codec (WASM, 1)', mode: 'js', entry: 'wasm', concurrency: 1, available: true },
	{ name: 'lbzip2 (all CPUs)', mode: 'lbzip2', concurrency: workers, available: lbzip2Available },
	{ name: 'bzip2-codec (JS, auto)', mode: 'js', entry: 'js', concurrency: 'auto', available: true },
	{ name: 'bzip2-codec (WASM, auto)', mode: 'js', entry: 'wasm', concurrency: 'auto', available: true }
];
console.log(`CPU: ${cpu}; ${rounds} rounds; block size ${blockSize}.`);
await command([process.execPath, fileURLToPath(import.meta.resolve('tsdown/run'))]);
const metadata = {
	measurement: 'compression-preloaded-input-v1',
	cpu,
	logicalCpus: workers,
	autoConcurrency,
	runtime: process.versions.bun ?? process.versions.node,
	platform: platform(),
	arch: arch(),
	revision: await command(['git', 'rev-parse', 'HEAD']),
	dirty: Boolean(await command(['git', 'status', '--porcelain'])),
	inputPath,
	rounds,
	blockSize,
	cases
};
const attempts: object[] = [];
const saveRaw = (complete: boolean) =>
	writeFile(rawPath, JSON.stringify({ ...metadata, complete, attempts }, null, '\t') + '\n');
await saveRaw(false);
const results = new Map<string, Result[]>();
const codecHashes = new Map<string, string>();
let reference: Result | undefined;
const available = cases.filter(c => c.available);
for (let round = 1; round <= rounds; round++) {
	const shift = (round - 1) % available.length;
	const order = [...available.slice(shift), ...available.slice(0, shift)];
	for (const c of round % 2 ? order : order.reverse()) {
		console.log(`${c.name}: round ${round}/${rounds}`);
		const child = spawnProcess(
			[process.execPath, ...process.execArgv, join(repository, 'scripts/benchmark/trial.ts')],
			{
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe'
			}
		);
		const watchdog = setTimeout(() => child.kill(), timeoutMs + 10000);
		let result: Result;
		try {
			await child.stdin.write(
				JSON.stringify({
					inputPath,
					bundle: join(repository, `dist/${c.entry ?? 'js'}.mjs`),
					operation: 'compress',
					mode: c.mode,
					concurrency: c.concurrency,
					blockSize,
					timeoutMs
				})
			);
			await child.stdin.end();
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited
			]);
			if (code !== 0) throw new Error(`Trial exited ${code}: ${stderr}`);
			result = JSON.parse(stdout) as Result;
			if (
				!Number.isFinite(result.durationMs) ||
				result.durationMs <= 0 ||
				!Number.isSafeInteger(result.outputBytes) ||
				result.outputBytes < 1 ||
				result.decodedBytes !== result.inputBytes ||
				result.decodedSha256 !== result.inputSha256 ||
				(reference &&
					(result.inputBytes !== reference.inputBytes || result.inputSha256 !== reference.inputSha256))
			)
				throw new Error('Input changed or compressed output failed round-trip validation');
			if (c.mode === 'js') {
				const key = c.entry ?? 'js';
				const previous = codecHashes.get(key);
				if (previous !== undefined && previous !== result.sha256)
					throw new Error(`${key} compressed bytes differ across scheduling modes or rounds`);
				codecHashes.set(key, result.sha256);
			}
		} catch (error) {
			attempts.push({ name: c.name, round, failed: true, error: String(error) });
			await saveRaw(false);
			throw new Error(`${c.name}: ${error}. Existing Markdown was not changed. Details: ${rawPath}`);
		} finally {
			clearTimeout(watchdog);
			if (child.exitCode === null) {
				child.kill();
				await child.exited;
			}
		}
		reference ??= result;
		attempts.push({ name: c.name, round, ...result });
		await saveRaw(false);
		const rows = results.get(c.name) ?? [];
		rows.push(result);
		results.set(c.name, rows);
		console.log(`  ${(result.durationMs / 1000).toFixed(3)} s; ${result.outputBytes} compressed bytes`);
	}
}
const table = cases.map(c => {
	const rows = results.get(c.name);
	if (!rows) return `| ${c.name} | Not installed | — | — | — | — |`;
	const times = rows.map(r => r.durationMs);
	const middle = median(times);
	const size = median(rows.map(r => r.outputBytes));
	const ratio = reference!.inputBytes ? `${((100 * size) / reference!.inputBytes).toFixed(2)}%` : '—';
	return `| ${c.name} | ${(middle / 1000).toFixed(3)} s | ${(reference!.inputBytes / middle / 1000).toFixed(2)} MB/s | ${size.toLocaleString('en-US')} | ${ratio} | ${(Math.min(...times) / 1000).toFixed(3)}–${(Math.max(...times) / 1000).toFixed(3)} s |`;
});
const intro = `# Compression benchmarks

Run \`bun run benchmark:compress <uncompressed-file> [rounds]\` to update this machine's CPU section.
Input is preloaded; file reads, hashing and round-trip validation are excluded from timings.
Times include encoder startup, streaming and output buffering. Native trials also include process startup and pipes.
JS and WASM run with concurrency 1 and auto; bzip2 is the single-core reference and lbzip2 uses all logical CPUs. Compare results using the same input and block size.
`;
const section = `## ${cpu}

Updated: ${new Date().toISOString()}. ${platform()} ${arch()}, ${process.versions.bun ? 'Bun' : 'Node.js'} ${metadata.runtime}; ${workers} logical CPUs; codec auto concurrency ${autoConcurrency}.
Revision: \`${metadata.revision.slice(0, 12)}\`${metadata.dirty ? ' (working tree has changes)' : ''}. ${rounds} successful trial(s) per encoder; block size ${blockSize}.
Measurement: compression-preloaded-input-v1. Input: ${reference!.inputBytes.toLocaleString('en-US')} bytes. SHA-256: \`${reference!.inputSha256}\`.
Every output was decoded and checked against the input outside the timed region. Compressed bytes may differ between encoders.
For each library backend, compressed hashes also matched across concurrency settings and rounds.
Compressed size is the median; size/input is smaller for better compression. Throughput uses decimal MB of uncompressed input.

| Encoder | Median time | Input throughput | Compressed bytes | Size/input | Observed range |
| --- | ---: | ---: | ---: | ---: | ---: |
${table.join('\n')}
`;
const old = await readFile(reportPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
	if (error.code === 'ENOENT') return intro;
	throw error;
});
const temporary = join(dirname(reportPath), `.benchmark-compress-${process.pid}-${Date.now()}.tmp`);
try {
	await writeFile(
		temporary,
		updateCpuSection(old, cpu, await format(section, { parser: 'markdown', printWidth: 120 }))
	);
	await rename(temporary, reportPath);
} finally {
	await rm(temporary, { force: true });
}
await saveRaw(true);
console.log(`Updated ${reportPath}; raw trials saved to ${rawPath}`);
