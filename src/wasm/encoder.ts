import { BzipError } from '../errors.ts';
import { combineCrc } from '../format/crc32.ts';
import type { ByteSink } from '../internal/bit-writer.ts';
import type { ResolvedCompressOptions } from '../types.ts';
import { instantiateEncoder, type Encoder } from './encoder-core.ts';

/** One isolated native encoder per stream; only the immutable compiled module is shared. */
export class WasmEncoderEngine {
	#encoder: Encoder | undefined;
	#pending = false;
	#finished = false;
	#combinedCrc = 0;
	readonly #options: ResolvedCompressOptions;
	readonly #sink: ByteSink;

	constructor(options: ResolvedCompressOptions, sink: ByteSink) {
		this.#options = options;
		this.#sink = sink;
	}

	#start(): Encoder {
		if (this.#encoder) return this.#encoder;
		const encoder = instantiateEncoder();
		if (encoder.init(this.#options.blockSize * 100000) !== 0) throw new Error('Unable to initialize WASM encoder');
		this.#encoder = encoder;
		this.#emit(Uint8Array.of(0x42, 0x5a, 0x68, 0x30 + this.#options.blockSize));
		return encoder;
	}

	push(chunk: Uint8Array): void {
		if (this.#finished) throw new BzipError('INVALID_STATE', 'Cannot write to a finished bzip2 encoder');
		if (!(chunk instanceof Uint8Array)) throw new TypeError('Bzip2 input chunks must be Uint8Array values');
		if (!chunk.length) return;
		const encoder = this.#start();
		const input = new Uint8Array(encoder.memory.buffer, encoder.input(), 65536);
		for (let offset = 0; offset < chunk.length; offset += input.length) {
			const length = Math.min(input.length, chunk.length - offset);
			input.set(chunk.subarray(offset, offset + length));
			let consumed = 0;
			while (consumed < length) {
				const count = encoder.collect(consumed, length - consumed);
				if (count < 0 || (count === 0 && !encoder.ready())) throw new Error('WASM encoder made no progress');
				consumed += count;
				this.#pending ||= count > 0;
				if (encoder.ready()) this.#finishBlock();
			}
		}
	}

	finish(): void {
		if (this.#finished) return;
		this.#start();
		this.#finishBlock();
		const trailer = new Uint8Array(10);
		trailer.set([0x17, 0x72, 0x45, 0x38, 0x50, 0x90]);
		new DataView(trailer.buffer).setUint32(6, this.#combinedCrc);
		this.#emit(trailer);
		this.close();
	}

	close(): void {
		this.#encoder = undefined;
		this.#finished = true;
	}

	#finishBlock(): void {
		if (!this.#pending) return;
		const encoder = this.#encoder!;
		const length = encoder.encode();
		if (length <= 0) throw new Error('WASM block encoding failed');
		this.#emit(new Uint8Array(encoder.memory.buffer, encoder.output(), length));
		this.#combinedCrc = combineCrc(this.#combinedCrc, encoder.crc() >>> 0);
		encoder.init(this.#options.blockSize * 100000);
		this.#pending = false;
	}

	#emit(bytes: Uint8Array): void {
		for (let offset = 0; offset < bytes.length; offset += this.#options.outputChunkSize)
			this.#sink(bytes.slice(offset, offset + this.#options.outputChunkSize));
	}
}
