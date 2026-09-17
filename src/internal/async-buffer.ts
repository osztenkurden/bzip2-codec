import { concatChunks } from './chunks.ts';

// Keep stream input bounded even when the caller supplies an entire archive.
export const INPUT_SLICE_SIZE = 65536;

export const transformBuffer = async (
	input: Uint8Array,
	createStream: () => TransformStream<Uint8Array, Uint8Array>
): Promise<Uint8Array> => {
	if (!(input instanceof Uint8Array)) throw new TypeError('Bzip2 input must be a Uint8Array');
	const transform = createStream();
	let offset = 0;
	const source = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset === input.length) return controller.close();
			const end = Math.min(offset + INPUT_SLICE_SIZE, input.length);
			controller.enqueue(input.subarray(offset, end));
			offset = end;
		}
	});
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of source.pipeThrough(transform)) {
		chunks.push(chunk);
		length += chunk.byteLength;
	}
	return concatChunks(chunks, length);
};
