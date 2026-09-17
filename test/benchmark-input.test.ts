import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { prepareCompressionInput as prepareInput } from '../scripts/benchmark/input.ts';

const archive = Buffer.from('QlpoOTFBWSZTWeopNX0AAAJTgAAQQAAEACJgDAAgADEGTEEBkeoEPEnfEAvF3JFOFCQ6ik1fQA==', 'base64');
const expected = 'This is a test\n';
const fixtureUrl = 'https://fixtures.invalid/replay.bz2';
const archiveName = 'replay.bz2';
const rawName = 'replay';

// Unit tests use inline archive bytes only. A missing fixture must fail rather
// than falling back to a real download, and benchmark progress logs stay quiet.
const prepareCompressionInput = (options: Parameters<typeof prepareInput>[0]) =>
	prepareInput({
		url: fixtureUrl,
		fetchArchive: async () => {
			throw new Error('Unexpected fetch in benchmark input test');
		},
		log: () => {},
		...options
	});

const directory = async (t: TestContext) => {
	const path = await mkdtemp(join(tmpdir(), 'bzip-input-test-'));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
};

test('explicit compression input takes precedence and is not decompressed or deleted', async t => {
	const repository = await directory(t);
	await writeFile(join(repository, rawName), 'default');
	const source = join(repository, 'explicit.bz2');
	await writeFile(source, archive);
	const input = await prepareCompressionInput({ repository, source, timeoutMs: 5000 });
	assert.equal(input.inputPath, source);
	assert.deepEqual(await readFile(input.inputPath), archive);
	await input.cleanup();
	assert.deepEqual(await readFile(source), archive);
	await assert.rejects(
		prepareCompressionInput({ repository, source: join(repository, 'missing'), timeoutMs: 5000 }),
		/Input file not found/
	);
});

test('compression defaults prefer the local raw replay over its archive', async t => {
	const repository = await directory(t);
	await writeFile(join(repository, rawName), expected);
	await writeFile(join(repository, archiveName), 'invalid archive');
	const input = await prepareCompressionInput({ repository, timeoutMs: 5000 });
	assert.equal(input.inputPath, join(repository, rawName));
	await input.cleanup();
	assert.equal(await readFile(input.inputPath, 'utf8'), expected);
});

test('compression defaults unpack a local archive into disposable input', async t => {
	const repository = await directory(t);
	await writeFile(join(repository, archiveName), archive);
	const input = await prepareCompressionInput({ repository, timeoutMs: 5000 });
	t.after(input.cleanup);
	assert.equal(input.source, join(repository, archiveName));
	assert.equal(await readFile(input.inputPath, 'utf8'), expected);
	await input.cleanup();
	await assert.rejects(stat(input.inputPath), { code: 'ENOENT' });
	assert.deepEqual(await readFile(join(repository, archiveName)), archive);
});

test('compression defaults unpack a mocked response when no local input exists', async t => {
	const repository = await directory(t);
	let requests = 0;
	const input = await prepareCompressionInput({
		repository,
		timeoutMs: 5000,
		fetchArchive: async (url, signal) => {
			requests++;
			assert.equal(url, fixtureUrl);
			assert.equal(signal.aborted, false);
			return new Response(archive, { headers: { 'Content-Length': String(archive.length) } });
		}
	});
	t.after(input.cleanup);
	assert.equal(requests, 1);
	assert.equal(input.source, fixtureUrl);
	assert.equal(await readFile(input.inputPath, 'utf8'), expected);
	await input.cleanup();
	await assert.rejects(stat(input.inputPath), { code: 'ENOENT' });
});

test('compression input preparation rejects invalid archives and HTTP errors', async t => {
	const repository = await directory(t);
	await writeFile(join(repository, archiveName), 'invalid archive');
	await assert.rejects(prepareCompressionInput({ repository, timeoutMs: 5000 }), { code: 'INVALID_MAGIC' });
	assert.equal(await readFile(join(repository, archiveName), 'utf8'), 'invalid archive');
	await rm(join(repository, archiveName));
	await assert.rejects(
		prepareCompressionInput({
			repository,
			timeoutMs: 5000,
			fetchArchive: async () => new Response(null, { status: 503 })
		}),
		/HTTP 503/
	);
});

test('compression input preparation times out a mocked request', async t => {
	const repository = await directory(t);
	let aborted = false;
	await assert.rejects(
		prepareCompressionInput({
			repository,
			timeoutMs: 50,
			fetchArchive: (_, signal) =>
				new Promise<Response>((resolve, reject) => {
					const reply = setTimeout(() => resolve(new Response(archive)), 1000);
					const abort = () => {
						aborted = true;
						clearTimeout(reply);
						reject(signal.reason);
					};
					if (signal.aborted) abort();
					else signal.addEventListener('abort', abort, { once: true });
				})
		})
	);
	assert.equal(aborted, true);
});
