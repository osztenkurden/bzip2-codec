import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type * as Codec from '../src/js.ts';

// A bounded real-input sample for CPU profiles and quick optimization trials.
// bun --cpu-prof-md scripts/profile-compression.ts input [MiB] [rounds] [module] [sync|cooperative|auto|worker count]
const codec: typeof Codec = await import(pathToFileURL(resolve(process.argv[5] ?? 'src/js.ts')).href);
const execution = process.argv[6] ?? 'sync';
const file = await open(process.argv[2]!);
const input = new Uint8Array(Number(process.argv[3] ?? 16) * 1024 * 1024);
const { bytesRead } = await file.read(input);
await file.close();
for (let round = 0; round < Number(process.argv[4] ?? 3); round++) {
	const start = performance.now();
	let lastTick = start,
		maxTickGapMs = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxTickGapMs = Math.max(maxTickGapMs, now - lastTick);
		lastTick = now;
	}, 1);
	const cpu = process.cpuUsage();
	const output =
		execution === 'sync'
			? codec.compress(input.subarray(0, bytesRead))
			: await codec.compressAsync(
					input.subarray(0, bytesRead),
					execution === 'cooperative'
						? { yieldAfterMs: 8 }
						: { concurrency: execution === 'auto' ? 'auto' : Number(execution) }
				);
	const ms = performance.now() - start;
	const cpuUsage = process.cpuUsage(cpu);
	await new Promise(resolve => setTimeout(resolve, 2));
	clearInterval(timer);
	console.log(
		JSON.stringify({
			round,
			execution,
			ms,
			input: bytesRead,
			output: output.length,
			maxTickGapMs,
			cpuUsage,
			maxRssKiB: process.resourceUsage().maxRSS
		})
	);
}
