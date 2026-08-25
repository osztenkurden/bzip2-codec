import { readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import type { WorkerResult } from './memory/measurement.ts';

interface TrialResult extends WorkerResult {
	fixture: string;
	peakRssBytes: number;
	throughputMbps: number;
}

const requestedRuns = Number.parseInt(Bun.env.BZIP_BENCHMARK_RUNS ?? '10', 10);
if (!Number.isSafeInteger(requestedRuns) || requestedRuns < 1) {
	throw new RangeError('BZIP_BENCHMARK_RUNS must be a positive integer');
}

const arguments_ = Bun.argv.slice(2);
const defaultFixtureDirectory = resolve(import.meta.dir, '../test_files');
const fixturePaths =
	arguments_.length > 0
		? arguments_.map(path => resolve(path))
		: (await readdir(defaultFixtureDirectory))
				.filter(name => name.endsWith('.bz2'))
				.sort()
				.map(name => resolve(defaultFixtureDirectory, name));

if (fixturePaths.length === 0) {
	throw new Error('No .bz2 fixtures found. Pass one or more fixture paths as arguments.');
}

for (const fixture of fixturePaths) {
	if (!(await Bun.file(fixture).exists())) throw new Error(`Fixture does not exist: ${fixture}`);
}

const runTrial = async (fixture: string): Promise<TrialResult> => {
	const subprocess = Bun.spawn([process.execPath, resolve(import.meta.dir, 'memory/bun-file-stream.ts'), fixture], {
		cwd: resolve(import.meta.dir, '..'),
		stdout: 'pipe',
		stderr: 'pipe'
	});

	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text()
	]);

	if (exitCode !== 0) {
		throw new Error(`Decompression worker exited with code ${exitCode}${stderr ? `:\n${stderr}` : ''}`);
	}

	const usage = subprocess.resourceUsage();
	if (!usage) throw new Error('Bun did not return resource usage for the decompression worker');

	const result = JSON.parse(stdout.trim()) as WorkerResult;
	return {
		...result,
		fixture: basename(fixture),
		peakRssBytes: usage.maxRSS,
		throughputMbps: result.outputBytes / 1_000_000 / (result.durationMs / 1_000)
	};
};

const percentile = (values: readonly number[], probability: number): number => {
	const sorted = [...values].sort((left, right) => left - right);
	const position = (sorted.length - 1) * probability;
	const lower = Math.floor(position);
	const fraction = position - lower;
	return sorted[lower]! + (sorted[Math.min(lower + 1, sorted.length - 1)]! - sorted[lower]!) * fraction;
};

const formatBytes = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

const results: TrialResult[] = [];
for (let run = 0; run < requestedRuns; run++) {
	const fixture = fixturePaths[run % fixturePaths.length]!;
	const result = await runTrial(fixture);
	results.push(result);
	console.log(
		`[${run + 1}/${requestedRuns}] ${result.fixture}: ${result.throughputMbps.toFixed(2)} MB/s ` +
			`(${(result.durationMs / 1_000).toFixed(2)} s, ${formatBytes(result.outputBytes)} output)`
	);
}

const throughputs = results.map(result => result.throughputMbps);
const totalOutputBytes = results.reduce((total, result) => total + result.outputBytes, 0);
const totalDurationMs = results.reduce((total, result) => total + result.durationMs, 0);

console.log('');
console.table(
	results.map((result, index) => ({
		Run: index + 1,
		Fixture: result.fixture,
		Output: formatBytes(result.outputBytes),
		Time: `${(result.durationMs / 1_000).toFixed(2)} s`,
		'MB/s': result.throughputMbps.toFixed(2),
		'Peak RSS': formatBytes(result.peakRssBytes)
	}))
);
console.table({
	Average: `${(throughputs.reduce((total, value) => total + value, 0) / throughputs.length).toFixed(2)} MB/s`,
	Median: `${percentile(throughputs, 0.5).toFixed(2)} MB/s`,
	P90: `${percentile(throughputs, 0.9).toFixed(2)} MB/s`,
	P99: `${percentile(throughputs, 0.99).toFixed(2)} MB/s`,
	'Aggregate throughput': `${(totalOutputBytes / 1_000_000 / (totalDurationMs / 1_000)).toFixed(2)} MB/s`
});
console.log('MB/s uses decimal megabytes of decompressed output. Each trial runs in a fresh Bun process.');
