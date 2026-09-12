import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browser = Bun.env.BZIP_BROWSER ?? Bun.which('chromium') ?? Bun.which('google-chrome');
if (!browser) throw new Error('Install Chromium or set BZIP_BROWSER to its executable path');

// Re-bundle the published entry as a browser app; serve no worker or decoder assets.
const bundle = await Bun.build({
	entrypoints: [new URL('./browser/parallel.js', import.meta.url).pathname],
	target: 'browser',
	minify: true
});
if (!bundle.success || bundle.outputs.length !== 1) throw new Error(`Browser bundle failed: ${bundle.logs}`);
const script = await bundle.outputs[0]!.text();
const profile = await mkdtemp(join(tmpdir(), 'bzip-browser-'));
let report!: (result: { ok: boolean; error?: string; workers?: number; bytes?: number }) => void;
const result = new Promise<Parameters<typeof report>[0]>(resolve => {
	report = resolve;
});
const unexpected: string[] = [];
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === '/')
			return new Response('<script type="module" src="/app.js"></script>', {
				headers: {
					'Content-Type': 'text/html',
					'Content-Security-Policy': "default-src 'self'; worker-src blob:"
				}
			});
		if (path === '/app.js') return new Response(script, { headers: { 'Content-Type': 'text/javascript' } });
		if (path === '/result' && request.method === 'POST') {
			report(await request.json());
			return new Response('ok');
		}
		if (path !== '/favicon.ico') unexpected.push(path);
		return new Response('Not found', { status: 404 });
	}
});
const child = Bun.spawn(
	[
		browser,
		'--headless',
		'--no-sandbox',
		'--disable-dev-shm-usage',
		'--disable-gpu',
		`--user-data-dir=${profile}`,
		`http://127.0.0.1:${server.port}/`
	],
	{ stdout: 'ignore', stderr: 'pipe' }
);
const stderr = new Response(child.stderr).text();
let timer: ReturnType<typeof setTimeout> | undefined;
try {
	const outcome = await Promise.race([
		result,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('Browser test timed out')), 30_000);
		}),
		child.exited.then(async code => {
			throw new Error(`Browser exited (${code}): ${await stderr}`);
		})
	]);
	if (!outcome.ok) throw new Error(outcome.error);
	if (unexpected.length) throw new Error(`Unexpected asset requests: ${unexpected.join(', ')}`);
	console.log(
		`Browser bundle passed: ${outcome.bytes} bytes, ${outcome.workers} Blob workers, no worker asset requests`
	);
} finally {
	clearTimeout(timer);
	child.kill();
	await child.exited;
	server.stop(true);
	await rm(profile, { recursive: true, force: true });
}
