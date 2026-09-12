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

interface DecompressionStreamOptions extends DecompressOptions {
	/** Yield between decoded blocks after this much work. Disabled by default. */
	yieldAfterMs?: number;
	/** Decode blocks on this many worker threads. Default: 1 (no workers). */
	concurrency?: number | 'auto';
}
```

Set `maxOutputBytes` when decoding untrusted input to enforce an application-specific expansion limit. A block is checksum-validated before any of its output is emitted.

Set `yieldAfterMs` when decompression shares a JavaScript thread with latency-sensitive work:

```ts
await source.pipeThrough(createDecompressionStream({ yieldAfterMs: 8 })).pipeTo(destination);
```

When the elapsed decoding time reaches the configured budget, the transformer yields to the event loop after the current checksum-validated bzip2 block. An individual block remains an atomic unit, so the interval is a responsiveness target rather than a hard deadline. Omitting `yieldAfterMs` retains the synchronous, maximum-throughput path without scheduling timers.

#### Parallel decompression

Every bzip2 block is compressed independently, so a stream can be decoded the way `lbzip2` and `pbzip2` do it: split the input at block boundaries and decode the blocks on several threads at once. Set `concurrency` to enable this:

```ts
await source.pipeThrough(createDecompressionStream({ concurrency: 'auto' })).pipeTo(destination);
```

`'auto'` uses the runtime's reported hardware concurrency; a number sets the maximum worker count. Workers are created lazily on the first block, so small inputs pay for only as many threads as they have blocks. Output is emitted in stream order and every block is still checksum-validated before it is emitted, so the observable behaviour matches the single-threaded path, including error codes. `yieldAfterMs` is not needed when workers decode the blocks; the calling thread only scans for block boundaries and forwards output.

The main thread locates blocks by scanning for the 48-bit block marker at every bit offset. The same bit pattern can in principle occur inside compressed data; the decoder handles this by extending any segment that fails to decode over the following segment and retrying, so a spurious marker costs a retry rather than a wrong result.

Parallel decoding uses the standard Web Worker API, so it works in browsers, Bun, and Deno, and the published package embeds the worker script and starts it from a Blob URL. Consumers do not need to copy worker files or configure worker asset paths. Blob URLs are released when workers finish loading, fail to load, or are terminated. If your site uses Content Security Policy, allow `blob:` in [`worker-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src) (for example, `worker-src 'self' blob:`). Node.js does not expose a global `Worker` (for now!), so it always decodes on the calling thread: `concurrency: 'auto'` resolves to 1 there, and an explicit count above 1 throws a `TypeError`. Expect memory use to grow with the worker count: each worker holds its own block workspace, and the main thread buffers up to two decoded blocks per worker while it waits to emit them in order. See [BENCHMARK.md](BENCHMARK.md) for a reproducible throughput and memory comparison.

Workers materialize the entire expanded output of each block before transferring it to the calling thread, including blocks that exceed the sequential decoder's bounded output cache. Highly repetitive input can therefore use much more memory than its compressed size or declared block size suggests. `outputChunkSize` limits emitted chunk sizes, not worker allocations. Use `maxOutputBytes` to limit expansion and choose a lower concurrency when memory is constrained. The worker queue limit does not include chunks already enqueued in the readable stream.

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
npm run test:parallel
npm run test:interop
bun run build
bun run test:package
bun run test:browser
```

`bun run test:browser` re-bundles the built package and checks Blob workers in headless Chromium. Install Chromium or set `BZIP_BROWSER` to a Chrome/Chromium executable.

`npm test` runs under Node.js, which has no Web Worker API, so the parallel decoder tests skip there; `npm run test:parallel` runs them under Bun.

`bun run test:parallel:large` exercises more than 512 MiB of generated compressed input without loading the whole stream into memory. CI runs this boundary regression and the built-package worker test.

`npm run test:large` additionally streams a local large fixture into a hash sink without collecting its output. Large fixtures in `test_files/` are deliberately excluded from Git and npm packages.

To compare total peak resident memory for the in-memory API, a native `Bun.file()` stream, and a Node file-stream adapter, run:

```sh
bun run memory:decompress
bun run memory:decompress -- path/to/another-file.bz2
```

Set `BZIP_CONCURRENCY=auto` (or a worker count) to run the stream-based memory reports and `bun run benchmark:decompress` with the parallel decoder.

Each method runs in a fresh Bun process. The report verifies that every method produced the same byte count and SHA-256 digest, then obtains lifetime peak RSS from Bun's documented [`subprocess.resourceUsage()` API](https://bun.com/docs/runtime/child-process#resource-usage).

For warmed decompression throughput, with input generation and SHA-256 verification outside the timed region:

```sh
bun run benchmark:decoder
BZIP_BENCHMARK_RUNS=15 bun run benchmark:decoder -- path/to/file.bz2
node scripts/benchmark-decoder.ts
```

This benchmark requires system `bzip2` to generate independent fixtures or verify supplied files. It measures the synchronous API and streaming with 64 KiB input chunks separately, verifies every output, and reports median MiB/s per fixture. Timed measurements retain decoded output, so sufficient memory for the uncompressed fixture is required. To compare another checkout, set `BZIP_BENCHMARK_MODULE` to its absolute `file:///.../src/index.ts` URL.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) for the full terms and [NOTICE](NOTICE) for third-party attributions.
