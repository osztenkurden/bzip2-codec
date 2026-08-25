import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { createDecompressionStream } from '../../src/index.ts';
import { createOutputMeasurement, getFixture, printResult } from './measurement.ts';

const { path, file } = await getFixture();
const output = createOutputMeasurement();
const startedAt = performance.now();
const source = Readable.toWeb(
	createReadStream(path, { highWaterMark: 128 * 1024 })
) as unknown as ReadableStream<Uint8Array>;

await source
	.pipeThrough(createDecompressionStream())
	.pipeTo(new WritableStream<Uint8Array>({ write: chunk => output.write(chunk) }));

printResult(output.finish('node:fs stream', file.size, performance.now() - startedAt));
