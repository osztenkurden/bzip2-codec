import type { DecoderEngine } from '../codec/decoder.ts';
import { ParallelDecoderEngine } from '../parallel/engine.ts';
import type { WorkerDefinition } from '../parallel/pool.ts';
import { concatChunks } from './chunks.ts';
import { transformBuffer } from './async-buffer.ts';
import { resolveDecompressionStreamOptions, resolveDecompressOptions } from '../options.ts';
import type { DecompressionStreamOptions, DecompressOptions, ResolvedDecompressOptions } from '../types.ts';

export const createDecompressionFunctions = (
	createDecoder: (options: ResolvedDecompressOptions) => DecoderEngine,
	worker?: WorkerDefinition
) => {
	const decompress = (input: Uint8Array, options?: DecompressOptions): Uint8Array => {
		if (!(input instanceof Uint8Array)) throw new TypeError('Bzip2 input must be a Uint8Array');

		const chunks: Uint8Array[] = [];
		let outputLength = 0;
		const decoder = createDecoder(resolveDecompressOptions(options));
		const emit = (chunk: Uint8Array) => {
			chunks.push(chunk);
			outputLength += chunk.byteLength;
		};

		decoder.push(input, emit);
		decoder.finish(emit);
		return concatChunks(chunks, outputLength);
	};

	const createDecompressionStream = (
		options?: DecompressionStreamOptions
	): TransformStream<Uint8Array, Uint8Array> => {
		const { yieldAfterMs, concurrency, ...decoderOptions } = resolveDecompressionStreamOptions(options);

		if (concurrency > 1) {
			let engine!: ParallelDecoderEngine;
			// `cancel` is a newer Transformer hook; the lib typings predate it.
			const transformer: Transformer<Uint8Array, Uint8Array> & { cancel(): void } = {
				start(controller) {
					engine = new ParallelDecoderEngine(
						decoderOptions,
						concurrency,
						output => controller.enqueue(output),
						{
							onError: error => controller.error(error),
							worker
						}
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

		const decoder = createDecoder(decoderOptions);

		if (yieldAfterMs !== undefined) {
			return new TransformStream<Uint8Array, Uint8Array>({
				async transform(chunk, controller) {
					await decoder.pushCooperatively(chunk, output => controller.enqueue(output), yieldAfterMs);
				},
				async flush(controller) {
					await decoder.finishCooperatively(output => controller.enqueue(output), yieldAfterMs);
				}
			});
		}

		return new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				decoder.push(chunk, output => controller.enqueue(output));
			},
			flush(controller) {
				decoder.finish(output => controller.enqueue(output));
			}
		});
	};

	const decompressAsync = (input: Uint8Array, options?: DecompressionStreamOptions): Promise<Uint8Array> =>
		transformBuffer(input, () => createDecompressionStream(options));
	return { decompress, decompressAsync, createDecompressionStream };
};
