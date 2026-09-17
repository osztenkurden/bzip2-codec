import { DEFAULT_OUTPUT_CHUNK_SIZE } from './format/constants.ts';
import { resolveHardwareConcurrency, supportsWorkers } from './parallel/pool.ts';
import type {
	BlockSize,
	CompressOptions,
	CompressionStreamOptions,
	DecompressionStreamOptions,
	DecompressOptions,
	ResolvedCompressOptions,
	ResolvedCompressionStreamOptions,
	ResolvedDecompressionStreamOptions,
	ResolvedDecompressOptions
} from './types.ts';

const validateChunkSize = (value: number | undefined): number => {
	const chunkSize = value ?? DEFAULT_OUTPUT_CHUNK_SIZE;
	if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
		throw new RangeError('outputChunkSize must be a positive safe integer');
	}
	return chunkSize;
};

const validateYieldAfterMs = (value: number | undefined): number | undefined => {
	if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
		throw new RangeError('yieldAfterMs must be a non-negative finite number');
	}
	return value;
};

export const resolveCompressOptions = (options: CompressOptions = {}): ResolvedCompressOptions => {
	if (options === null || typeof options !== 'object') {
		throw new TypeError('Compression options must be an object');
	}

	const blockSize = options.blockSize ?? 9;
	if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 9) {
		throw new RangeError('blockSize must be an integer between 1 and 9');
	}

	return {
		blockSize: blockSize as BlockSize,
		outputChunkSize: validateChunkSize(options.outputChunkSize)
	};
};

export const resolveDecompressOptions = (options: DecompressOptions = {}): ResolvedDecompressOptions => {
	if (options === null || typeof options !== 'object') {
		throw new TypeError('Decompression options must be an object');
	}
	if (options.concatenated !== undefined && typeof options.concatenated !== 'boolean') {
		throw new TypeError('concatenated must be a boolean');
	}

	const maxOutputBytes = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
	if (maxOutputBytes !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0)) {
		throw new RangeError('maxOutputBytes must be a non-negative safe integer or Infinity');
	}

	if (options.trailingData !== undefined && options.trailingData !== 'error' && options.trailingData !== 'ignore') {
		throw new TypeError("trailingData must be either 'error' or 'ignore'");
	}

	return {
		concatenated: options.concatenated ?? true,
		trailingData: options.trailingData ?? 'error',
		maxOutputBytes,
		outputChunkSize: validateChunkSize(options.outputChunkSize)
	};
};

export const resolveCompressionStreamOptions = (
	options: CompressionStreamOptions = {}
): ResolvedCompressionStreamOptions => {
	const resolved = resolveCompressOptions(options);
	return {
		...resolved,
		yieldAfterMs: validateYieldAfterMs(options.yieldAfterMs),
		concurrency: resolveConcurrency(options.concurrency)
	};
};

export const resolveDecompressionStreamOptions = (
	options: DecompressionStreamOptions = {}
): ResolvedDecompressionStreamOptions => {
	const resolved = resolveDecompressOptions(options);
	const yieldAfterMs = validateYieldAfterMs(options.yieldAfterMs);

	const concurrency = resolveConcurrency(options.concurrency);
	return { ...resolved, yieldAfterMs, concurrency };
};

const resolveConcurrency = (value: number | 'auto' | undefined): number => {
	let concurrency = 1;
	if (value === 'auto') {
		// 'auto' means "whatever this runtime offers", so it degrades to the calling thread.
		concurrency = supportsWorkers() ? resolveHardwareConcurrency() : 1;
	} else if (value !== undefined) {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new RangeError("concurrency must be a positive safe integer or 'auto'");
		}
		if (value > 1 && !supportsWorkers()) {
			throw new TypeError('concurrency > 1 requires the Web Worker API, which this runtime does not provide');
		}
		concurrency = value;
	}

	return concurrency;
};
