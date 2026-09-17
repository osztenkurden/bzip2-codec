import { EncoderEngine, BlockCollector } from './codec/encoder.ts';
import { WORKER_SOURCE } from './parallel/compression-worker-source.ts';
import { createCompressionFunctions } from './internal/compression.ts';

export const { compress, compressAsync, createCompressionStream } = createCompressionFunctions(
	(options, sink) => new EncoderEngine(options, sink),
	{
		worker: WORKER_SOURCE ?? new URL('./parallel/compression-worker.ts', import.meta.url),
		createCollector: (blockSize, sink) =>
			new BlockCollector(blockSize, (bytes, crc) => sink({ bytes: bytes.slice(), crc }))
	}
);
