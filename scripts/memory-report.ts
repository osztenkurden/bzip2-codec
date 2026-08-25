import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import type { WorkerResult } from './memory/measurement.ts';

interface ReportResult extends WorkerResult {
	peakRssBytes: number;
}

const workers = ['in-memory.ts', 'bun-file-stream.ts', 'node-file-stream.ts'] as const;
const fixture = resolve(Bun.argv[2] ?? 'test_files/003838660961779056911_2094919404.dem.bz2');

if (!(await Bun.file(fixture).exists())) throw new Error(`Fixture does not exist: ${fixture}`);

const runWorker = async (worker: (typeof workers)[number]): Promise<ReportResult> => {
	const subprocess = Bun.spawn([process.execPath, resolve(import.meta.dir, 'memory', worker), fixture], {
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
		throw new Error(`${worker} exited with code ${exitCode}${stderr ? `:\n${stderr}` : ''}`);
	}

	const usage = subprocess.resourceUsage();
	if (!usage) throw new Error(`Bun did not return resource usage for ${worker}`);

	return {
		...(JSON.parse(stdout.trim()) as WorkerResult),
		peakRssBytes: usage.maxRSS
	};
};

const results: ReportResult[] = [];
for (const worker of workers) results.push(await runWorker(worker));

const expected = results[0]!;
for (const result of results.slice(1)) {
	assert.equal(result.outputBytes, expected.outputBytes, `${result.method} produced a different byte count`);
	assert.equal(result.sha256, expected.sha256, `${result.method} produced different output`);
}

const formatBytes = (bytes: number): string => {
	const units = ['B', 'KiB', 'MiB', 'GiB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

console.log(`Fixture: ${fixture}`);
console.log(`Compressed: ${formatBytes(expected.compressedBytes)}`);
console.log(`Decompressed: ${formatBytes(expected.outputBytes)}`);
console.log(`SHA-256: ${expected.sha256}\n`);
console.table(
	results.map(result => ({
		Method: result.method,
		Time: `${(result.durationMs / 1000).toFixed(2)} s`,
		'Peak RSS': formatBytes(result.peakRssBytes)
	}))
);
console.log('Peak RSS is total process resident memory, including the Bun runtime.');
