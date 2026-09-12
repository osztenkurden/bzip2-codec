import { DecoderEngine } from './codec/decoder.ts';
import { createDecompressionFunctions } from './internal/decompression.ts';

export const { decompress, createDecompressionStream } = createDecompressionFunctions(
	options => new DecoderEngine(options)
);
