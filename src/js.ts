export { BzipError, type BzipErrorCode, type BzipErrorDetails } from './errors.ts';
export { compress, createCompressionStream } from './compress.ts';
export { createDecompressionStream, decompress } from './decompress.ts';
export type { BlockSize, CompressOptions, DecompressionStreamOptions, DecompressOptions } from './types.ts';
