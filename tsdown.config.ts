import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WASM_BASE64 } from './src/wasm/bytes.ts';
import { WASM_BASE64 as ENCODER_WASM_BASE64 } from './src/wasm/encoder-bytes.ts';
import { fileURLToPath } from 'node:url';
import { defineConfig, Rolldown } from 'tsdown';

const workers = new Map(
	[
		['src/parallel/worker-source.ts', 'src/parallel/decompression-worker.ts'],
		['src/wasm/worker-source.ts', 'src/wasm/worker.ts'],
		['src/parallel/compression-worker-source.ts', 'src/parallel/compression-worker.ts'],
		['src/wasm/compression-worker-source.ts', 'src/wasm/compression-worker.ts']
	].map(([source, entry]) => [
		fileURLToPath(new URL(source!, import.meta.url)),
		fileURLToPath(new URL(entry!, import.meta.url))
	])
);

export default defineConfig({
	entry: { index: 'src/index.ts', js: 'src/js.ts', wasm: 'src/wasm/index.ts', cli: 'src/cli.ts' },
	dts: true,
	// Preserve purity hints for consumer bundlers; minifying here strips them.
	outputOptions: { comments: { annotation: true } },
	plugins: [
		{
			name: 'bzip2-codec:inline-worker',
			async buildStart() {
				for (const [file, embedded] of [
					['build.json', WASM_BASE64],
					['encoder-build.json', ENCODER_WASM_BASE64]
				]) {
					const manifestUrl = new URL(`./wasm/${file}`, import.meta.url);
					const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as {
						sha256: string;
						sourceHashes: Record<string, string>;
					};
					const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
					if (hash(Buffer.from(embedded!, 'base64')) !== manifest.sha256)
						throw new Error('WASM bytes do not match build.json; run bun run build:wasm');
					this.addWatchFile(fileURLToPath(manifestUrl));
					await Promise.all(
						Object.entries(manifest.sourceHashes).map(async ([file, expected]) => {
							const url = new URL(`./wasm/${file}`, import.meta.url);
							this.addWatchFile(fileURLToPath(url));
							if (hash(await readFile(url)) !== expected)
								throw new Error(`Stale WASM source ${file}; run bun run build:wasm`);
						})
					);
				}
			},
			async load(id) {
				const workerEntry = workers.get(id);
				if (workerEntry === undefined) return null;
				// Reuse the host's embedded WASM bytes; serialize them only when a worker starts.
				const wasmBytes = new Map<string, string>();
				const bundle = await Rolldown.rolldown({
					input: workerEntry,
					platform: 'browser',
					plugins: [
						{
							name: 'worker-wasm-bytes',
							load(id) {
								if (
									id !== fileURLToPath(new URL('./src/wasm/bytes.ts', import.meta.url)) &&
									id !== fileURLToPath(new URL('./src/wasm/encoder-bytes.ts', import.meta.url))
								)
									return null;
								const key = `__bzipWasm${wasmBytes.size}`;
								wasmBytes.set(id, key);
								return `export const WASM_BASE64 = globalThis.${key};`;
							}
						}
					]
				});
				try {
					const { output } = await bundle.generate({ format: 'iife', minify: true });
					const chunk = output[0];
					if (
						output.length !== 1 ||
						chunk?.type !== 'chunk' ||
						chunk.code.trim().length === 0 ||
						chunk.imports.length > 0 ||
						chunk.dynamicImports.length > 0
					) {
						throw new Error('The inline worker must be a single non-empty script without external imports');
					}
					for (const module of Object.keys(chunk.modules)) this.addWatchFile(module);
					if (wasmBytes.size === 0) return `export const WORKER_SOURCE = ${JSON.stringify(chunk.code)};`;
					const imports = [...wasmBytes]
						.map(([id, key]) => `import { WASM_BASE64 as ${key} } from ${JSON.stringify(id)};`)
						.join('\n');
					const prefix = [...wasmBytes.values()]
						.map(key => `${JSON.stringify(`globalThis.${key}=`)} + JSON.stringify(${key}) + ';'`)
						.join(' + ');
					return `${imports}\nexport const WORKER_SOURCE = () => ${prefix} + ${JSON.stringify(chunk.code)};`;
				} finally {
					await bundle.close();
				}
			}
		}
	]
});
