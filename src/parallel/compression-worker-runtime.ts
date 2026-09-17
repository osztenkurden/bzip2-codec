import { WORKER_READY } from './protocol.ts';
import type { CompressionTask, CompressionOutcome } from './compression-protocol.ts';

export const startCompressionWorker = (
	encode: (task: CompressionTask) => { bytes: Uint8Array; bitLength: number; crc: number }
): void => {
	const scope = globalThis;
	scope.onmessage = ({ data: task }: MessageEvent<CompressionTask>) => {
		try {
			const result = encode(task);
			scope.postMessage({ id: task.id, ok: true, ...result } satisfies CompressionOutcome, [
				result.bytes.buffer as ArrayBuffer
			]);
		} catch (error) {
			scope.postMessage(
				{
					id: task.id,
					ok: false,
					message: error instanceof Error ? error.message : String(error)
				} satisfies CompressionOutcome,
				[]
			);
		}
	};
	scope.postMessage(WORKER_READY, []);
};
