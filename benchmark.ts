import { format } from 'prettier';
import { cpus, platform, arch } from 'node:os';
import { rename, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { median, REPORT_INTRO, updateCpuSection } from './scripts/benchmark/report.ts';

const repository = import.meta.dirname;
const defaultUrl = 'http://replay187.valve.net/730/003842189672549712349_0179118028.dem.bz2';
const url = Bun.argv[2] ?? Bun.env.BZIP_BENCHMARK_URL ?? defaultUrl;
if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Expected an HTTP(S) archive URL');
const rounds = Number(Bun.argv[3] ?? Bun.env.BZIP_BENCHMARK_RUNS ?? 3);
if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('Rounds must be a positive integer');
const timeoutMs = Number(Bun.env.BZIP_BENCHMARK_TIMEOUT_MS ?? 1800000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Timeout must be a positive integer');
const reportPath = resolve(Bun.env.BZIP_BENCHMARK_REPORT ?? join(repository, 'benchmark.md'));
const cpu = (cpus()[0]?.model ?? `${platform()} ${arch()} CPU`).replace(/\s+/g, ' ').trim();
const workers = navigator.hardwareConcurrency;
const command = async (args: string[]) => {
	const child = Bun.spawn(args, { cwd: repository, stdout: 'pipe', stderr: 'pipe' });
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
	{ name: 'bzip2', mode: 'bzip2', entry: 'index', concurrency: 1, available: !!Bun.which('bzip2') },
	{ name: 'lbzip2', mode: 'lbzip2', entry: 'index', concurrency: workers, available: !!Bun.which('lbzip2') },
	{ name: 'bzip2-codec (JS, auto)', mode: 'js', entry: 'index', concurrency: 'auto', available: true },
	{ name: 'bzip2-codec (WASM, auto)', mode: 'js', entry: 'wasm', concurrency: 'auto', available: true }
];

console.log(`CPU: ${cpu}; auto concurrency: ${workers}; ${rounds} rounds.`);
console.log(
	`${cases.filter(c => c.available).length * rounds} complete downloads planned, plus up to two retries per interrupted download.`
);
// Always measure a fresh production build, never stale dist/ or experimental source patches.
await command([process.execPath, 'run', 'build']);
const revision = await command(['git', 'rev-parse', 'HEAD']);
const dirty = Boolean(await command(['git', 'status', '--porcelain']));
const results = new Map<string, Result[]>();
const attempts: object[] = [];
let reference: Result | undefined;
const rawPath = `${reportPath}.json`;
const metadata = {
	cpu,
	logicalCpus: cpus().length,
	autoConcurrency: workers,
	runtime: Bun.version,
	platform: platform(),
	arch: arch(),
	revision,
	dirty,
	host: new URL(url).hostname,
	rounds,
	cases: cases.map(c => ({ name: c.name, available: c.available }))
};
const saveRaw = (complete: boolean) =>
	Bun.write(rawPath, JSON.stringify({ ...metadata, complete, attempts }, null, '\t') + '\n');
await saveRaw(false);

const runTrial = async (c: Case, round: number): Promise<Result> => {
	for (let attempt = 1; attempt <= 3; attempt++) {
		console.log(`${c.name}: round ${round}/${rounds}, attempt ${attempt}`);
		const child = Bun.spawn([process.execPath, join(repository, 'scripts/benchmark/trial.ts')], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe'
		});
		child.stdin.write(
			JSON.stringify({
				url,
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
			let failure: { retryable?: boolean; error?: string } = {};
			try {
				failure = JSON.parse(stderr);
			} catch {}
			attempts.push({ name: c.name, round, attempt, failed: true, exitCode: code, stderr });
			await saveRaw(false);
			if (failure.retryable && attempt < 3) {
				console.warn('Download interrupted; retrying from the beginning.');
				await Bun.sleep(1000 * attempt);
				continue;
			}
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
		attempts.push({ name: c.name, round, attempt, valid, ...result });
		await saveRaw(false);
		if (!valid) throw new Error('Input changed or decoder outputs differ; existing Markdown was not changed');
		reference ??= result;
		console.log(`  ${(result.durationMs / 1000).toFixed(3)} s`);
		return result;
	}
	throw new Error('Retry budget exhausted');
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

Updated: ${new Date().toISOString()}. ${platform()} ${arch()}, Bun ${Bun.version}; ${workers} auto workers/threads, bzip2 single-threaded.
Revision: \`${revision.slice(0, 12)}\`${dirty ? ' (working tree has changes)' : ''}. ${rounds} successful trial(s) per decoder. Source host: \`${new URL(url).hostname}\`.
Input: ${reference!.inputBytes.toLocaleString('en-US')} compressed bytes → ${reference!.outputBytes.toLocaleString('en-US')} output bytes.
Input SHA-256: \`${reference!.inputSha256}\`. Output SHA-256: \`${reference!.sha256}\`.

| Decoder | Median time | Output throughput | Observed range |
| --- | ---: | ---: | ---: |
${table.join('\n')}
`;
const old = (await Bun.file(reportPath).exists()) ? await Bun.file(reportPath).text() : REPORT_INTRO;
const temporary = join(dirname(reportPath), `.benchmark-${process.pid}-${Date.now()}.tmp`);
try {
	await Bun.write(
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
