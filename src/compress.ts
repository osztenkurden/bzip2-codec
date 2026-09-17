import { EncoderEngine, BlockCollector } from './codec/encoder.ts';
import { WORKER_SOURCE } from './parallel/compression-worker-source.ts';
import { createCompress, createCompressionStreamFactory } from './internal/compression.ts';
import { transformBuffer } from './internal/async-buffer.ts';
import type { CompressionStreamOptions } from './types.ts';

export const compress = /* @__PURE__ */ createCompress((options, sink) => new EncoderEngine(options, sink));
export const createCompressionStream = /* @__PURE__ */ createCompressionStreamFactory(
	(options, sink) => new EncoderEngine(options, sink),
	{
		worker: WORKER_SOURCE,
		createCollector: (blockSize, sink) =>
			new BlockCollector(blockSize, (bytes, crc) => sink({ bytes: bytes.slice(), crc }))
	}
);
export const compressAsync = (input: Uint8Array, options?: CompressionStreamOptions): Promise<Uint8Array> =>
	transformBuffer(input, () => createCompressionStream(options));
