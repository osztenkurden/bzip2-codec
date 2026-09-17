import type { BlockSize } from '../types.ts';

export interface CollectedBlock {
	bytes: Uint8Array;
	crc?: number;
}
export interface CompressionTask extends CollectedBlock {
	id: number;
	blockSize: BlockSize;
}
export type CompressionOutcome =
	| { id: number; ok: true; bytes: Uint8Array; bitLength: number; crc: number }
	| { id: number; ok: false; message: string };
