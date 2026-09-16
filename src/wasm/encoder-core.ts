import { WASM_BASE64 } from './encoder-bytes.ts';

export type Encoder = {
	memory: WebAssembly.Memory;
	init(maximum: number): number;
	input(): number;
	collect(offset: number, length: number): number;
	ready(): number;
	encode(): number;
	output(): number;
	crc(): number;
	snapshot(): number;
	snapshotCapacity(): number;
	save(): number;
	restore(length: number): number;
};
let module: WebAssembly.Module | undefined;

export const instantiateEncoder = (): Encoder => {
	module ??= new WebAssembly.Module(Uint8Array.from(atob(WASM_BASE64), c => c.charCodeAt(0)));
	return new WebAssembly.Instance(module).exports as unknown as Encoder;
};
