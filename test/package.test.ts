import assert from 'node:assert/strict';
import { test } from 'node:test';

const skip = process.env.BZIP_BUILT_TESTS !== '1';

test('the built package loads its worker and decodes a member', { skip }, async () => {
	const entry = new URL('../dist/index.mjs', import.meta.url).href;
	const { createDecompressionStream } = await import(entry);
	const encoded = Buffer.from(
		'QlpoOTFBWSZTWeopNX0AAAJTgAAQQAAEACJgDAAgADEGTEEBkeoEPEnfEAvF3JFOFCQ6ik1fQA==',
		'base64'
	);
	const source = new ReadableStream({
		start(controller) {
			controller.enqueue(encoded);
			controller.close();
		}
	});
	const output = await new Response(source.pipeThrough(createDecompressionStream({ concurrency: 2 }))).text();
	assert.equal(output, 'This is a test\n');
});
