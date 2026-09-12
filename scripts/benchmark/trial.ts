import { usage } from './usage.ts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { spawnProcess } from './process.ts';

// Load the shared archive before timing each decoder.
const config = JSON.parse(await text(process.stdin)) as {
	inputPath: string;
	bundle: string;
	mode: string;
	concurrency: number | 'auto';
	timeoutMs: number;
};
const codec = config.mode === 'js' ? await import(pathToFileURL(config.bundle).href) : undefined;
const bytes = new Uint8Array(await readFile(config.inputPath));
const inputSha256 = createHash('sha256').update(bytes).digest('hex');
const controller = new AbortController();
let timedOut = false;
const timeout = setTimeout(() => {
	timedOut = true;
	controller.abort(new Error('Trial timed out'));
}, config.timeoutMs);
const chunks: Uint8Array[] = [];
let outputBytes = 0;
let offset = 0;
let native: ReturnType<typeof spawnProcess> | undefined;
const cpuStart = process.cpuUsage();
const started = performance.now();
try {
	const input = new ReadableStream<Uint8Array>({
		pull(sink) {
			if (offset === bytes.length) return sink.close();
			const end = Math.min(offset + 65536, bytes.length);
			sink.enqueue(bytes.subarray(offset, end));
			offset = end;
		}
	});
	const consume = async (stream: ReadableStream<Uint8Array>) => {
		await stream.pipeTo(
			new WritableStream<Uint8Array>({
				write(chunk) {
					outputBytes += chunk.length;
					chunks.push(chunk);
				}
			}),
			{ signal: controller.signal }
		);
	};
	let nativeUsage: unknown;
	if (config.mode === 'js') {
		await consume(
			input.pipeThrough(codec!.createDecompressionStream({ concurrency: config.concurrency }), {
				signal: controller.signal
			})
		);
	} else {
		// Feed the same preloaded bytes to native stdin with backpressure.
		const child = spawnProcess(
			config.mode === 'lbzip2'
				? [
						'lbzip2',
						'-d',
						'-c',
						'-n',
						String(config.concurrency === 'auto' ? navigator.hardwareConcurrency : config.concurrency)
					]
				: ['bzip2', '-d', '-c'],
			{
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe'
			}
		);
		native = child;
		const errors = new Response(child.stderr).text();
		const kill = () => {
			child.kill();
		};
		controller.signal.addEventListener('abort', kill, { once: true });
		try {
			await Promise.all([
				(async () => {
					try {
						for await (const chunk of input) {
							await child.stdin.write(chunk);
							await child.stdin.flush();
						}
						await child.stdin.end();
					} catch (error) {
						controller.abort(error);
						throw error;
					}
				})(),
				consume(child.stdout).catch(error => {
					controller.abort(error);
					throw error;
				}),
				(async () => {
					if ((await child.exited) !== 0) {
						controller.abort();
						throw new Error(`Native decoder failed: ${(await errors).slice(0, 500)}`);
					}
				})()
			]);
			nativeUsage = usage(child.resourceUsage());
			await errors;
		} finally {
			controller.signal.removeEventListener('abort', kill);
		}
	}
	const durationMs = performance.now() - started;
	const cpu = process.cpuUsage(cpuStart);
	// Validate outside the timed region, using retained output from this trial.
	const hash = createHash('sha256');
	for (const chunk of chunks) hash.update(chunk);
	console.log(
		JSON.stringify({
			durationMs,
			inputBytes: bytes.length,
			inputSha256,
			outputBytes,
			sha256: hash.digest('hex'),
			processCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
			nativeUsage
		})
	);
} catch (error) {
	console.error(
		JSON.stringify({
			phase: timedOut ? 'timeout' : 'decoder',
			inputBytes: bytes.length,
			outputBytes,
			durationMs: performance.now() - started,
			error: error instanceof Error ? error.message : 'Trial failed'
		})
	);
	process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	controller.abort();
	if (native && native.exitCode === null) {
		native.kill();
		await native.exited;
	}
}
