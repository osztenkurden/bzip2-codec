import { createDecompressionStream } from '../../src/index.ts';
import { createOutputMeasurement, getConcurrency, getFixture, printResult } from './measurement.ts';

const { file } = await getFixture();
const output = createOutputMeasurement();
const startedAt = performance.now();

await file
	.stream()
	.pipeThrough(createDecompressionStream({ concurrency: getConcurrency() }))
	.pipeTo(new WritableStream<Uint8Array>({ write: chunk => output.write(chunk) }));

printResult(output.finish('Bun.file() stream', file.size, performance.now() - startedAt));
