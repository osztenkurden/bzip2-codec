import type { CompressionStreamOptions, DecompressionStreamOptions, ExecutionOptions } from '../src/types.ts';
import { compressAsync, decompressAsync } from '../src/index.ts';

// Checked by `bun run typecheck`; no runtime calls or workers are needed.
const defaults: DecompressionStreamOptions = {};
const cooperative: DecompressionStreamOptions = { yieldAfterMs: 0, maxOutputBytes: 1024 };
const workers: DecompressionStreamOptions = { concurrency: 'auto', outputChunkSize: 128 };
// @ts-expect-error Cooperative and worker scheduling are mutually exclusive, even with one worker.
const conflicting: DecompressionStreamOptions = { yieldAfterMs: 0, concurrency: 1 };
const reused = { yieldAfterMs: 8, concurrency: 2 };
// @ts-expect-error Reused objects must also obey the scheduling union.
const conflictingVariable: ExecutionOptions = reused;
void [defaults, cooperative, workers, conflicting, conflictingVariable];

const compression: CompressionStreamOptions = { yieldAfterMs: 8, blockSize: 1 };
// @ts-expect-error Compression uses the same exclusive scheduling union.
const conflictCompression: CompressionStreamOptions = { yieldAfterMs: 0, concurrency: 'auto' };
const compressSignature: (input: Uint8Array, options?: CompressionStreamOptions) => Promise<Uint8Array> = compressAsync;
const decompressSignature: (input: Uint8Array, options?: DecompressionStreamOptions) => Promise<Uint8Array> =
	decompressAsync;
void [compression, conflictCompression, compressSignature, decompressSignature];
