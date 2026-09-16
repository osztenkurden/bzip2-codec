export { BzipError, type BzipErrorCode, type BzipErrorDetails } from './errors.ts';
export { compress, compressAsync, createCompressionStream } from './compress.ts';
export { createDecompressionStream, decompress, decompressAsync } from './decompress.ts';
export type {
	BlockSize,
	CompressOptions,
	CompressionStreamOptions,
	DecompressionStreamOptions,
	DecompressOptions,
	ExecutionOptions
} from './types.ts';
