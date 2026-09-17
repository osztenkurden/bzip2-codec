import { DecoderEngine } from '../codec/decoder.ts';
import { createDecompress, createDecompressionStreamFactory } from '../internal/decompression.ts';
import { decodeNextBlock } from './decoder.ts';
import { WORKER_SOURCE } from './worker-source.ts';
import { createCompress, createCompressionStreamFactory } from '../internal/compression.ts';
import { WasmBlockCollector } from './block-collector.ts';
import { WORKER_SOURCE as COMPRESSION_WORKER_SOURCE } from './compression-worker-source.ts';
import { WasmEncoderEngine } from './encoder.ts';

import { transformBuffer } from '../internal/async-buffer.ts';
import type { CompressionStreamOptions, DecompressionStreamOptions } from '../types.ts';

export { BzipError, type BzipErrorCode, type BzipErrorDetails } from '../errors.ts';
export const compress = /* @__PURE__ */ createCompress((options, sink) => new WasmEncoderEngine(options, sink));
export const createCompressionStream = /* @__PURE__ */ createCompressionStreamFactory(
	(options, sink) => new WasmEncoderEngine(options, sink),
	{
		worker: COMPRESSION_WORKER_SOURCE,
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
export const decompress = /* @__PURE__ */ createDecompress(options => new DecoderEngine(options, decodeNextBlock));
export const createDecompressionStream = /* @__PURE__ */ createDecompressionStreamFactory(
	options => new DecoderEngine(options, decodeNextBlock),
	WORKER_SOURCE
);
export const compressAsync = (input: Uint8Array, options?: CompressionStreamOptions): Promise<Uint8Array> =>
	transformBuffer(input, () => createCompressionStream(options));
export const decompressAsync = (input: Uint8Array, options?: DecompressionStreamOptions): Promise<Uint8Array> =>
	transformBuffer(input, () => createDecompressionStream(options));
