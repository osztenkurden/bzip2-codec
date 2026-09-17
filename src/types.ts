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

/** Choose cooperative scheduling or workers; omit both for calling-thread execution. */
export type ExecutionOptions =
	| {
			/** Yield at codec checkpoints after this much work. Zero yields at every checkpoint. */
			yieldAfterMs?: number;
			concurrency?: never;
	  }
	| {
			/** Worker count, or reported hardware concurrency. Defaults to 1 (calling thread). */
			concurrency?: number | 'auto';
			yieldAfterMs?: never;
	  };

export type DecompressionStreamOptions = DecompressOptions & ExecutionOptions;

/** Cooperative or worker-based compression scheduling. */
export type CompressionStreamOptions = CompressOptions & ExecutionOptions;

export interface ResolvedCompressOptions {
	blockSize: BlockSize;
	outputChunkSize: number;
}

export interface ResolvedCompressionStreamOptions extends ResolvedCompressOptions {
	yieldAfterMs: number | undefined;
	concurrency: number;
}

export interface ResolvedDecompressOptions {
	concatenated: boolean;
	trailingData: 'error' | 'ignore';
	maxOutputBytes: number;
	outputChunkSize: number;
}

export interface ResolvedDecompressionStreamOptions extends ResolvedDecompressOptions {
	yieldAfterMs: number | undefined;
	concurrency: number;
}
