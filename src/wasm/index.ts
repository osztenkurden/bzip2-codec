import { DecoderEngine } from '../codec/decoder.ts';
import { createDecompressionFunctions } from '../internal/decompression.ts';
import { decodeNextBlock } from './decoder.ts';
import { WORKER_SOURCE } from './worker-source.ts';
import { createCompressionFunctions } from '../internal/compression.ts';
import { WasmBlockCollector } from './block-collector.ts';
import { WORKER_SOURCE as COMPRESSION_WORKER_SOURCE } from './compression-worker-source.ts';
import { WasmEncoderEngine } from './encoder.ts';

export { BzipError, type BzipErrorCode, type BzipErrorDetails } from '../errors.ts';
export const { compress, compressAsync, createCompressionStream } = createCompressionFunctions(
	(options, sink) => new WasmEncoderEngine(options, sink),
	{
		worker: COMPRESSION_WORKER_SOURCE ?? new URL('./compression-worker.ts', import.meta.url),
		createCollector: (blockSize, sink) => new WasmBlockCollector(blockSize, sink)
	}
);
export type {
	BlockSize,
	CompressOptions,
	CompressionStreamOptions,
	DecompressionStreamOptions,
	DecompressOptions,
	ExecutionOptions
} from '../types.ts';
export const { decompress, decompressAsync, createDecompressionStream } = createDecompressionFunctions(
	options => new DecoderEngine(options, decodeNextBlock),
	WORKER_SOURCE ?? new URL('./worker.ts', import.meta.url)
);
