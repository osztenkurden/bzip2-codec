import { concatChunks } from './chunks.ts';
import { resolveCompressOptions, resolveCompressionStreamOptions } from '../options.ts';
import type { CompressOptions, CompressionStreamOptions, ResolvedCompressOptions } from '../types.ts';
import type { ByteSink } from './bit-writer.ts';
import { ParallelEncoderEngine, type CompressionBackend } from '../parallel/compression-engine.ts';
import { INPUT_SLICE_SIZE, transformBuffer } from './async-buffer.ts';

export interface CompressionEngine {
	push(chunk: Uint8Array): void;
	finish(): void;
	close?(): void;
}

export const createCompressionFunctions = (
	createEncoder: (options: ResolvedCompressOptions, sink: ByteSink) => CompressionEngine,
	parallel?: CompressionBackend
) => {
	const compress = (input: Uint8Array, options?: CompressOptions): Uint8Array => {
		if (!(input instanceof Uint8Array)) throw new TypeError('Bzip2 input must be a Uint8Array');
		const chunks: Uint8Array[] = [];
		let outputLength = 0;
		const encoder = createEncoder(resolveCompressOptions(options), chunk => {
			chunks.push(chunk);
			outputLength += chunk.byteLength;
		});
		try {
			encoder.push(input);
			encoder.finish();
			return concatChunks(chunks, outputLength);
		} finally {
			encoder.close?.();
		}
	};
	const createCompressionStream = (options?: CompressionStreamOptions): TransformStream<Uint8Array, Uint8Array> => {
		const { yieldAfterMs, concurrency, ...resolved } = resolveCompressionStreamOptions(options);
		if (concurrency > 1) {
			if (!parallel) throw new Error('Compression worker backend is unavailable');
			let engine: ParallelEncoderEngine;
			const transformer: Transformer<Uint8Array, Uint8Array> & { cancel(): void } = {
				start(controller) {
					engine = new ParallelEncoderEngine(
						resolved,
						concurrency,
						bytes => controller.enqueue(bytes),
						parallel,
						error => controller.error(error)
					);
				},
				transform(chunk) {
					return engine.push(chunk);
				},
				flush() {
					return engine.finish();
				},
				cancel() {
					engine.close();
				}
			};
			return new TransformStream<Uint8Array, Uint8Array>(transformer);
		}
		let encoder: CompressionEngine;
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			encoder.close?.();
		};
		// Accumulate work across transform calls without charging downstream idle time.
		let workMs = 0;
		const checkpoint = (started: number): Promise<void> | undefined => {
			workMs += performance.now() - started;
			if (workMs < yieldAfterMs!) return;
			workMs = 0;
			return new Promise(resolve => setTimeout(resolve, 0));
		};
		const pushCooperatively = async (chunk: Uint8Array): Promise<void> => {
			try {
				if (!(chunk instanceof Uint8Array)) throw new TypeError('Bzip2 input chunks must be Uint8Array values');
				// A 64 KiB raw slice can finish at most one block, including RLE expansion.
				for (let offset = 0; offset < chunk.length && !closed; offset += INPUT_SLICE_SIZE) {
					const started = performance.now();
					encoder.push(chunk.subarray(offset, offset + INPUT_SLICE_SIZE));
					const pause = checkpoint(started);
					if (pause) await pause;
				}
			} catch (error) {
				close();
				throw error;
			}
		};
		const finishCooperatively = async (): Promise<void> => {
			try {
				if (closed) return;
				const started = performance.now();
				encoder.finish();
				const pause = checkpoint(started);
				if (pause) await pause;
			} finally {
				close();
			}
		};
		const transformer: Transformer<Uint8Array, Uint8Array> & { cancel(): void } = {
			start(controller) {
				encoder = createEncoder(resolved, chunk => controller.enqueue(chunk));
			},
			transform(chunk) {
				if (yieldAfterMs !== undefined) return pushCooperatively(chunk);
				try {
					encoder.push(chunk);
				} catch (error) {
					close();
					throw error;
				}
			},
			flush() {
				if (yieldAfterMs !== undefined) return finishCooperatively();
				try {
					encoder.finish();
				} finally {
					close();
				}
			},
			cancel() {
				close();
			}
		};
		return new TransformStream<Uint8Array, Uint8Array>(transformer);
	};
	const compressAsync = (input: Uint8Array, options?: CompressionStreamOptions): Promise<Uint8Array> =>
		transformBuffer(input, () => createCompressionStream(options));
	return { compress, compressAsync, createCompressionStream };
};
