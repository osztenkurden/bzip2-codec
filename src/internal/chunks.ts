export const concatChunks = (chunks: readonly Uint8Array[], length?: number): Uint8Array => {
	const outputLength = length ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const output = new Uint8Array(outputLength);
	let offset = 0;

	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return output;
};
