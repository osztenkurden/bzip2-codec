import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as main from '../index.ts';
import * as js from '../src/js.ts';
import * as wasm from '../src/wasm/index.ts';

test('main entry uses WASM while JS remains an explicit alternative', () => {
	assert.deepEqual(main, wasm);
	assert.deepEqual(Object.keys(main).sort(), Object.keys(js).sort());
	assert.notEqual(main.decompress, js.decompress);
	assert.notEqual(main.createDecompressionStream, js.createDecompressionStream);
	assert.notEqual(main.compress, js.compress);
	assert.notEqual(main.compressAsync, js.compressAsync);
	assert.notEqual(main.decompressAsync, js.decompressAsync);
	assert.notEqual(main.createCompressionStream, js.createCompressionStream);
	assert.equal(main.BzipError, js.BzipError);
});
