import { instantiateEncoder, type Encoder } from './encoder-core.ts';
import { startCompressionWorker } from '../parallel/compression-worker-runtime.ts';

let encoder: Encoder | undefined;
export const start = (): void =>
	startCompressionWorker(task => {
		try {
			encoder ??= instantiateEncoder();
			if (task.bytes.length > encoder.snapshotCapacity()) throw new Error('WASM block snapshot exceeds capacity');
			new Uint8Array(encoder.memory.buffer, encoder.snapshot(), task.bytes.length).set(task.bytes);
			if (encoder.restore(task.bytes.length) !== 0) throw new Error('Invalid WASM block snapshot');
			const length = encoder.encode();
			if (length <= 0) throw new Error('WASM block encoding failed');
			return {
				bytes: new Uint8Array(encoder.memory.buffer, encoder.output(), length).slice(),
				bitLength: length * 8,
				crc: encoder.crc() >>> 0
			};
		} catch (error) {
			encoder = undefined;
			throw error;
		}
	});
