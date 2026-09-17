import { encodeBlock } from '../codec/encoder.ts';
import { BitWriter } from '../internal/bit-writer.ts';
import { concatChunks } from '../internal/chunks.ts';
import { startCompressionWorker } from './compression-worker-runtime.ts';

startCompressionWorker(task => {
	if (task.crc === undefined) throw new Error('Missing block CRC');
	const chunks: Uint8Array[] = [];
	const writer = new BitWriter(chunk => chunks.push(chunk));
	encodeBlock(writer, task.bytes, task.crc);
	const bitLength = writer.bitLength;
	writer.finish();
	return { bytes: concatChunks(chunks), bitLength, crc: task.crc };
});
