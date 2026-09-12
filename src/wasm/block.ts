// Self-contained lbzip2 block decoder; see wasm/ for corresponding C source and license.
import type { StandaloneBlock } from '../codec/decoder.ts';
import { WASM_BASE64 } from './bytes.ts';

type Decoder = {
	memory: WebAssembly.Memory;
	input(): number;
	output(): number;
	start(length: number, offset: number, maximum: number): number;
	emit(capacity: number): number;
	outputLength(): number;
	endPosition(): number;
	crc(): number;
};
let module: WebAssembly.Module | undefined;
let decoder: Decoder | undefined;
const instantiate = (): Decoder => {
	module ??= new WebAssembly.Module(Uint8Array.from(atob(WASM_BASE64), c => c.charCodeAt(0)));
	return new WebAssembly.Instance(module).exports as unknown as Decoder;
};

/** Undefined requests compatibility decoding by the JS implementation. */
export const tryDecodeBlock = (
	bytes: Uint8Array,
	bitOffset: number,
	maximumBlockLength: number,
	maximumOutputLength: number
): StandaloneBlock | undefined => {
	decoder ??= instantiate();
	try {
		if (bytes.length <= 4 * 1024 * 1024) {
			new Uint8Array(decoder.memory.buffer, decoder.input(), bytes.length).set(bytes);
			if (decoder.start(bytes.length, bitOffset, maximumBlockLength) === 0) {
				const chunks: Uint8Array[] = [];
				let total = 0;
				for (;;) {
					// One extra byte lets emit finish at an exact limit or detect overflow.
					const capacity = Math.min(1024 * 1024, maximumOutputLength - total + 1);
					const status = decoder.emit(capacity);
					const length = decoder.outputLength();
					if (status < 0 || length > maximumOutputLength - total) break;
					if (length) chunks.push(new Uint8Array(decoder.memory.buffer, decoder.output(), length).slice());
					total += length;
					if (status === 0) {
						let output: Uint8Array;
						if (chunks.length === 1) output = chunks[0]!;
						else {
							output = new Uint8Array(total);
							let offset = 0;
							for (const chunk of chunks) {
								output.set(chunk, offset);
								offset += chunk.length;
							}
						}
						return { storedCrc: decoder.crc() >>> 0, output, endPosition: decoder.endPosition() };
					}
				}
			}
		}
	} catch (error) {
		if (!(error instanceof WebAssembly.RuntimeError)) throw error;
		// A trap may leave the compiled C stack pointer altered. Reset the instance.
		decoder = undefined;
	}
	return undefined;
};
