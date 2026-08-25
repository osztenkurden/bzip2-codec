import { NEED_MORE_INPUT } from '../errors.ts';

const INITIAL_CAPACITY = 16 * 1024;

/** A growable byte buffer whose first unread byte may be partially consumed. */
export class InputBuffer {
	#storage = new Uint8Array(0);
	#start = 0;
	#end = 0;
	#bitOffset = 0;
	#totalBitsConsumed = 0;

	get byteLength(): number {
		return this.#end - this.#start;
	}

	get bitOffset(): number {
		return this.#bitOffset;
	}

	get totalBitsConsumed(): number {
		return this.#totalBitsConsumed;
	}

	get view(): Uint8Array {
		return this.#storage.subarray(this.#start, this.#end);
	}

	append(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return;

		this.#ensureCapacity(chunk.byteLength);
		this.#storage.set(chunk, this.#end);
		this.#end += chunk.byteLength;
	}

	commit(readerPosition: number): void {
		if (readerPosition < this.#bitOffset || readerPosition > this.byteLength * 8) {
			throw new RangeError('Cannot commit a bit position outside the input buffer');
		}

		const consumed = readerPosition - this.#bitOffset;
		this.#totalBitsConsumed += consumed;
		this.#start += Math.floor(readerPosition / 8);
		this.#bitOffset = readerPosition & 7;

		if (this.#start === this.#end) {
			this.#start = 0;
			this.#end = 0;
			this.#bitOffset = 0;
		}
	}

	clear(): void {
		this.#start = 0;
		this.#end = 0;
		this.#bitOffset = 0;
	}

	#ensureCapacity(additionalBytes: number): void {
		const currentLength = this.byteLength;
		const required = currentLength + additionalBytes;

		if (this.#storage.length - this.#end >= additionalBytes) return;

		if (this.#start > 0 && this.#storage.length >= required) {
			this.#storage.copyWithin(0, this.#start, this.#end);
			this.#start = 0;
			this.#end = currentLength;
			return;
		}

		let capacity = Math.max(INITIAL_CAPACITY, this.#storage.length);
		while (capacity < required) capacity *= 2;

		const replacement = new Uint8Array(capacity);
		replacement.set(this.view);
		this.#storage = replacement;
		this.#start = 0;
		this.#end = currentLength;
	}
}

export class BitReader {
	readonly bytes: Uint8Array;
	position: number;

	constructor(bytes: Uint8Array, bitOffset = 0) {
		this.bytes = bytes;
		this.position = bitOffset;
	}

	get remainingBits(): number {
		return this.bytes.byteLength * 8 - this.position;
	}

	readBits(count: number): number {
		if (!Number.isInteger(count) || count < 0 || count > 32) {
			throw new RangeError('Bit reads must contain between 0 and 32 bits');
		}

		if (this.remainingBits < count) throw NEED_MORE_INPUT;

		let result = 0;
		let remaining = count;

		while (remaining > 0) {
			const byteIndex = Math.floor(this.position / 8);
			const offset = this.position & 7;
			const available = 8 - offset;
			const take = Math.min(available, remaining);
			const shift = available - take;
			const mask = (1 << take) - 1;
			const part = (this.bytes[byteIndex]! >>> shift) & mask;

			result = result * 2 ** take + part;
			this.position += take;
			remaining -= take;
		}

		return result >>> 0;
	}

	readByte(): number {
		return this.readBits(8);
	}

	readUint32(): number {
		return this.readBits(32);
	}

	readMarker(): readonly [high: number, low: number] {
		return [this.readBits(24), this.readBits(24)];
	}

	alignToByte(): number {
		const padding = (8 - (this.position & 7)) & 7;
		return padding === 0 ? 0 : this.readBits(padding);
	}
}
