/**
 * Sorts all cyclic rotations with prefix doubling and counting sort, then
 * returns the Burrows-Wheeler last column and the row containing the input.
 */
export const burrowsWheelerTransform = (
	input: Uint8Array
): { readonly lastColumn: Uint8Array; readonly originalPointer: number } => {
	const length = input.length;
	if (length === 0) throw new RangeError('Cannot transform an empty block');
	if (length === 1) return { lastColumn: input.slice(), originalPointer: 0 };

	let order = new Int32Array(length);
	let classes = new Int32Array(length);
	const counts = new Int32Array(Math.max(256, length));

	for (const byte of input) counts[byte] = counts[byte]! + 1;
	for (let index = 1; index < 256; index++) counts[index] = counts[index]! + counts[index - 1]!;
	for (let index = length - 1; index >= 0; index--) {
		const byte = input[index]!;
		order[--counts[byte]!] = index;
	}

	let classCount = 1;
	classes[order[0]!] = 0;
	for (let index = 1; index < length; index++) {
		if (input[order[index]!] !== input[order[index - 1]!]) classCount++;
		classes[order[index]!] = classCount - 1;
	}

	let shifted = new Int32Array(length);
	let nextClasses = new Int32Array(length);

	for (let shift = 1; shift < length && classCount < length; shift *= 2) {
		counts.fill(0, 0, classCount);

		for (let index = 0; index < length; index++) {
			const value = order[index]! - shift;
			shifted[index] = value < 0 ? value + length : value;
			const valueClass = classes[shifted[index]!]!;
			counts[valueClass] = counts[valueClass]! + 1;
		}

		for (let index = 1; index < classCount; index++) {
			counts[index] = counts[index]! + counts[index - 1]!;
		}

		for (let index = length - 1; index >= 0; index--) {
			const value = shifted[index]!;
			const valueClass = classes[value]!;
			order[--counts[valueClass]!] = value;
		}

		let nextClassCount = 1;
		nextClasses[order[0]!] = 0;

		for (let index = 1; index < length; index++) {
			const current = order[index]!;
			const previous = order[index - 1]!;
			const currentSecond = current + shift < length ? current + shift : current + shift - length;
			const previousSecond = previous + shift < length ? previous + shift : previous + shift - length;

			if (classes[current] !== classes[previous] || classes[currentSecond] !== classes[previousSecond]) {
				nextClassCount++;
			}

			nextClasses[current] = nextClassCount - 1;
		}

		classCount = nextClassCount;
		[classes, nextClasses] = [nextClasses, classes];
	}

	const lastColumn = new Uint8Array(length);
	let originalPointer = 0;

	for (let row = 0; row < length; row++) {
		const rotationStart = order[row]!;
		if (rotationStart === 0) originalPointer = row;
		lastColumn[row] = input[rotationStart === 0 ? length - 1 : rotationStart - 1]!;
	}

	return { lastColumn, originalPointer };
};
