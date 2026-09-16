# bzip2-codec

Dependency-free bzip2 compression and decompression for JavaScript, with WHATWG `TransformStream` APIs for files that should not be loaded entirely into memory.

The package is ESM-only and requires Node.js 22.12 or newer. The stream APIs also work in modern runtimes that provide the standard Web Streams globals. The main import and CLI use WebAssembly for decompression by default; compression uses JavaScript in every entry.

## Install

```sh
npm install bzip2-codec
```

## CLI

```sh
npx bzip2-codec compress input.txt -o input.txt.bz2
npx bzip2-codec decompress input.txt.bz2 -o restored.txt
npx bzip2-codec test input.txt.bz2
cat input.txt | npx bzip2-codec compress -b 1 > input.txt.bz2
bunx --bun bzip2-codec decompress input.txt.bz2 --backend wasm --concurrency auto -o restored.txt
```

`bzip2-codec compress|decompress|test [input]` accepts one input; omitted input or
`-` reads stdin. Compression and decompression default to stdout; `-o`/`--output`
selects a file or `-` for stdout. Binary output to a terminal is refused. `test`
fully decodes and validates the input, discards output, and is silent on success.

| Option                    | Commands                              | Default          |
| ------------------------- | ------------------------------------- | ---------------- |
| `-f`, `--force`           | compress/decompress, file output only | Refuse overwrite |
| `-b`, `--block-size 1..9` | compress                              | `9`              |
| `--backend js\|wasm`      | decompress/test                       | `wasm`           |
| `--max-output-bytes N`    | decompress/test                       | Unlimited        |
| `--concurrency N\|auto`   | decompress/test                       | `1`              |

The byte limit must be a nonnegative safe integer; worker counts must be positive
safe integers or `auto`. Without worker support (including Node.js), explicit
counts greater than 1 warn on stderr and fall back to 1; `auto` falls back silently.
Use `bunx --bun` for Bun workers. This CLI fallback does not change the library's
strict concurrency validation. Unknown and inapplicable options are rejected.
Use `--help`/`-h` globally or with a command, and `--version` for the package version.
Use `--` before input paths beginning with a dash.

Sources are never deleted, and input/output aliases of the same file are rejected.
File output is written to a temporary sibling and published only after success;
failures clean up the temporary file and preserve existing output. Without
`--force`, publication cannot overwrite a file created concurrently. With
`--force`, the output directory entry is replaced (an output symlink is replaced,
not followed). Stdout cannot be rolled back and may contain partial output on an
error. Errors go to stderr with codec error codes when available. Exit statuses
are `0` for success, `1` for processing/I/O errors, and `2` for usage errors.

## Stream a large file

`createDecompressionStream()` accepts arbitrary `Uint8Array` input chunks and emits decompressed `Uint8Array` chunks:

```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { createDecompressionStream } from 'bzip2-codec';

const source = Readable.toWeb(createReadStream('archive.bz2')) as ReadableStream<Uint8Array>;
// or in Bun:
// const source = Bun.file("archive").stream();
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

The main `bzip2-codec` import uses the WebAssembly decoder. The explicit `bzip2-codec/wasm` import remains available with the same API and implementation:

```ts
import { createDecompressionStream, decompress } from 'bzip2-codec/wasm';

const response = await fetch(url);
if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
await response.body.pipeThrough(createDecompressionStream({ concurrency: 2 })).pipeTo(destination);

// Synchronous decoding also uses WASM.
const decoded = decompress(compressedBytes);
```

WASM is embedded and initialized on first use; no extra assets or setup are needed. To use the pure JavaScript decoder instead, import from `bzip2-codec/js`:

```ts
import { compress, decompress, createDecompressionStream } from 'bzip2-codec/js';
```

All three entries export the same functions, error class and types. The JS entry does not load WASM. For the CLI, select `--backend js` when needed. There is no automatic fallback when WebAssembly is unavailable.

Node.js supports synchronous and single-threaded WASM decoding. For workers, use Bun, Deno or a browser and set `concurrency` to a number or `'auto'`.

Each WASM instance uses 16 MiB of linear memory plus input/output buffers. WASM decoding buffers a complete block before emission. Set `maxOutputBytes` to limit expansion.

For browser CSP, allow `script-src 'self' 'wasm-unsafe-eval'` and, when using workers, `worker-src 'self' blob:`. If WebAssembly is unavailable or disallowed, use `bzip2-codec/js`.

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

Compares bzip2, lbzip2, JS and WASM using both concurrency 1 and auto concurrency on the same preloaded archive. Auto concurrency falls back to 1 when the runtime has no Web Worker API. The archive is downloaded once over IPv4. Install `bzip2` and `lbzip2` to include their results.

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
