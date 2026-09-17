import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burrowsWheelerTransform } from '../src/format/block-sort.ts';

const check = (input: Uint8Array): void => {
	const order = Array.from(input, (_, i) => i).sort((a, b) => {
		for (let i = 0; i < input.length; i++) {
			const delta = input[(a + i) % input.length]! - input[(b + i) % input.length]!;
			if (delta) return delta;
		}
		return 0;
	});
	const result = burrowsWheelerTransform(input);
	assert.deepEqual(
		result.lastColumn,
		Uint8Array.from(order, p => input[(p + input.length - 1) % input.length]!)
	);
	// Equal periodic rotations may select any equal row for the origin.
	const origin = order[result.originalPointer]!;
	for (let i = 0; i < input.length; i++) assert.equal(input[(origin + i) % input.length], input[i]);
};

test('cyclic sorting agrees with a rotation oracle for every small ternary string', () => {
	for (let n = 1; n <= 8; n++) {
		for (let value = 0; value < 3 ** n; value++) {
			let rest = value;
			const input = new Uint8Array(n);
			for (let i = 0; i < n; i++, rest = Math.floor(rest / 3)) input[i] = rest % 3;
			check(input);
		}
	}
});

test('cyclic sorting handles periodic, long-prefix and full-alphabet blocks', () => {
	let seed = 123456789;
	for (let n = 9; n < 300; n++) {
		const input = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			input[i] = seed & 255;
		}
		check(input);
		check(Uint8Array.from(input, (_, i) => i % 7));
		input.fill(255);
		input[n - 2] = 0;
		check(input);
	}
});
