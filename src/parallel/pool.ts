import { WORKER_READY, type BlockOutcome, type BlockTask, type WorkerMessage } from './protocol.ts';
import { WORKER_SOURCE } from './worker-source.ts';

/** The subset of the Web Worker API the pool needs. */
interface WorkerHandle {
	postMessage(task: BlockTask, transfer: ArrayBuffer[]): void;
	terminate(): void;
}

interface Slot {
	worker: WorkerHandle;
	/** Set once the worker has loaded its module; tasks posted earlier may block the caller. */
	ready: boolean;
	busy: boolean;
}

interface Waiter {
	task: BlockTask;
	resolve(outcome: BlockOutcome): void;
	reject(error: unknown): void;
}

interface WorkerCallbacks {
	onMessage(message: WorkerMessage): void;
	onError(error: unknown): void;
}

export const resolveHardwareConcurrency = (): number => {
	const reported = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency;
	return typeof reported === 'number' && reported >= 1 ? Math.floor(reported) : 4;
};

/** True when the runtime provides the Web Worker API (browsers, Bun, Deno). */
export const supportsWorkers = (): boolean => typeof globalThis.Worker === 'function';

const createWorker = (callbacks: WorkerCallbacks): WorkerHandle => {
	const url =
		WORKER_SOURCE === undefined
			? new URL('./decompression-worker.ts', import.meta.url)
			: URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
	let revoked = false;
	const revoke = (): void => {
		if (typeof url === 'string' && !revoked) {
			revoked = true;
			URL.revokeObjectURL(url);
		}
	};

	try {
		const worker = new Worker(url, { type: 'module' });
		worker.onmessage = event => {
			if (event.data === WORKER_READY) revoke();
			callbacks.onMessage(event.data as WorkerMessage);
		};
		worker.onerror = event => {
			revoke();
			callbacks.onError(event.error ?? new Error(event.message || 'Worker error'));
		};
		// Bun exposes unref() so an idle worker never keeps the process alive; browsers ignore it.
		(worker as { unref?(): void }).unref?.();
		return {
			postMessage: (task, transfer) => worker.postMessage(task, transfer),
			terminate: () => {
				worker.terminate();
				revoke();
			}
		};
	} catch (error) {
		revoke();
		throw error;
	}
};

/** Lazily spawns up to `size` workers and hands each block task to an idle one. */
export class WorkerPool {
	readonly #size: number;
	readonly #slots: Slot[] = [];
	readonly #queue: Waiter[] = [];
	readonly #inFlight = new Map<number, Waiter>();
	#closed = false;

	constructor(size: number) {
		if (!supportsWorkers()) throw new TypeError('This runtime does not provide the Web Worker API');
		this.#size = size;
	}

	run(task: BlockTask): Promise<BlockOutcome> {
		return new Promise<BlockOutcome>((resolve, reject) => {
			if (this.#closed) {
				reject(new Error('Worker pool is closed'));
				return;
			}
			this.#queue.push({ task, resolve, reject });
			this.#dispatch();
		});
	}

	close(): void {
		this.#closed = true;
		for (const slot of this.#slots) slot.worker.terminate();
		this.#slots.length = 0;
		this.#failAll(new Error('Worker pool is closed'));
	}

	#dispatch(): void {
		let waiting = this.#queue.length;
		for (const slot of this.#slots) {
			if (waiting === 0) return;
			if (slot.busy || !slot.ready) continue;
			this.#assign(slot, this.#queue.shift()!);
			waiting--;
		}

		// Every queued task that no ready worker can take gets a new worker, up to the pool size.
		// Workers announce readiness asynchronously, so spawning never blocks the caller.
		const starting = this.#slots.filter(slot => !slot.ready).length;
		for (let spare = waiting - starting; spare > 0 && this.#slots.length < this.#size; spare--) this.#spawn();
	}

	#assign(slot: Slot, waiter: Waiter): void {
		slot.busy = true;
		this.#inFlight.set(waiter.task.id, waiter);
		slot.worker.postMessage(waiter.task, [waiter.task.bytes.buffer as ArrayBuffer]);
	}

	#spawn(): void {
		const slot: Slot = { worker: undefined as unknown as WorkerHandle, ready: false, busy: false };
		try {
			slot.worker = createWorker({
				onMessage: message => {
					if (message === WORKER_READY) {
						slot.ready = true;
						this.#dispatch();
						return;
					}
					const waiter = this.#inFlight.get(message.id);
					this.#inFlight.delete(message.id);
					slot.busy = false;
					waiter?.resolve(message);
					this.#dispatch();
				},
				onError: error => {
					if (this.#closed || !this.#slots.includes(slot)) return;
					this.#remove(slot);
					slot.worker.terminate();
					this.#failAll(error);
				}
			});
			this.#slots.push(slot);
		} catch (error) {
			this.#failAll(error);
		}
	}

	#failAll(error: unknown): void {
		for (const waiter of this.#inFlight.values()) waiter.reject(error);
		this.#inFlight.clear();
		for (const waiter of this.#queue) waiter.reject(error);
		this.#queue.length = 0;
	}

	#remove(slot: Slot): void {
		const index = this.#slots.indexOf(slot);
		if (index !== -1) this.#slots.splice(index, 1);
	}
}
