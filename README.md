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

## In-memory API

For small values, the convenience functions return one `Uint8Array`:

```ts
import { compress, decompress } from 'bzip2-codec';

const encoded = compress(new TextEncoder().encode('hello'));
const decoded = decompress(encoded);
```

Unlike the stream APIs, `compress()` and `decompress()` necessarily collect the complete result in memory.

## WebAssembly decoder

Import from `bzip2-codec/wasm` to use the optional WebAssembly decoder:

```ts
import { createDecompressionStream, decompress } from 'bzip2-codec/wasm';

const response = await fetch(url);
if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
await response.body.pipeThrough(createDecompressionStream({ concurrency: 2 })).pipeTo(destination);

// Synchronous decoding also uses WASM.
const decoded = decompress(compressedBytes);
```

The subpath exports the same API as `bzip2-codec`. Compression uses JavaScript. WASM is embedded and initialized on first use; no extra assets or setup are needed. The main import stays JS-only.

Node.js supports synchronous and single-threaded WASM decoding. For workers, use Bun, Deno or a browser and set `concurrency` to a number or `'auto'`.

Each WASM instance uses 16 MiB of linear memory plus input/output buffers. WASM decoding buffers a complete block before emission. Set `maxOutputBytes` to limit expansion.

For browser CSP, allow `script-src 'self' 'wasm-unsafe-eval'` and, when using workers, `worker-src 'self' blob:`. If WebAssembly is unavailable, use the main import.

See [benchmark results](benchmark.md) and [WASM build instructions](wasm/README.md).

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

Yielding happens between blocks, so `yieldAfterMs` is not a hard deadline. Omit it for maximum throughput.

#### Parallel decompression

```ts
await source.pipeThrough(createDecompressionStream({ concurrency: 'auto' })).pipeTo(destination);
```

- Default: `1`, decoding on the calling thread.
- `'auto'`: use the runtime's reported hardware concurrency.
- A number above `1`: set the maximum worker count.

Workers require Bun, Deno or a browser. In Node.js, `'auto'` resolves to `1`; an explicit count above `1` throws `TypeError`. Worker scripts are embedded and loaded from Blob URLs; no asset configuration is needed. Browser CSP must allow `worker-src 'self' blob:`.

Output stays in order and is checksum-validated. `yieldAfterMs` is unnecessary with workers. Memory use grows with concurrency: workers buffer complete decoded blocks. `outputChunkSize` limits emitted chunks, not total memory; use `maxOutputBytes` and fewer workers when memory is constrained.

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

## CPU benchmark report

```sh
bun benchmark.ts                         # default replay archive, three rounds
bun benchmark.ts 'https://host/demo.bz2'  # another URL
bun benchmark.ts 'https://host/demo.bz2' 5
bun benchmark.ts ./archive.bz2            # a local copy; nothing is downloaded
```

Compares bzip2, lbzip2, JS auto concurrency and WASM auto concurrency using the same preloaded archive. The archive is downloaded once over IPv4. Install `bzip2` and `lbzip2` to include their results.

[benchmark.md](benchmark.md) is grouped by CPU model. Rerunning updates that CPU's section; a new CPU is appended. Raw trials go to `benchmark.md.json`. Decoder failures or mismatched hashes leave the Markdown unchanged.

The default downloads a 220 MB archive once and runs three rounds. A local copy is used instead when it is passed as the first argument, named by `BZIP_BENCHMARK_FILE`, or present in the repository root under the URL's file name (archives there are git-ignored). File reads and SHA-256 validation happen outside the timed region. Timings include decoder startup, streaming and output buffering. Each trial needs memory for the compressed input and decompressed output.

| Environment variable        | Default                   |
| --------------------------- | ------------------------- |
| `BZIP_BENCHMARK_URL`        | Replay archive URL        |
| `BZIP_BENCHMARK_FILE`       | Local copy of the archive |
| `BZIP_BENCHMARK_RUNS`       | `3`                       |
| `BZIP_BENCHMARK_TIMEOUT_MS` | `1800000` per trial       |
| `BZIP_BENCHMARK_REPORT`     | `benchmark.md`            |

CLI URL or file path and round count override environment variables.

## Development

```sh
bun install
bun run typecheck
npm test                    # Node.js
bun run test:parallel       # Bun workers and WASM
bun run test:interop        # requires system bzip2
bun run build
bun run test:package        # built JS/WASM exports and Blob workers
```

CI tests Node.js 22 and 24, and runs build and Bun checks once. Additional checks:

```sh
bun run test:parallel:large  # generated input exceeding 512 MiB; also runs in CI
bun run test:large           # local fixture in test_files/
bun run memory:decompress -- path/to/file.bz2
bun run benchmark:decompress -- path/to/file.bz2
bun run benchmark:decoder -- path/to/file.bz2
```

Set `BZIP_CONCURRENCY=auto` or a worker count for the memory and file-stream benchmarks. `benchmark:decoder` measures warmed synchronous and streaming throughput and requires system `bzip2`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) for the full terms and [NOTICE](NOTICE) for third-party attributions.
