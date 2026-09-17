// Packed input: symbol in bits 2+, predecessor's S type in bit 1, own S type
// in bit 0. SA entries carry these two type bits in bits 31/30; the remaining
// bits hold a position (blocks have at most 900,000 bytes). -1 marks empty rows.
const induce = (
	input: Int32Array,
	sa: Int32Array,
	starts: Int32Array,
	ends: Int32Array,
	buckets: Int32Array,
	lms: Int32Array,
	orderedLms: Int32Array
): void => {
	const n = input.length;
	sa.fill(-1);
	buckets.set(ends);
	for (let i = lms.length - 1; i >= 0; i--) {
		const p = lms[i]!;
		sa[--buckets[input[p]! >>> 2]!] = p | 0x40000000;
	}
	buckets.set(starts);
	for (let i = 0; i < n; i++) {
		const entry = sa[i]!;
		// A nonnegative row has an L predecessor; skip S/empty rows before gathering.
		if (entry < 0) continue;
		const row = entry & 0x3fffffff;
		const p = row === 0 ? n - 1 : row - 1;
		const value = input[p]!;
		sa[buckets[value >>> 2]!++] = p | (value << 30);
	}
	buckets.set(ends);
	let cursor = orderedLms.length;
	for (let i = n - 1; i >= 0; i--) {
		const entry = sa[i]!;
		if (entry >= 0) {
			// Reverse induction has finalized this row. An S row with an L
			// predecessor is LMS: collect it here instead of rescanning the SA.
			if ((entry & 0x40000000) !== 0) orderedLms[--cursor] = entry & 0x3fffffff;
			continue;
		}
		if (entry === -1) continue;
		const row = entry & 0x3fffffff;
		const p = row === 0 ? n - 1 : row - 1;
		const value = input[p]!;
		sa[--buckets[value >>> 2]!] = p | (value << 30);
	}
};

/**
 * Cyclic SA-IS: S rows sort before their successor, L rows after it. An LMS
 * boundary is an S row preceded by L. Sort these substrings, recurse on their
 * names, then induce the other rows. Each recursive input is at most half-sized.
 */
const sortRotations = (input: Int32Array, alphabetSize: number): Int32Array => {
	const n = input.length;
	const sa = new Int32Array(n);
	let firstDifferent = 1;
	while (firstDifferent < n && input[firstDifferent] === input[0]) firstDifferent++;
	if (firstDifferent === n) {
		for (let i = 0; i < n; i++) sa[i] = i;
		return sa;
	}
	// Equal symbols inherit the next type, including across the cyclic boundary.
	const lastType =
		input[n - 1]! < input[0]! || (input[n - 1] === input[0] && input[0]! < input[firstDifferent]!) ? 1 : 0;
	const counts = new Int32Array(alphabetSize);
	// No two LMS positions are adjacent. One extra slot lets the branchless
	// prospective write below stay in bounds even after all LMS rows were found.
	const lmsBuffer = new Int32Array((n >>> 1) + 1);
	let lmsStart = lmsBuffer.length;
	let next = input[n - 1]!;
	let nextType = lastType;
	counts[next] = 1;
	// Classify, count symbols, collect LMS boundaries and pack both types in one
	// backward pass. input[i] stays raw until its predecessor has been classified.
	for (let i = n - 2; i >= 0; i--) {
		const current = input[i]!;
		const type = +(current < next) | (+(current === next) & nextType);
		counts[current]!++;
		lmsBuffer[lmsStart - 1] = i + 1;
		lmsStart -= (type ^ 1) & nextType;
		input[i + 1] = (next << 2) | (type << 1) | nextType;
		next = current;
		nextType = type;
	}
	input[0] = (next << 2) | (lastType << 1) | nextType;
	if (nextType !== 0 && lastType === 0) lmsBuffer[--lmsStart] = 0;
	const lms = lmsBuffer.subarray(lmsStart);
	const m = lms.length;
	const starts = new Int32Array(alphabetSize);
	const ends = new Int32Array(alphabetSize);
	for (let c = 0, sum = 0; c < alphabetSize; c++) {
		starts[c] = sum;
		ends[c] = sum += counts[c]!;
	}
	const buckets = new Int32Array(alphabetSize);
	// Only LMS positions are addressed; there cannot be adjacent LMS positions.
	const names = new Int32Array(Math.ceil(n / 2));
	// First holds sorted LMS positions, then their names in original text order.
	const reduced = new Int32Array(m);
	induce(input, sa, starts, ends, buckets, lms, reduced);
	let previous = -1;
	let name = -1;
	for (let i = 0; i < m; i++) {
		const p = reduced[i]!;
		let different = previous < 0;
		if (!different) {
			for (let d = 0; ; d++) {
				const a = p + d < n ? p + d : p + d - n;
				const b = previous + d < n ? previous + d : previous + d - n;
				const av = input[a]!,
					bv = input[b]!;
				if (av !== bv) {
					different = true;
					break;
				}
				// Equal packed values include equal type bits, so both substrings
				// reach their next LMS boundary together.
				if (d > 0 && (av & 3) === 1) break;
			}
		}
		if (different) name++;
		names[p >>> 1] = name;
		previous = p;
	}
	for (let i = 0; i < m; i++) reduced[i] = names[lms[i]! >>> 1]!;
	let sorted: Int32Array;
	if (name + 1 === m) {
		sorted = new Int32Array(m);
		for (let i = 0; i < m; i++) sorted[reduced[i]!] = i;
	} else {
		sorted = sortRotations(reduced, name + 1);
	}
	for (let i = 0; i < m; i++) sorted[i] = lms[sorted[i]! & 0x3fffffff]!;
	induce(input, sa, starts, ends, buckets, sorted, reduced);
	return sa;
};

/**
 * Sort cyclic rotations directly, including periodic blocks. Like lbzip2's sorter,
 * induce the remaining rows from sorted substring boundaries. This avoids repeated
 * full-block rank-doubling passes on long common prefixes. Equal rotations may
 * have different rows but identical BWT bytes.
 */
export const burrowsWheelerTransform = (
	input: Uint8Array
): { readonly lastColumn: Uint8Array; readonly originalPointer: number } => {
	const n = input.length;
	if (n === 0) throw new RangeError('Cannot transform an empty block');
	if (n === 1) return { lastColumn: input.slice(), originalPointer: 0 };
	const text = new Int32Array(input);
	const order = sortRotations(text, 256);
	const lastColumn = new Uint8Array(n);
	let originalPointer = 0;
	for (let row = 0; row < n; row++) {
		const p = order[row]! & 0x3fffffff;
		if (p === 0) originalPointer = row;
		lastColumn[row] = input[p === 0 ? n - 1 : p - 1]!;
	}
	return { lastColumn, originalPointer };
};
