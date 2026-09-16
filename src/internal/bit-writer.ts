const DEFAULT_CAPACITY = 64 * 1024;

export type ByteSink = (chunk: Uint8Array) => void;

/** Writes a continuous MSB-first bit stream and emits complete byte chunks. */
export class BitWriter {
	readonly #sink: ByteSink;
	readonly #buffer: Uint8Array;
	#length = 0;
	#partialByte = 0;
	#partialBits = 0;
	#completeBytes = 0;

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

	get bitLength(): number {
		return this.#completeBytes * 8 + this.#partialBits;
	}

	/** Append a block without inserting its final-byte padding into the member. */
	writePacked(bytes: Uint8Array, bitLength: number): void {
		if (!Number.isSafeInteger(bitLength) || bitLength < 0 || bitLength > bytes.length * 8)
			throw new RangeError('Invalid packed bit length');
		const whole = Math.floor(bitLength / 8);
		if (this.#partialBits === 0) {
			let offset = 0;
			while (offset < whole) {
				const count = Math.min(whole - offset, this.#buffer.length - this.#length);
				this.#buffer.set(bytes.subarray(offset, offset + count), this.#length);
				this.#length += count;
				this.#completeBytes += count;
				offset += count;
				if (this.#length === this.#buffer.length) this.flush();
			}
		} else {
			const shift = this.#partialBits,
				mask = (1 << shift) - 1;
			for (let offset = 0; offset < whole; offset++) {
				const byte = bytes[offset]!;
				this.#writeCompleteByte((this.#partialByte << (8 - shift)) | (byte >>> shift));
				this.#partialByte = byte & mask;
			}
		}
		const tail = bitLength & 7;
		if (tail) this.writeBits(tail, bytes[whole]! >>> (8 - tail));
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
		this.#completeBytes++;
		this.#buffer[this.#length++] = value;

		if (this.#length === this.#buffer.length) this.flush();
	}
}
