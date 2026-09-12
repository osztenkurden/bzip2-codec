import { usage } from './usage.ts';
import { fetchIPv4 } from './fetch-ipv4.ts';

// URL arrives through stdin so it is absent from process arguments and saved metadata.
const config = JSON.parse(await Bun.stdin.text()) as {
	url: string;
	bundle: string;
	mode: string;
	concurrency: number | 'auto';
	timeoutMs: number;
};
const codec = config.mode === 'js' ? await import(config.bundle) : undefined;
const controller = new AbortController();
let timedOut = false;
let downloadError: unknown;
const timeout = setTimeout(() => {
	timedOut = true;
	controller.abort(new Error('Trial timed out'));
}, config.timeoutMs);
const hash = new Bun.CryptoHasher('sha256');
const inputHash = new Bun.CryptoHasher('sha256');
let inputBytes = 0,
	outputBytes = 0,
	inputChunks = 0;
let firstInputMs: number | undefined, inputEndMs: number | undefined, firstOutputMs: number | undefined;
let inputHashMs = 0,
	outputHashMs = 0;
let native: ReturnType<typeof Bun.spawn> | undefined;
const cpuStart = process.cpuUsage();
const started = performance.now();
try {
	const response = await fetchIPv4(config.url, controller.signal).catch(error => {
		if (!controller.signal.aborted) downloadError = error;
		throw error;
	});
	const headersMs = performance.now() - started;
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}; redirects are intentionally not followed`);
	}
	const encoding = response.headers.get('content-encoding');
	if (encoding && encoding !== 'identity') {
		await response.body.cancel();
		throw new Error('Server ignored Accept-Encoding: identity');
	}
	const expectedLength = response.headers.get('content-length');
	const reader = response.body.getReader();
	const input = new ReadableStream<Uint8Array>({
		async pull(sink) {
			let item: Awaited<ReturnType<typeof reader.read>>;
			try {
				item = await reader.read();
			} catch (error) {
				if (!controller.signal.aborted) downloadError = error;
				throw error;
			}
			if (item.done) {
				inputEndMs = performance.now() - started;
				if (expectedLength !== null && Number(expectedLength) !== inputBytes) {
					const error = new Error('Content-Length mismatch');
					if (inputBytes < Number(expectedLength)) downloadError = error;
					throw error;
				}
				sink.close();
				return;
			}
			const chunk = item.value;
			firstInputMs ??= performance.now() - started;
			inputBytes += chunk.length;
			inputChunks++;
			const before = performance.now();
			inputHash.update(chunk);
			inputHashMs += performance.now() - before;
			sink.enqueue(chunk);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
	const consume = async (stream: ReadableStream<Uint8Array>) => {
		await stream.pipeTo(
			new WritableStream<Uint8Array>({
				write(chunk) {
					firstOutputMs ??= performance.now() - started;
					outputBytes += chunk.length;
					const before = performance.now();
					hash.update(chunk);
					outputHashMs += performance.now() - before;
				}
			}),
			{ signal: controller.signal }
		);
	};
	let nativeUsage: unknown;
	if (config.mode === 'download') {
		await input.pipeTo(new WritableStream({ write() {} }), { signal: controller.signal });
	} else if (config.mode === 'js') {
		await consume(
			input.pipeThrough(codec!.createDecompressionStream({ concurrency: config.concurrency, yieldAfterMs: 32 }), {
				signal: controller.signal
			})
		);
	} else {
		// Native decoder receives the same live response, through stdin, with backpressure.
		const child = Bun.spawn(
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
							child.stdin.write(chunk);
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
	console.log(
		JSON.stringify({
			durationMs,
			headersMs,
			firstInputMs,
			inputEndMs,
			firstOutputMs,
			tailAfterInputMs: inputEndMs === undefined ? undefined : durationMs - inputEndMs,
			inputBytes,
			inputChunks,
			inputSha256: inputHash.digest('hex'),
			outputBytes,
			sha256: config.mode === 'download' ? undefined : hash.digest('hex'),
			inputHashMs,
			outputHashMs,
			processCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
			nativeUsage
		})
	);
} catch (error) {
	const cause = downloadError ?? error;
	// Avoid printing signed URLs in fetch errors or stack traces.
	console.error(
		JSON.stringify({
			retryable: downloadError !== undefined && !timedOut,
			phase: timedOut ? 'timeout' : downloadError !== undefined ? 'download' : 'decoder-or-http',
			inputBytes,
			outputBytes,
			durationMs: performance.now() - started,
			error:
				cause instanceof Error
					? cause.message.replaceAll(config.url, '<url>').replace(/https?:\/\/\S+/g, '<url>')
					: 'Trial failed'
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
