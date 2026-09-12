import { DecoderEngine } from '../codec/decoder.ts';
import { createDecompressionFunctions } from '../internal/decompression.ts';
import { decodeNextBlock } from './decoder.ts';
import { WORKER_SOURCE } from './worker-source.ts';

export { BzipError, type BzipErrorCode, type BzipErrorDetails } from '../errors.ts';
export { compress, createCompressionStream } from '../compress.ts';
export type { BlockSize, CompressOptions, DecompressionStreamOptions, DecompressOptions } from '../types.ts';
export const { decompress, createDecompressionStream } = createDecompressionFunctions(
	options => new DecoderEngine(options, decodeNextBlock),
	WORKER_SOURCE ?? new URL('./worker.ts', import.meta.url)
);
