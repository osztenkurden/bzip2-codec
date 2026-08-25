import { EncoderEngine } from './codec/encoder.ts';
import { concatChunks } from './internal/chunks.ts';
import { resolveCompressOptions } from './options.ts';
import type { CompressOptions } from './types.ts';

export const compress = (input: Uint8Array, options?: CompressOptions): Uint8Array => {
	if (!(input instanceof Uint8Array)) throw new TypeError('Bzip2 input must be a Uint8Array');

	const chunks: Uint8Array[] = [];
	let outputLength = 0;
	const encoder = new EncoderEngine(resolveCompressOptions(options), chunk => {
		chunks.push(chunk);
		outputLength += chunk.byteLength;
	});

	encoder.push(input);
	encoder.finish();
	return concatChunks(chunks, outputLength);
};

export const createCompressionStream = (options?: CompressOptions): TransformStream<Uint8Array, Uint8Array> => {
	const resolvedOptions = resolveCompressOptions(options);
	let encoder: EncoderEngine;

	return new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			encoder = new EncoderEngine(resolvedOptions, chunk => controller.enqueue(chunk));
		},
		transform(chunk) {
			encoder.push(chunk);
		},
		flush() {
			encoder.finish();
		}
	});
};
