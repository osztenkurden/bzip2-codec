import {
	BLOCK_MARKER_HIGH,
	BLOCK_MARKER_LOW,
	STREAM_END_MARKER_HIGH,
	STREAM_END_MARKER_LOW
} from '../format/constants.ts';

export type MarkerKind = 'block' | 'end';

export interface Marker {
	/** Bit position of the first marker bit, relative to the scanned array. */
	readonly bit: number;
	readonly kind: MarkerKind;
}

/**
 * Bytes a scanner must have past a candidate byte to verify a 48-bit marker that
 * starts up to seven bits before the byte boundary.
 */
export const MARKER_SCAN_LOOKAHEAD = 6;

/**
 * Maps the 16 bits starting at the first byte boundary inside a marker to the number
 * of marker bits that precede that boundary. Bit `d` marks block markers, bit `8 + d`
 * end-of-stream markers. Filtering on two bytes rejects 99.98% of positions before a
 * full 48-bit comparison.
 */
const CANDIDATES = new Uint16Array(1 << 16);

const markerBits = (high: number, low: number, shift: number): number =>
	// (marker >>> (32 - shift)) & 0xffff without exceeding 32-bit arithmetic.
	shift <= 8 ? (high >>> (8 - shift)) & 0xffff : ((high << (shift - 8)) | (low >>> (32 - shift))) & 0xffff;

for (let shift = 0; shift < 8; shift++) {
	const block = markerBits(BLOCK_MARKER_HIGH, BLOCK_MARKER_LOW, shift);
	const end = markerBits(STREAM_END_MARKER_HIGH, STREAM_END_MARKER_LOW, shift);
	CANDIDATES[block] = CANDIDATES[block]! | (1 << shift);
	CANDIDATES[end] = CANDIDATES[end]! | (1 << (8 + shift));
}

const read24 = (bytes: Uint8Array, bit: number): number => {
	const index = Math.floor(bit / 8);
	const word =
		((bytes[index]! << 24) | (bytes[index + 1]! << 16) | (bytes[index + 2]! << 8) | bytes[index + 3]!) >>> 0;
	return (word >>> (8 - (bit & 7))) & 0xffffff;
};

/**
 * Finds the first bzip2 block or end-of-stream marker that starts at or after `minimumBit`
 * and can be fully verified within `bytes`. Scanning begins at `fromByte`; any marker whose
 * first byte boundary lies before it must already have been reported.
 */
export const findMarker = (bytes: Uint8Array, fromByte: number, minimumBit: number): Marker | undefined => {
	const last = bytes.length - MARKER_SCAN_LOOKAHEAD;

	for (let index = fromByte; index <= last; index++) {
		const candidates = CANDIDATES[(bytes[index]! << 8) | bytes[index + 1]!]!;
		if (candidates === 0) continue;

		for (let shift = 0; shift < 8; shift++) {
			const bit = index * 8 - shift;
			if (bit < minimumBit) continue;

			if ((candidates & (1 << shift)) !== 0) {
				if (read24(bytes, bit) === BLOCK_MARKER_HIGH && read24(bytes, bit + 24) === BLOCK_MARKER_LOW) {
					return { bit, kind: 'block' };
				}
			}
			if ((candidates & (1 << (8 + shift))) !== 0) {
				if (
					read24(bytes, bit) === STREAM_END_MARKER_HIGH &&
					read24(bytes, bit + 24) === STREAM_END_MARKER_LOW
				) {
					return { bit, kind: 'end' };
				}
			}
		}
	}

	return undefined;
};
