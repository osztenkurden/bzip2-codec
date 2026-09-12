import type { BzipErrorCode } from '../errors.ts';

export interface BlockTask {
	readonly id: number;
	readonly bytes: Uint8Array;
	/** Bit offset of the block marker within `bytes`. */
	readonly bitOffset: number;
	readonly maximumBlockLength: number;
	readonly maximumOutputLength: number;
}

export interface BlockSuccess {
	readonly id: number;
	readonly ok: true;
	/** The task bytes, returned so the caller can extend the segment if the block ended early. */
	readonly bytes: Uint8Array;
	readonly storedCrc: number;
	readonly output: Uint8Array;
	/** Bit position immediately after the block, relative to the task bytes. */
	readonly endPosition: number;
}

export interface BlockFailure {
	readonly id: number;
	readonly ok: false;
	/** The task bytes, returned so the caller can retry with a longer segment. */
	readonly bytes: Uint8Array;
	readonly code: BzipErrorCode;
	readonly message: string;
	/** Bit position of the failure, relative to the task bytes. */
	readonly position: number;
	readonly expected?: number;
	readonly actual?: number;
}

export type BlockOutcome = BlockSuccess | BlockFailure;

/** Sent once by a worker after its module has loaded and it can accept tasks. */
export const WORKER_READY = 'ready';

export type WorkerMessage = BlockOutcome | typeof WORKER_READY;
