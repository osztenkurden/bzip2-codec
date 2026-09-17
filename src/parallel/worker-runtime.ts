import type { decodeStandaloneBlock as DecodeBlock } from '../codec/decoder.ts';
import { BzipError, isNeedMoreInput } from '../errors.ts';
import { WORKER_READY, type BlockOutcome, type BlockTask } from './protocol.ts';

export const startWorker = (decodeStandaloneBlock: typeof DecodeBlock): void => {
	let workspace = new Uint32Array(0);

	const run = (task: BlockTask): BlockOutcome => {
		if (workspace.length !== task.maximumBlockLength) workspace = new Uint32Array(task.maximumBlockLength);
		let failurePosition = 0;

		try {
			const block = decodeStandaloneBlock(
				task.bytes,
				task.bitOffset,
				task.maximumBlockLength,
				task.maximumOutputLength,
				workspace,
				(code, message, reader, details) => {
					failurePosition = reader?.position ?? 0;
					return new BzipError(code, message, details);
				}
			);
			return {
				id: task.id,
				ok: true,
				bytes: task.bytes,
				storedCrc: block.storedCrc,
				output: block.output,
				endPosition: block.endPosition
			};
		} catch (error) {
			if (isNeedMoreInput(error)) {
				return {
					id: task.id,
					ok: false,
					bytes: task.bytes,
					code: 'UNEXPECTED_EOF',
					message: 'Compressed input ended in the middle of a bzip2 block',
					position: task.bytes.byteLength * 8
				};
			}
			if (error instanceof BzipError) {
				return {
					id: task.id,
					ok: false,
					bytes: task.bytes,
					code: error.code,
					message: error.message,
					position: failurePosition,
					expected: error.expected,
					actual: error.actual
				};
			}
			throw error;
		}
	};

	const handle = (task: BlockTask, post: (outcome: BlockOutcome, transfer: ArrayBuffer[]) => void): void => {
		const outcome = run(task);
		const transfer: ArrayBuffer[] = [outcome.bytes.buffer as ArrayBuffer];
		if (outcome.ok && outcome.output.buffer !== outcome.bytes.buffer)
			transfer.push(outcome.output.buffer as ArrayBuffer);
		post(outcome, transfer);
	};

	const scope = globalThis;
	scope.onmessage = (event: MessageEvent<BlockTask>) =>
		handle(event.data, (outcome, transfer) => scope.postMessage(outcome, transfer));
	// Posting to a worker before its module has loaded can block the caller (Bun), so the pool waits for this.
	scope.postMessage(WORKER_READY, []);
};
