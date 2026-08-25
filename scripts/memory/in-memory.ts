import { decompress } from '../../src/index.ts';
import { createOutputMeasurement, getFixture, printResult } from './measurement.ts';

const { file } = await getFixture();
const output = createOutputMeasurement();
const startedAt = performance.now();

const compressed = await file.bytes();
output.write(decompress(compressed));

printResult(output.finish('In-memory decompress()', file.size, performance.now() - startedAt));
