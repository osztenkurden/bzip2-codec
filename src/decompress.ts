import { DecoderEngine } from './codec/decoder.ts';
import { createDecompress, createDecompressionStreamFactory } from './internal/decompression.ts';
import { WORKER_SOURCE } from './parallel/worker-source.ts';
import { transformBuffer } from './internal/async-buffer.ts';
import type { DecompressionStreamOptions } from './types.ts';

export const decompress = /* @__PURE__ */ createDecompress(options => new DecoderEngine(options));
export const createDecompressionStream = /* @__PURE__ */ createDecompressionStreamFactory(
	options => new DecoderEngine(options),
	WORKER_SOURCE
);
export const decompressAsync = (input: Uint8Array, options?: DecompressionStreamOptions): Promise<Uint8Array> =>
	transformBuffer(input, () => createDecompressionStream(options));
