import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const { createDecompressionStream, decompress }: typeof import('../src/index.ts') = await import(
	process.env.BZIP_BENCHMARK_MODULE ?? '../src/index.ts'
);

// Compression, input generation, and output verification are outside the timed region.
const runs = Number(process.env.BZIP_BENCHMARK_RUNS ?? 7);
if (!Number.isInteger(runs) || runs < 1) throw new RangeError('BZIP_BENCHMARK_RUNS must be positive');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const native = (input: Uint8Array, args: string[]) => {
	const result = spawnSync('bzip2', args, { input, maxBuffer: 256 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.toString());
	return result.stdout;
};
const fixtures: { name: string; compressed: Uint8Array; expected: string; size: number }[] = [];
const paths = process.argv.slice(2).filter(path => path !== '--');
if (paths.length > 0) {
	for (const path of paths) {
		const compressed = readFileSync(path);
		const reference = spawn('bzip2', ['-dc', '--', path], { stdio: ['ignore', 'pipe', 'inherit'] });
		const digest = createHash('sha256');
		let size = 0;
		const [, [status]] = await Promise.all([
			(async () => {
				for await (const chunk of reference.stdout) {
					digest.update(chunk);
					size += chunk.length;
				}
			})(),
			once(reference, 'close')
		]);
		if (status !== 0) throw new Error(`Reference bzip2 exited with status ${status}`);
		fixtures.push({ name: path, compressed, expected: digest.digest('hex'), size });
	}
} else {
	for (const name of ['text', 'binary', 'random', 'runs']) {
		const input = new Uint8Array(4 * 1024 * 1024);
		let state = 0x12345678;
		const text = new TextEncoder().encode(
			'The quick brown fox jumps over the lazy dog. Decompression benchmark: bytes, blocks, streams.\n'
		);
		for (let i = 0; i < input.length; i++) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			input[i] =
				name === 'random'
					? state & 255
					: name === 'runs'
						? (i >>> 16) & 255
						: name === 'binary'
							? i % 16 < 12
								? (i >>> 4) & 255
								: state & 255
							: i % 97 < text.length
								? text[i % 97]!
								: 32 + ((state >>> 0) % 95);
		}
		fixtures.push({ name, compressed: native(input, ['-9c']), expected: hash(input), size: input.length });
	}
}

console.log(
	`Runtime ${process.version}${'Bun' in globalThis ? ' (Bun)' : ''}; ${runs} measured runs, 2 warmups; MiB/s`
);
for (const fixture of fixtures) {
	for (const mode of ['sync', 'stream-64KiB']) {
		const times: number[] = [];
		for (let run = -2; run < runs; run++) {
			const chunks: Uint8Array[] = [];
			const start = performance.now();
			if (mode === 'sync') chunks.push(decompress(fixture.compressed));
			else {
				let offset = 0;
				const source = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (offset >= fixture.compressed.length) controller.close();
						else {
							controller.enqueue(fixture.compressed.subarray(offset, offset + 65536));
							offset += 65536;
						}
					}
				});
				for await (const chunk of source.pipeThrough(createDecompressionStream())) chunks.push(chunk);
			}
			const elapsed = performance.now() - start;
			const digest = createHash('sha256');
			let size = 0;
			for (const chunk of chunks) {
				digest.update(chunk);
				size += chunk.length;
			}
			assert.equal(size, fixture.size);
			assert.equal(digest.digest('hex'), fixture.expected);
			if (run >= 0) times.push(elapsed);
		}
		times.sort((a, b) => a - b);
		const median = times[Math.floor(times.length / 2)]!;
		console.log(
			JSON.stringify({
				fixture: fixture.name,
				mode,
				bytes: fixture.size,
				compressedBytes: fixture.compressed.length,
				medianMs: +median.toFixed(2),
				mibPerSecond: +(fixture.size / 1048576 / (median / 1000)).toFixed(2)
			})
		);
	}
}
