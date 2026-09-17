import { format } from 'prettier';
import { cpus, platform, arch, tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, stat, rename, rm } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { spawnProcess } from './scripts/benchmark/process.ts';
import { fetchIPv4 } from './scripts/benchmark/fetch-ipv4.ts';
import { DEFAULT_REPLAY_URL } from './scripts/benchmark/input.ts';
import { median, REPORT_INTRO, updateCpuSection } from './scripts/benchmark/report.ts';

const repository = import.meta.dirname;
const defaultUrl = DEFAULT_REPLAY_URL;
const isHttp = (value: string) => /^https?:\/\//i.test(value);
const source = process.argv[2];
const url = source !== undefined && isHttp(source) ? source : (process.env.BZIP_BENCHMARK_URL ?? defaultUrl);
if (!isHttp(url)) throw new Error('Expected an HTTP(S) archive URL');
const isFile = async (path: string) => (await stat(path).catch(() => undefined))?.isFile() === true;
// A local copy of the archive skips the download: a path argument, BZIP_BENCHMARK_FILE, or a file in the
// repository root named after the URL's last path segment (archives in the root are git-ignored).
const requiredLocal = source !== undefined && !isHttp(source) ? resolve(source) : process.env.BZIP_BENCHMARK_FILE;
if (requiredLocal !== undefined && !(await isFile(requiredLocal)))
	throw new Error(`Archive not found: ${requiredLocal}`);
const cachedLocal = join(repository, basename(new URL(url).pathname));
const localPath = requiredLocal ?? ((await isFile(cachedLocal)) ? cachedLocal : undefined);
const rounds = Number(process.argv[3] ?? process.env.BZIP_BENCHMARK_RUNS ?? 3);
if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('Rounds must be a positive integer');
const timeoutMs = Number(process.env.BZIP_BENCHMARK_TIMEOUT_MS ?? 1800000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Timeout must be a positive integer');
const reportPath = resolve(process.env.BZIP_BENCHMARK_REPORT ?? join(repository, 'benchmark.md'));
const cpu = (cpus()[0]?.model ?? `${platform()} ${arch()} CPU`).replace(/\s+/g, ' ').trim();
const workers = navigator.hardwareConcurrency;
const autoConcurrency = typeof Worker === 'function' ? workers : 1;
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
	entry: string;
	concurrency: number | 'auto';
	available: boolean;
};
type Result = { durationMs: number; inputBytes: number; outputBytes: number; inputSha256: string; sha256: string };
const cases: Case[] = [
	{
		name: 'bzip2',
		mode: 'bzip2',
		entry: 'index',
		concurrency: 1,
		available: spawnSync('bzip2', ['--help']).status === 0
	},
	{ name: 'bzip2-codec (JS, 1)', mode: 'js', entry: 'js', concurrency: 1, available: true },
	{ name: 'bzip2-codec (WASM, 1)', mode: 'js', entry: 'wasm', concurrency: 1, available: true },
	{
		name: 'lbzip2',
		mode: 'lbzip2',
		entry: 'index',
		concurrency: workers,
		available: spawnSync('lbzip2', ['--help']).status === 0
	},
	{ name: 'bzip2-codec (JS, auto)', mode: 'js', entry: 'js', concurrency: 'auto', available: true },
	{ name: 'bzip2-codec (WASM, auto)', mode: 'js', entry: 'wasm', concurrency: 'auto', available: true }
];

console.log(`CPU: ${cpu}; codec auto concurrency: ${autoConcurrency}; ${rounds} rounds.`);
// Always measure a fresh production build, never stale dist/ or experimental source patches.
await command([process.execPath, fileURLToPath(import.meta.resolve('tsdown/run'))]);
const revision = await command(['git', 'rev-parse', 'HEAD']);
const dirty = Boolean(await command(['git', 'status', '--porcelain']));
const scratch = await mkdtemp(join(tmpdir(), 'bzip-benchmark-'));
try {
	let inputPath: string;
	if (localPath !== undefined) {
		inputPath = localPath;
		console.log(`Using local archive ${inputPath} (file reads are excluded from timings).`);
	} else {
		inputPath = join(scratch, 'archive.bz2');
		console.log('Downloading archive once (excluded from timings)...');
		const response = await fetchIPv4(url, AbortSignal.timeout(timeoutMs));
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}; redirects are not followed`);
		}
		const encoding = response.headers.get('content-encoding');
		if (encoding && encoding !== 'identity') {
			await response.body.cancel();
			throw new Error('Server ignored Accept-Encoding: identity');
		}
		await pipeline(response.body, createWriteStream(inputPath));
		const expectedLength = response.headers.get('content-length');
		if (expectedLength !== null && Number(expectedLength) !== (await stat(inputPath)).size) {
			throw new Error('Content-Length mismatch');
		}
	}
	const inputBytes = (await stat(inputPath)).size;
	console.log(
		`${localPath === undefined ? 'Downloaded' : 'Loaded'} ${(inputBytes / 1e6).toFixed(1)} MB; running ${cases.filter(c => c.available).length * rounds} decoder trials.`
	);
	const results = new Map<string, Result[]>();
	const attempts: object[] = [];
	let reference: Result | undefined;
	const rawPath = `${reportPath}.json`;
	const metadata = {
		measurement: 'preloaded-input-v1',
		cpu,
		logicalCpus: cpus().length,
		autoConcurrency,
		runtime: process.versions.bun ?? process.versions.node,
		platform: platform(),
		arch: arch(),
		revision,
		dirty,
		host: new URL(url).hostname,
		rounds,
		cases: cases.map(c => ({ name: c.name, available: c.available }))
	};
	const saveRaw = (complete: boolean) =>
		writeFile(rawPath, JSON.stringify({ ...metadata, complete, attempts }, null, '\t') + '\n');
	await saveRaw(false);

	const runTrial = async (c: Case, round: number): Promise<Result> => {
		console.log(`${c.name}: round ${round}/${rounds}`);
		const child = spawnProcess(
			[process.execPath, ...process.execArgv, join(repository, 'scripts/benchmark/trial.ts')],
			{
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe'
			}
		);
		await child.stdin.write(
			JSON.stringify({
				inputPath,
				bundle: join(repository, `dist/${c.entry}.mjs`),
				mode: c.mode,
				concurrency: c.concurrency,
				timeoutMs
			})
		);
		await child.stdin.end();
		const watchdog = setTimeout(() => child.kill(), timeoutMs + 10000);
		let stdout: string, stderr: string, code: number;
		try {
			[stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited
			]);
		} finally {
			clearTimeout(watchdog);
		}
		if (code !== 0) {
			let failure: { error?: string } = {};
			try {
				failure = JSON.parse(stderr);
			} catch {}
			attempts.push({ name: c.name, round, failed: true, exitCode: code, stderr });
			await saveRaw(false);
			throw new Error(
				`${c.name}: ${failure.error ?? 'trial failed'}. Existing Markdown was not changed. Details: ${rawPath}`
			);
		}
		const result = JSON.parse(stdout) as Result;
		const valid =
			!reference ||
			(result.inputSha256 === reference.inputSha256 &&
				result.inputBytes === reference.inputBytes &&
				result.sha256 === reference.sha256 &&
				result.outputBytes === reference.outputBytes);
		attempts.push({ name: c.name, round, valid, ...result });
		await saveRaw(false);
		if (!valid) throw new Error('Input changed or decoder outputs differ; existing Markdown was not changed');
		reference ??= result;
		console.log(`  ${(result.durationMs / 1000).toFixed(3)} s`);
		return result;
	};
	const available = cases.filter(c => c.available);
	for (let round = 1; round <= rounds; round++) {
		const shift = (round - 1) % available.length;
		const order = [...available.slice(shift), ...available.slice(0, shift)];
		for (const c of round % 2 ? order : order.reverse()) {
			const result = await runTrial(c, round);
			const rows = results.get(c.name) ?? [];
			rows.push(result);
			results.set(c.name, rows);
		}
	}
	const table = cases.map(c => {
		const rows = results.get(c.name);
		if (!rows) return `| ${c.name} | Not installed | — | — |`;
		const times = rows.map(r => r.durationMs);
		const middle = median(times);
		return `| ${c.name} | ${(middle / 1000).toFixed(3)} s | ${(reference!.outputBytes / middle / 1000).toFixed(2)} MB/s | ${(Math.min(...times) / 1000).toFixed(3)}–${(Math.max(...times) / 1000).toFixed(3)} s |`;
	});
	const section = `## ${cpu}

Measurement: preloaded input, download/file reads and SHA-256 validation excluded. Includes decoder startup, streaming and output buffering.

Updated: ${new Date().toISOString()}. ${platform()} ${arch()}, ${process.versions.bun ? 'Bun' : 'Node.js'} ${process.versions.bun ?? process.versions.node}; ${workers} hardware threads, codec auto concurrency ${autoConcurrency}. Explicit concurrency 1 and bzip2 runs are single-threaded.
Revision: \`${revision.slice(0, 12)}\`${dirty ? ' (working tree has changes)' : ''}. ${rounds} successful trial(s) per decoder. Source host: \`${new URL(url).hostname}\`.
Input: ${reference!.inputBytes.toLocaleString('en-US')} compressed bytes → ${reference!.outputBytes.toLocaleString('en-US')} output bytes.
Input SHA-256: \`${reference!.inputSha256}\`. Output SHA-256: \`${reference!.sha256}\`.

| Decoder | Median time | Output throughput | Observed range |
| --- | ---: | ---: | ---: |
${table.join('\n')}
`;
	const old = await readFile(reportPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return REPORT_INTRO;
		throw error;
	});
	const temporary = join(dirname(reportPath), `.benchmark-${process.pid}-${Date.now()}.tmp`);
	try {
		await writeFile(
			temporary,
			updateCpuSection(
				old,
				cpu,
				await format(section, { parser: 'markdown', printWidth: 120, tabWidth: 4, useTabs: true })
			)
		);
		await rename(temporary, reportPath);
	} finally {
		await rm(temporary, { force: true });
	}
	await saveRaw(true);
	console.log(`Updated ${reportPath}; raw trials saved to ${rawPath}`);
} finally {
	await rm(scratch, { recursive: true, force: true });
}
