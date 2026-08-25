import { DecoderEngine } from './codec/decoder.ts';
import { concatChunks } from './internal/chunks.ts';
import { resolveDecompressionStreamOptions, resolveDecompressOptions } from './options.ts';
import type { DecompressionStreamOptions, DecompressOptions } from './types.ts';

export const decompress = (input: Uint8Array, options?: DecompressOptions): Uint8Array => {
	if (!(input instanceof Uint8Array)) throw new TypeError('Bzip2 input must be a Uint8Array');

	const chunks: Uint8Array[] = [];
	let outputLength = 0;
	const decoder = new DecoderEngine(resolveDecompressOptions(options));
	const emit = (chunk: Uint8Array) => {
		chunks.push(chunk);
		outputLength += chunk.byteLength;
	};

	decoder.push(input, emit);
	decoder.finish(emit);
	return concatChunks(chunks, outputLength);
};

export const createDecompressionStream = (
	options?: DecompressionStreamOptions
): TransformStream<Uint8Array, Uint8Array> => {
	const { yieldAfterMs, ...decoderOptions } = resolveDecompressionStreamOptions(options);
	const decoder = new DecoderEngine(decoderOptions);

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
