import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchIPv4 } from './fetch-ipv4.ts';

export const DEFAULT_REPLAY_URL = 'http://replay187.valve.net/730/003842189672549712349_0179118028.dem.bz2';

const isFile = async (path: string): Promise<boolean> => {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
};

/** Resolve raw input, or prepare the default replay outside benchmark timing. */
export const prepareCompressionInput = async ({
	source,
	repository,
	url = DEFAULT_REPLAY_URL,
	timeoutMs,
	fetchArchive = fetchIPv4,
	log = console.log
}: {
	source?: string;
	repository: string;
	url?: string;
	timeoutMs: number;
	fetchArchive?: typeof fetchIPv4;
	log?: (message: string) => void;
}): Promise<{ inputPath: string; source: string; cleanup: () => Promise<void> }> => {
	if (source !== undefined) {
		const inputPath = resolve(source);
		if (!(await isFile(inputPath))) throw new Error(`Input file not found: ${inputPath}`);
		return { inputPath, source: inputPath, cleanup: async () => {} };
	}
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Expected an HTTP(S) archive URL');
	const archiveName = basename(parsed.pathname) || 'archive.bz2';
	const rawName = archiveName.endsWith('.bz2') ? archiveName.slice(0, -4) : `${archiveName}.raw`;
	const localRaw = join(repository, rawName);
	if (await isFile(localRaw)) {
		log(`Using local replay ${localRaw}.`);
		return { inputPath: localRaw, source: localRaw, cleanup: async () => {} };
	}
	const localArchive = join(repository, archiveName);
	const scratch = await mkdtemp(join(tmpdir(), 'bzip-compress-input-'));
	const cleanup = () => rm(scratch, { recursive: true, force: true });
	try {
		const signal = AbortSignal.timeout(timeoutMs);
		let archive = localArchive;
		let inputSource = localArchive;
		if (!(await isFile(localArchive))) {
			log(`Downloading ${url} (excluded from timings)...`);
			const response = await fetchArchive(url, signal);
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw new Error(`HTTP ${response.status}; redirects are not followed`);
			}
			const encoding = response.headers.get('content-encoding');
			if (encoding && encoding !== 'identity') {
				await response.body.cancel();
				throw new Error('Server ignored Accept-Encoding: identity');
			}
			archive = join(scratch, 'archive.bz2');
			await pipeline(response.body, createWriteStream(archive), { signal });
			const expectedLength = response.headers.get('content-length');
			if (expectedLength !== null && Number(expectedLength) !== (await stat(archive)).size)
				throw new Error('Content-Length mismatch');
			inputSource = url;
		}
		log(`Decompressing ${inputSource} (excluded from timings)...`);
		const inputPath = join(scratch, 'input');
		const { createDecompressionStream } = await import('../../src/wasm/index.ts');
		// Node/Bun's stream declarations differ from the codec's DOM stream types.
		const compressed = Readable.toWeb(createReadStream(archive)) as unknown as ReadableStream<Uint8Array>;
		const decoded = compressed.pipeThrough(createDecompressionStream());
		await pipeline(decoded, createWriteStream(inputPath), { signal });
		return { inputPath, source: inputSource, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
};
