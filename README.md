# bzip2-codec

Dependency-free bzip2 compression and decompression for JavaScript, with WHATWG `TransformStream` APIs for files that should not be loaded entirely into memory.

The package is ESM-only and requires Node.js 22.12 or newer. The stream APIs also work in modern runtimes that provide the standard Web Streams globals.

## Install

```sh
npm install bzip2-codec
```

## Stream a large file

`createDecompressionStream()` accepts arbitrary `Uint8Array` input chunks and emits decompressed `Uint8Array` chunks:

```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { createDecompressionStream } from 'bzip2-codec';

const source = Readable.toWeb(createReadStream('archive.bz2')) as ReadableStream<Uint8Array>;
const destination = Writable.toWeb(createWriteStream('archive'));

await source.pipeThrough(createDecompressionStream()).pipeTo(destination);
```

Compression uses the same shape:

```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { createCompressionStream } from 'bzip2-codec';

const source = Readable.toWeb(createReadStream('archive')) as ReadableStream<Uint8Array>;
const destination = Writable.toWeb(createWriteStream('archive.bz2'));

await source.pipeThrough(createCompressionStream({ blockSize: 9 })).pipeTo(destination);
```

These are standard `TransformStream<Uint8Array, Uint8Array>` instances, so they compose with `pipeThrough()` and `pipeTo()` in browsers as well as Node.js.

Bzip2's Burrows-Wheeler transform operates on complete blocks. The streaming implementation therefore keeps the current block and its working data in memory, but never needs to collect the complete file. The default block size is 900,000 bytes and output is emitted in 64 KiB chunks.

## In-memory API

For small values, the convenience functions return one `Uint8Array`:

```ts
import { compress, decompress } from 'bzip2-codec';

const encoded = compress(new TextEncoder().encode('hello'));
const decoded = decompress(encoded);
```

Unlike the stream APIs, `compress()` and `decompress()` necessarily collect the complete result in memory.

## API

### `createCompressionStream(options?)`

Returns a `TransformStream<Uint8Array, Uint8Array>`.

```ts
interface CompressOptions {
	/** Block size in units of 100,000 bytes. Default: 9. */
	blockSize?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
	/** Maximum size of each emitted chunk. Default: 65,536. */
	outputChunkSize?: number;
}
```

Larger blocks generally improve compression at the cost of memory and latency.

### `createDecompressionStream(options?)`

Returns a `TransformStream<Uint8Array, Uint8Array>`. Input chunk boundaries have no relationship to bzip2 block boundaries and may occur at any byte.

```ts
interface DecompressOptions {
	/** Decode adjacent bzip2 members. Default: true. */
	concatenated?: boolean;
	/** Reject or ignore bytes after the final decoded member. Default: 'error'. */
	trailingData?: 'error' | 'ignore';
	/** Maximum total decompressed bytes. Default: Infinity. */
	maxOutputBytes?: number;
	/** Maximum size of each emitted chunk. Default: 65,536. */
	outputChunkSize?: number;
}
```

Set `maxOutputBytes` when decoding untrusted input to enforce an application-specific expansion limit. A block is checksum-validated before any of its output is emitted.

### `compress(input, options?)`

Compresses a `Uint8Array` and returns a new `Uint8Array`. It accepts `CompressOptions`.

### `decompress(input, options?)`

Decompresses a `Uint8Array` and returns a new `Uint8Array`. It accepts `DecompressOptions`.

## Errors

Malformed data, checksum failures, output limits, and invalid decoder state reject the stream or throw a `BzipError`:

```ts
import { BzipError, decompress } from 'bzip2-codec';

try {
	decompress(data);
} catch (error) {
	if (error instanceof BzipError) {
		console.error(error.code, error.byteOffset, error.member, error.block);
	}
}
```

`BzipError.code` is stable for programmatic handling. Depending on where an error occurs, the instance also includes `byteOffset`, `bitOffset`, `member`, `block`, `expected`, and `actual` details. Invalid API arguments use the standard `TypeError` or `RangeError` classes.

## Development

```sh
bun install
bun run typecheck
npm test
npm run test:interop
bun run build
```

`npm run test:large` additionally streams a local large fixture into a hash sink without collecting its output. Large fixtures in `test_files/` are deliberately excluded from Git and npm packages.

To compare total peak resident memory for the in-memory API, a native `Bun.file()` stream, and a Node file-stream adapter, run:

```sh
bun run memory:decompress
bun run memory:decompress -- path/to/another-file.bz2
```

Each method runs in a fresh Bun process. The report verifies that every method produced the same byte count and SHA-256 digest, then obtains lifetime peak RSS from Bun's documented [`subprocess.resourceUsage()` API](https://bun.com/docs/runtime/child-process#resource-usage).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) for the full terms and [NOTICE](NOTICE) for third-party attributions.
