import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DEFAULT_REPLAY_URL, prepareCompressionInput } from '../scripts/benchmark/input.ts';

const archive = Buffer.from('QlpoOTFBWSZTWeopNX0AAAJTgAAQQAAEACJgDAAgADEGTEEBkeoEPEnfEAvF3JFOFCQ6ik1fQA==', 'base64');
const expected = 'This is a test\n';
const archiveName = basename(new URL(DEFAULT_REPLAY_URL).pathname);
const rawName = archiveName.slice(0, -4);

const directory = async (t: TestContext) => {
	const path = await mkdtemp(join(tmpdir(), 'bzip-input-test-'));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
};

const serve = async (t: TestContext, handler: RequestListener) => {
	const server = createServer(handler);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	t.after(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close(error => (error ? reject(error) : resolve()));
			server.closeAllConnections();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	return `http://127.0.0.1:${address.port}/replay.bz2`;
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

test('compression defaults download and unpack when no local input exists', async t => {
	const repository = await directory(t);
	let requests = 0;
	const url = await serve(t, (request, response) => {
		requests++;
		assert.equal(request.headers['accept-encoding'], 'identity');
		response.writeHead(200, { 'Content-Length': archive.length });
		response.end(archive);
	});
	const input = await prepareCompressionInput({ repository, url, timeoutMs: 5000 });
	t.after(input.cleanup);
	assert.equal(requests, 1);
	assert.equal(input.source, url);
	assert.equal(await readFile(input.inputPath, 'utf8'), expected);
	await input.cleanup();
	await assert.rejects(stat(input.inputPath), { code: 'ENOENT' });
});

test('compression input preparation rejects invalid archives and HTTP errors', async t => {
	const repository = await directory(t);
	await writeFile(join(repository, archiveName), 'invalid archive');
	await assert.rejects(prepareCompressionInput({ repository, timeoutMs: 5000 }));
	assert.equal(await readFile(join(repository, archiveName), 'utf8'), 'invalid archive');
	const url = await serve(t, (_, response) => {
		response.writeHead(503);
		response.end();
	});
	await assert.rejects(prepareCompressionInput({ repository, url, timeoutMs: 5000 }), /HTTP 503/);
});

test('compression input preparation times out a stalled download', async t => {
	const repository = await directory(t);
	const url = await serve(t, (_, response) => {
		response.writeHead(200, { 'Content-Length': archive.length });
		response.write(archive.subarray(0, 8));
	});
	await assert.rejects(prepareCompressionInput({ repository, url, timeoutMs: 50 }));
});
