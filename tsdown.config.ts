import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		// The worker must sit next to index.mjs; see the worker URL in src/parallel/pool.ts.
		'decompression-worker': 'src/parallel/decompression-worker.ts'
	},
	dts: true,
	plugins: [
		{
			name: 'bzip2-codec:worker-url',
			// Source references the .ts worker so it runs unbundled; the build ships an .mjs sibling.
			renderChunk(code: string) {
				return code.includes('./decompression-worker.ts')
					? { code: code.replaceAll('./decompression-worker.ts', './decompression-worker.mjs'), map: null }
					: null;
			}
		}
	]
});
