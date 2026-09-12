import { resolve } from 'node:path';

const DEFAULT_FIXTURE = resolve(import.meta.dir, '../../test_files/003838660961779056911_2094919404.dem.bz2');

export interface WorkerResult {
	method: string;
	compressedBytes: number;
	outputBytes: number;
	sha256: string;
	durationMs: number;
}

export const getFixture = async (): Promise<{ path: string; file: Bun.BunFile }> => {
	const path = resolve(Bun.argv[2] ?? DEFAULT_FIXTURE);
	const file = Bun.file(path);

	if (!(await file.exists())) throw new Error(`Fixture does not exist: ${path}`);
	return { path, file };
};

/** Reads BZIP_CONCURRENCY ('auto' or a worker count) so benchmarks can exercise the parallel decoder. */
export const getConcurrency = (): number | 'auto' | undefined => {
	const value = Bun.env.BZIP_CONCURRENCY;
	if (value === undefined || value === '') return undefined;
	if (value === 'auto') return 'auto';
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1)
		throw new RangeError("BZIP_CONCURRENCY must be 'auto' or a positive integer");
	return parsed;
};

export const createOutputMeasurement = () => {
	const hash = new Bun.CryptoHasher('sha256');
	let outputBytes = 0;

	return {
		write(chunk: Uint8Array) {
			hash.update(chunk);
			outputBytes += chunk.byteLength;
		},
		finish(method: string, compressedBytes: number, durationMs: number): WorkerResult {
			return {
				method,
				compressedBytes,
				outputBytes,
				sha256: hash.digest('hex'),
				durationMs
			};
		}
	};
};

export const printResult = (result: WorkerResult): void => {
	console.log(JSON.stringify(result));
};
