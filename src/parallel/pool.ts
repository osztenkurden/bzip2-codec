import { WORKER_READY, type BlockOutcome, type BlockTask } from './protocol.ts';
import { WORKER_SOURCE } from './worker-source.ts';

export type WorkerDefinition = string | URL;

/** The subset of the Web Worker API the pool needs. */
interface WorkerHandle<Task> {
	postMessage(task: Task, transfer: ArrayBuffer[]): void;
	terminate(): void;
}

interface Slot<Task> {
	worker: WorkerHandle<Task>;
	/** Set once the worker has loaded its module; tasks posted earlier may block the caller. */
	ready: boolean;
	busy: boolean;
}

interface Waiter<Task, Outcome> {
	task: Task;
	resolve(outcome: Outcome): void;
	reject(error: unknown): void;
}

interface WorkerCallbacks<Outcome> {
	onMessage(message: Outcome | typeof WORKER_READY): void;
	onError(error: unknown): void;
}

export const resolveHardwareConcurrency = (): number => {
	const reported = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency;
	return typeof reported === 'number' && reported >= 1 ? Math.floor(reported) : 4;
};

/** True when the runtime provides the Web Worker API (browsers, Bun, Deno). */
export const supportsWorkers = (): boolean => typeof globalThis.Worker === 'function';

const createWorker = <Task, Outcome>(
	callbacks: WorkerCallbacks<Outcome>,
	definition: WorkerDefinition
): WorkerHandle<Task> => {
	const url =
		typeof definition === 'string'
			? URL.createObjectURL(new Blob([definition], { type: 'text/javascript' }))
			: definition;
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
			callbacks.onMessage(event.data as Outcome | typeof WORKER_READY);
		};
		worker.onerror = event => {
			revoke();
			callbacks.onError(event.error ?? new Error(event.message || 'Worker error'));
		};
		worker.onmessageerror = () => callbacks.onError(new Error('Unable to deserialize worker message'));
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
export class WorkerPool<
	Task extends { id: number; bytes: Uint8Array } = BlockTask,
	Outcome extends { id: number } = BlockOutcome
> {
	readonly #size: number;
	readonly #definition: WorkerDefinition;
	readonly #slots: Slot<Task>[] = [];
	readonly #queue: Waiter<Task, Outcome>[] = [];
	readonly #inFlight = new Map<number, Waiter<Task, Outcome>>();
	#closed = false;

	constructor(
		size: number,
		definition: WorkerDefinition = WORKER_SOURCE ?? new URL('./decompression-worker.ts', import.meta.url)
	) {
		if (!supportsWorkers()) throw new TypeError('This runtime does not provide the Web Worker API');
		this.#size = size;
		this.#definition = definition;
	}

	run(task: Task): Promise<Outcome> {
		return new Promise<Outcome>((resolve, reject) => {
			if (this.#closed) {
				reject(new Error('Worker pool is closed'));
				return;
			}
			this.#queue.push({ task, resolve, reject });
			this.#dispatch();
		});
	}

	close(): void {
		this.#fail(new Error('Worker pool is closed'));
	}

	#dispatch(): void {
		if (this.#closed) return;
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
		for (let spare = waiting - starting; spare > 0 && !this.#closed && this.#slots.length < this.#size; spare--)
			this.#spawn();
	}

	#assign(slot: Slot<Task>, waiter: Waiter<Task, Outcome>): void {
		slot.busy = true;
		this.#inFlight.set(waiter.task.id, waiter);
		try {
			slot.worker.postMessage(waiter.task, [waiter.task.bytes.buffer as ArrayBuffer]);
		} catch (error) {
			this.#fail(error);
		}
	}

	#spawn(): void {
		const slot: Slot<Task> = { worker: undefined as unknown as WorkerHandle<Task>, ready: false, busy: false };
		try {
			slot.worker = createWorker<Task, Outcome>(
				{
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
						this.#fail(error);
					}
				},
				this.#definition
			);
			this.#slots.push(slot);
		} catch (error) {
			this.#fail(error);
		}
	}

	#failAll(error: unknown): void {
		for (const waiter of this.#inFlight.values()) waiter.reject(error);
		this.#inFlight.clear();
		for (const waiter of this.#queue) waiter.reject(error);
		this.#queue.length = 0;
	}

	#fail(error: unknown): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const slot of this.#slots) slot.worker.terminate();
		this.#slots.length = 0;
		this.#failAll(error);
	}
}
