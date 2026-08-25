const DEFAULT_CAPACITY = 64 * 1024;

export type ByteSink = (chunk: Uint8Array) => void;

/** Writes a continuous MSB-first bit stream and emits complete byte chunks. */
export class BitWriter {
	readonly #sink: ByteSink;
	readonly #buffer: Uint8Array;
	#length = 0;
	#partialByte = 0;
	#partialBits = 0;

	constructor(sink: ByteSink, chunkSize = DEFAULT_CAPACITY) {
		this.#sink = sink;
		this.#buffer = new Uint8Array(chunkSize);
	}

	writeBit(bit: number | boolean): void {
		this.#partialByte = (this.#partialByte << 1) | (bit ? 1 : 0);
		this.#partialBits++;

		if (this.#partialBits === 8) {
			this.#writeCompleteByte(this.#partialByte);
			this.#partialByte = 0;
			this.#partialBits = 0;
		}
	}

	writeBits(count: number, value: number): void {
		if (!Number.isInteger(count) || count < 0 || count > 32) {
			throw new RangeError('Bit writes must contain between 0 and 32 bits');
		}

		for (let shift = count - 1; shift >= 0; shift--) {
			this.writeBit(Math.floor(value / 2 ** shift) & 1);
		}
	}

	writeByte(value: number): void {
		this.writeBits(8, value);
	}

	writeMarker(high: number, low: number): void {
		this.writeBits(24, high);
		this.writeBits(24, low);
	}

	finish(): void {
		if (this.#partialBits > 0) {
			this.#writeCompleteByte(this.#partialByte << (8 - this.#partialBits));
			this.#partialByte = 0;
			this.#partialBits = 0;
		}

		this.flush();
	}

	flush(): void {
		if (this.#length === 0) return;

		this.#sink(this.#buffer.slice(0, this.#length));
		this.#length = 0;
	}

	#writeCompleteByte(value: number): void {
		this.#buffer[this.#length++] = value;

		if (this.#length === this.#buffer.length) this.flush();
	}
}
