const induce = (
	input: Int32Array,
	sa: Int32Array,
	types: Uint8Array,
	starts: Int32Array,
	ends: Int32Array,
	buckets: Int32Array,
	lms: Int32Array
): void => {
	const n = input.length;
	sa.fill(-1);
	buckets.set(ends);
	for (let i = lms.length - 1; i >= 0; i--) {
		const p = lms[i]!;
		sa[--buckets[input[p]!]!] = p;
	}
	buckets.set(starts);
	for (let i = 0; i < n; i++) {
		const entry = sa[i]!;
		const p = entry === 0 ? n - 1 : entry - 1;
		if (p >= 0 && types[p] === 0) sa[buckets[input[p]!]!++] = p;
	}
	buckets.set(ends);
	for (let i = n - 1; i >= 0; i--) {
		const entry = sa[i]!;
		const p = entry === 0 ? n - 1 : entry - 1;
		if (p >= 0 && types[p] !== 0) sa[--buckets[input[p]!]!] = p;
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
	const types = new Uint8Array(n);
	let firstDifferent = 1;
	while (firstDifferent < n && input[firstDifferent] === input[0]) firstDifferent++;
	if (firstDifferent === n) {
		for (let i = 0; i < n; i++) sa[i] = i;
		return sa;
	}
	// Equal symbols inherit the next type, including across the cyclic boundary.
	types[n - 1] =
		input[n - 1]! < input[0]! || (input[n - 1] === input[0] && input[0]! < input[firstDifferent]!) ? 1 : 0;
	for (let i = n - 2; i >= 0; i--) {
		types[i] = input[i]! < input[i + 1]! || (input[i] === input[i + 1] && types[i + 1] !== 0) ? 1 : 0;
	}
	const counts = new Int32Array(alphabetSize);
	for (let i = 0; i < n; i++) counts[input[i]!]!++;
	const starts = new Int32Array(alphabetSize);
	const ends = new Int32Array(alphabetSize);
	for (let c = 0, sum = 0; c < alphabetSize; c++) {
		starts[c] = sum;
		ends[c] = sum += counts[c]!;
	}
	const buckets = new Int32Array(alphabetSize);
	let m = 0;
	for (let i = 0; i < n; i++) if (types[i] !== 0 && types[i === 0 ? n - 1 : i - 1] === 0) m++;
	const lms = new Int32Array(m);
	// Only LMS positions are addressed; there cannot be adjacent LMS positions.
	const names = new Int32Array(Math.ceil(n / 2));
	for (let i = 0, j = 0; i < n; i++) {
		if (types[i] !== 0 && types[i === 0 ? n - 1 : i - 1] === 0) lms[j++] = i;
	}
	induce(input, sa, types, starts, ends, buckets, lms);
	let previous = -1;
	let name = -1;
	for (let i = 0; i < n; i++) {
		const p = sa[i]!;
		if (p < 0 || types[p] === 0 || types[p === 0 ? n - 1 : p - 1] !== 0) continue;
		let different = previous < 0;
		if (!different) {
			for (let d = 0; ; d++) {
				const a = p + d < n ? p + d : p + d - n;
				const b = previous + d < n ? previous + d : previous + d - n;
				if (input[a] !== input[b] || types[a] !== types[b]) {
					different = true;
					break;
				}
				const aEnd = d > 0 && types[a] !== 0 && types[a === 0 ? n - 1 : a - 1] === 0;
				const bEnd = d > 0 && types[b] !== 0 && types[b === 0 ? n - 1 : b - 1] === 0;
				if (aEnd || bEnd) {
					different = aEnd !== bEnd;
					break;
				}
			}
		}
		if (different) name++;
		names[p >>> 1] = name;
		previous = p;
	}
	const reduced = new Int32Array(m);
	for (let i = 0; i < m; i++) reduced[i] = names[lms[i]! >>> 1]!;
	let sorted: Int32Array;
	if (name + 1 === m) {
		sorted = new Int32Array(m);
		for (let i = 0; i < m; i++) sorted[reduced[i]!] = i;
	} else {
		sorted = sortRotations(reduced, name + 1);
	}
	for (let i = 0; i < m; i++) sorted[i] = lms[sorted[i]!]!;
	induce(input, sa, types, starts, ends, buckets, sorted);
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
		const p = order[row]!;
		if (p === 0) originalPointer = row;
		lastColumn[row] = input[p === 0 ? n - 1 : p - 1]!;
	}
	return { lastColumn, originalPointer };
};
