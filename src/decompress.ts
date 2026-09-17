import { DecoderEngine } from './codec/decoder.ts';
import { createDecompressionFunctions } from './internal/decompression.ts';

export const { decompress, decompressAsync, createDecompressionStream } = createDecompressionFunctions(
	options => new DecoderEngine(options)
);
