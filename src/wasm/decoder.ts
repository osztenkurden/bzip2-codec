import { decodeNextBlock as decodeJsNextBlock, decodeStandaloneBlock as decodeJsBlock } from '../codec/decoder.ts';
import { tryDecodeBlock } from './block.ts';

export const decodeStandaloneBlock: typeof decodeJsBlock = (...args) => {
	return tryDecodeBlock(args[0], args[1], args[2], args[3]) ?? decodeJsBlock(...args);
};

export const decodeNextBlock: typeof decodeJsNextBlock = (
	reader,
	maximumBlockLength,
	maximumOutputLength,
	workspace,
	error
) => {
	const byteOffset = Math.floor(reader.position / 8);
	// A synchronous call may supply an entire archive. Only the current block needs copying.
	const bytes = reader.bytes.subarray(byteOffset, byteOffset + 4 * 1024 * 1024);
	const block = tryDecodeBlock(bytes, reader.position & 7, maximumBlockLength, maximumOutputLength);
	if (block === undefined)
		return decodeJsNextBlock(reader, maximumBlockLength, maximumOutputLength, workspace, error);
	reader.position = byteOffset * 8 + block.endPosition;
	return {
		kind: 'block',
		storedCrc: block.storedCrc,
		outputLength: block.output.length,
		validatedOutput: block.output,
		emit(sink, chunkSize) {
			for (let offset = 0; offset < block.output.length; offset += chunkSize)
				sink(block.output.subarray(offset, offset + chunkSize));
		}
	};
};
