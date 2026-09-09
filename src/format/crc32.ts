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
const LOOKUP_2 = new Uint32Array(256);
const LOOKUP_3 = new Uint32Array(256);
const LOOKUP_4 = new Uint32Array(256);
for (let byte = 0; byte < 256; byte++) {
	let crc = LOOKUP[byte]!;
	LOOKUP_2[byte] = crc = (crc << 8) ^ LOOKUP[crc >>> 24]!;
	LOOKUP_3[byte] = crc = (crc << 8) ^ LOOKUP[crc >>> 24]!;
	LOOKUP_4[byte] = (crc << 8) ^ LOOKUP[crc >>> 24]!;
}

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
		const repeated = (byte & 0xff) * 0x01010101;
		while (count >= 4) {
			const word = crc ^ repeated;
			crc =
				LOOKUP_4[word >>> 24]! ^
				LOOKUP_3[(word >>> 16) & 0xff]! ^
				LOOKUP_2[(word >>> 8) & 0xff]! ^
				LOOKUP[word & 0xff]!;
			count -= 4;
		}
		while (count-- > 0) crc = ((crc << 8) ^ LOOKUP[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
		this.#crc = crc;
	}

	updateBytes(bytes: Uint8Array): void {
		let crc = this.#crc;
		let index = 0;
		// Slice four bytes at a time to shorten the serial CRC dependency chain.
		for (; index + 4 <= bytes.length; index += 4) {
			const word =
				crc ^ (bytes[index]! << 24) ^ (bytes[index + 1]! << 16) ^ (bytes[index + 2]! << 8) ^ bytes[index + 3]!;
			crc =
				LOOKUP_4[word >>> 24]! ^
				LOOKUP_3[(word >>> 16) & 0xff]! ^
				LOOKUP_2[(word >>> 8) & 0xff]! ^
				LOOKUP[word & 0xff]!;
		}
		for (; index < bytes.length; index++) crc = ((crc << 8) ^ LOOKUP[((crc >>> 24) ^ bytes[index]!) & 0xff]!) >>> 0;
		this.#crc = crc;
	}
}

export const combineCrc = (combined: number, block: number): number =>
	(((combined << 1) | (combined >>> 31)) ^ block) >>> 0;
