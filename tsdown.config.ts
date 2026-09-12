import { fileURLToPath } from 'node:url';
import { defineConfig, Rolldown } from 'tsdown';

const workerSource = fileURLToPath(new URL('./src/parallel/worker-source.ts', import.meta.url));
const workerEntry = fileURLToPath(new URL('./src/parallel/decompression-worker.ts', import.meta.url));

export default defineConfig({
	entry: 'src/index.ts',
	dts: true,
	plugins: [
		{
			name: 'bzip2-codec:inline-worker',
			async load(id) {
				if (id !== workerSource) return null;
				const bundle = await Rolldown.rolldown({ input: workerEntry, platform: 'browser' });
				try {
					const { output } = await bundle.generate({ format: 'iife', minify: true });
					const chunk = output[0];
					if (
						output.length !== 1 ||
						chunk?.type !== 'chunk' ||
						chunk.imports.length > 0 ||
						chunk.dynamicImports.length > 0
					) {
						throw new Error('The inline worker must be a single script without external imports');
					}
					for (const module of Object.keys(chunk.modules)) this.addWatchFile(module);
					return `export const WORKER_SOURCE = ${JSON.stringify(chunk.code)};`;
				} finally {
					await bundle.close();
				}
			}
		}
	]
});
