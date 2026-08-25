export type BlockSize = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface CompressOptions {
	/** Block size in units of 100,000 bytes. Larger blocks usually compress better. Defaults to 9. */
	blockSize?: BlockSize;
	/** Maximum size of chunks emitted by the streaming encoder. Defaults to 65,536. */
	outputChunkSize?: number;
}

export interface DecompressOptions {
	/** Decode adjacent bzip2 members. Defaults to true. */
	concatenated?: boolean;
	/** How bytes after the final decoded member are handled. Defaults to 'error'. */
	trailingData?: 'error' | 'ignore';
	/** Reject input that expands past this total number of bytes. Defaults to Infinity. */
	maxOutputBytes?: number;
	/** Maximum size of chunks emitted by the streaming decoder. Defaults to 65,536. */
	outputChunkSize?: number;
}

export interface ResolvedCompressOptions {
	blockSize: BlockSize;
	outputChunkSize: number;
}

export interface ResolvedDecompressOptions {
	concatenated: boolean;
	trailingData: 'error' | 'ignore';
	maxOutputBytes: number;
	outputChunkSize: number;
}
