export type BzipErrorCode =
	| 'INVALID_MAGIC'
	| 'INVALID_BLOCK_SIZE'
	| 'INVALID_BLOCK_HEADER'
	| 'INVALID_HUFFMAN_TABLE'
	| 'INVALID_BWT_POINTER'
	| 'INVALID_PADDING'
	| 'UNEXPECTED_EOF'
	| 'BLOCK_OVERFLOW'
	| 'COMPRESSED_BLOCK_TOO_LARGE'
	| 'BLOCK_CRC_MISMATCH'
	| 'STREAM_CRC_MISMATCH'
	| 'TRAILING_DATA'
	| 'OUTPUT_LIMIT_EXCEEDED'
	| 'INVALID_STATE';

export interface BzipErrorDetails {
	byteOffset?: number;
	bitOffset?: number;
	member?: number;
	block?: number;
	expected?: number;
	actual?: number;
}

export class BzipError extends Error {
	readonly code: BzipErrorCode;
	readonly byteOffset?: number;
	readonly bitOffset?: number;
	readonly member?: number;
	readonly block?: number;
	readonly expected?: number;
	readonly actual?: number;

	constructor(code: BzipErrorCode, message: string, details: BzipErrorDetails = {}) {
		super(message);
		this.name = 'BzipError';
		this.code = code;
		this.byteOffset = details.byteOffset;
		this.bitOffset = details.bitOffset;
		this.member = details.member;
		this.block = details.block;
		this.expected = details.expected;
		this.actual = details.actual;
	}
}

export const NEED_MORE_INPUT = Symbol('bzip2-codec:need-more-input');

export const isNeedMoreInput = (error: unknown): boolean => error === NEED_MORE_INPUT;
