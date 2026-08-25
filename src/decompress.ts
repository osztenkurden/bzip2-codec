import { DecoderEngine } from './codec/decoder.ts';
import { concatChunks } from './internal/chunks.ts';
import { resolveDecompressOptions } from './options.ts';
import type { DecompressOptions } from './types.ts';

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

export const createDecompressionStream = (options?: DecompressOptions): TransformStream<Uint8Array, Uint8Array> => {
	const decoder = new DecoderEngine(resolveDecompressOptions(options));

	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			decoder.push(chunk, output => controller.enqueue(output));
		},
		flush(controller) {
			decoder.finish(output => controller.enqueue(output));
		}
	});
};
