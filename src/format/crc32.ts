const createLookupTable = (): Uint32Array => {
	const table = new Uint32Array(256);

	for (let value = 0; value < table.length; value++) {
		let crc = value << 24;

		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
		}

		table[value] = crc >>> 0;
	}

	return table;
};

const LOOKUP = createLookupTable();

export class BzipCrc32 {
	#crc = 0xffffffff;

	get value(): number {
		return ~this.#crc >>> 0;
	}

	update(byte: number): void {
		const lookup = LOOKUP[((this.#crc >>> 24) ^ byte) & 0xff];
		this.#crc = ((this.#crc << 8) ^ lookup!) >>> 0;
	}

	updateRun(byte: number, count: number): void {
		let crc = this.#crc;
		while (count-- > 0) crc = ((crc << 8) ^ LOOKUP[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
		this.#crc = crc;
	}

	updateBytes(bytes: Uint8Array): void {
		let crc = this.#crc;
		for (const byte of bytes) crc = ((crc << 8) ^ LOOKUP[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
		this.#crc = crc;
	}
}

export const combineCrc = (combined: number, block: number): number =>
	(((combined << 1) | (combined >>> 31)) ^ block) >>> 0;
