import { instantiateEncoder, type Encoder } from './encoder-core.ts';
import type { BlockSize } from '../types.ts';
import type { CollectedBlock } from '../parallel/compression-protocol.ts';

/** Run lbzip2's exact block formation on the caller, leaving sorting to workers. */
export class WasmBlockCollector {
	#encoder: Encoder | undefined;
	#pending = false;
	readonly #blockSize: BlockSize;
	readonly #sink: (block: CollectedBlock) => void;
	constructor(blockSize: BlockSize, sink: (block: CollectedBlock) => void) {
		this.#blockSize = blockSize;
		this.#sink = sink;
	}
	push(chunk: Uint8Array): void {
		if (!chunk.length) return;
		if (!this.#encoder) {
			this.#encoder = instantiateEncoder();
			if (this.#encoder.init(this.#blockSize * 100000) !== 0)
				throw new Error('WASM collector initialization failed');
		}
		const encoder = this.#encoder;
		const staging = new Uint8Array(encoder.memory.buffer, encoder.input(), 65536);
		for (let offset = 0; offset < chunk.length; offset += staging.length) {
			const length = Math.min(staging.length, chunk.length - offset);
			staging.set(chunk.subarray(offset, offset + length));
			let consumed = 0;
			while (consumed < length) {
				const count = encoder.collect(consumed, length - consumed);
				if (count < 0 || (count === 0 && !encoder.ready())) throw new Error('WASM collector made no progress');
				consumed += count;
				this.#pending ||= count > 0;
				if (encoder.ready()) this.#finishBlock();
			}
		}
	}
	finish(): void {
		this.#finishBlock();
	}
	close(): void {
		this.#encoder = undefined;
		this.#pending = false;
	}
	#finishBlock(): void {
		if (!this.#pending) return;
		const encoder = this.#encoder!;
		const length = encoder.save();
		if (length <= 0) throw new Error('WASM block snapshot failed');
		this.#sink({ bytes: new Uint8Array(encoder.memory.buffer, encoder.snapshot(), length).slice() });
		encoder.init(this.#blockSize * 100000);
		this.#pending = false;
	}
}
