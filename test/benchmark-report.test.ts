import assert from 'node:assert/strict';
import { test } from 'node:test';
import { median, REPORT_INTRO, updateCpuSection } from '../scripts/benchmark/report.ts';

test('benchmark report appends new CPUs and replaces matching CPUs in place', () => {
	let report = updateCpuSection(REPORT_INTRO, 'Apple M1', '## Apple M1\n\nold table');
	report = updateCpuSection(report, 'AMD Ryzen 7', '## AMD Ryzen 7\n\nAMD table');
	const amd = report.slice(report.indexOf('## AMD Ryzen 7'));
	report = updateCpuSection(report, 'Apple M1', '## Apple M1\n\nnew table');
	assert.ok(report.startsWith(REPORT_INTRO));
	assert.ok(!report.includes('old table'));
	assert.equal(report.match(/^## Apple M1$/gm)?.length, 1);
	assert.ok(report.indexOf('## Apple M1') < report.indexOf('## AMD Ryzen 7'));
	assert.equal(report.slice(report.indexOf('## AMD Ryzen 7')), amd);
	report = updateCpuSection(report, 'Intel CPU', '## Intel CPU\n\nIntel table');
	assert.ok(report.endsWith('## Intel CPU\n\nIntel table\n'));
});

test('CPU matching handles CRLF and case without matching a longer CPU name', () => {
	const report = '# Results\r\n\r\n## Apple M1 Pro\r\n\r\nkeep\r\n\r\n## APPLE M1\r\n\r\nold\r\n';
	const updated = updateCpuSection(report, 'Apple M1', '## Apple M1\n\nnew');
	assert.ok(updated.includes('## Apple M1 Pro\r\n\r\nkeep'));
	assert.ok(!updated.includes('old'));
	assert.ok(!updated.includes('## APPLE M1'));
});

test('median summarizes odd and even rounds without mutating their order', () => {
	const values = [30, 10, 20];
	assert.equal(median(values), 20);
	assert.deepEqual(values, [30, 10, 20]);
	assert.equal(median([40, 10, 30, 20]), 25);
});
