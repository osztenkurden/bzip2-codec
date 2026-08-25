import { MAX_HUFFMAN_CODE_BITS } from './constants.ts';

export interface HuffmanEncodingTable {
	readonly lengths: Uint8Array;
	readonly codes: Uint32Array;
}

interface HeapState {
	readonly heap: Int32Array;
	readonly weights: Float64Array;
	length: number;
}

const lessThan = (state: HeapState, left: number, right: number): boolean => {
	const weightDifference = state.weights[left]! - state.weights[right]!;
	return weightDifference < 0 || (weightDifference === 0 && left < right);
};

const heapPush = (state: HeapState, node: number): void => {
	let position = ++state.length;

	while (position > 1) {
		const parent = position >>> 1;
		const parentNode = state.heap[parent]!;
		if (!lessThan(state, node, parentNode)) break;
		state.heap[position] = parentNode;
		position = parent;
	}

	state.heap[position] = node;
};

const heapPop = (state: HeapState): number => {
	const result = state.heap[1]!;
	const replacement = state.heap[state.length--]!;
	let position = 1;

	while (position * 2 <= state.length) {
		let child = position * 2;
		if (child < state.length && lessThan(state, state.heap[child + 1]!, state.heap[child]!)) child++;
		if (!lessThan(state, state.heap[child]!, replacement)) break;
		state.heap[position] = state.heap[child]!;
		position = child;
	}

	state.heap[position] = replacement;
	return result;
};

const allocateCodeLengths = (frequencies: Uint32Array): Uint8Array => {
	const symbolCount = frequencies.length;
	let divisor = 1;

	for (;;) {
		const nodeCapacity = symbolCount * 2;
		const parents = new Int32Array(nodeCapacity);
		parents.fill(-1);
		const state: HeapState = {
			heap: new Int32Array(nodeCapacity + 1),
			weights: new Float64Array(nodeCapacity),
			length: 0
		};

		for (let symbol = 0; symbol < symbolCount; symbol++) {
			state.weights[symbol] = Math.max(1, Math.floor(frequencies[symbol]! / divisor));
			heapPush(state, symbol);
		}

		let nextNode = symbolCount;
		while (state.length > 1) {
			const left = heapPop(state);
			const right = heapPop(state);
			state.weights[nextNode] = state.weights[left]! + state.weights[right]!;
			parents[left] = nextNode;
			parents[right] = nextNode;
			heapPush(state, nextNode++);
		}

		const lengths = new Uint8Array(symbolCount);
		let maximumLength = 0;

		for (let symbol = 0; symbol < symbolCount; symbol++) {
			let length = 0;
			for (let node = symbol; parents[node] !== -1; node = parents[node]!) length++;
			lengths[symbol] = length;
			maximumLength = Math.max(maximumLength, length);
		}

		if (maximumLength <= MAX_HUFFMAN_CODE_BITS) return lengths;
		divisor *= 2;
	}
};

const assignCanonicalCodes = (lengths: Uint8Array): Uint32Array => {
	const codes = new Uint32Array(lengths.length);
	let minimumLength = MAX_HUFFMAN_CODE_BITS;
	let maximumLength = 0;

	for (const length of lengths) {
		minimumLength = Math.min(minimumLength, length);
		maximumLength = Math.max(maximumLength, length);
	}

	let code = 0;
	for (let length = minimumLength; length <= maximumLength; length++) {
		for (let symbol = 0; symbol < lengths.length; symbol++) {
			if (lengths[symbol] === length) codes[symbol] = code++;
		}
		code *= 2;
	}

	return codes;
};

export const createHuffmanEncodingTable = (frequencies: Uint32Array): HuffmanEncodingTable => {
	const lengths = allocateCodeLengths(frequencies);
	return { lengths, codes: assignCanonicalCodes(lengths) };
};
