<div align="center">

# bzip2-codec

**Compress and decompress bzip2 data with standard Web Streams.**

[![npm version](https://img.shields.io/npm/v/bzip2-codec?color=cb6b26)](https://www.npmjs.com/package/bzip2-codec)
[![CI](https://github.com/osztenkurden/bzip2-codec/actions/workflows/main.yaml/badge.svg)](https://github.com/osztenkurden/bzip2-codec/actions/workflows/main.yaml)
[![Downloads](https://img.shields.io/npm/dm/bzip2-codec)](https://www.npmjs.com/package/bzip2-codec)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

[Quick start](#quick-start) · [CLI](#cli) · [API reference](#api-reference) · [WebAssembly](#webassembly-decoder) · [Benchmarks](benchmark.md) · [Changelog](CHANGELOG.md)

</div>

`bzip2-codec` provides dependency-free bzip2 compression and decompression for JavaScript. Stream large files without collecting the entire result in memory, or use synchronous functions for small values. TypeScript declarations are included. The main import and CLI use WebAssembly for decompression by default; compression uses JavaScript in every entry.

| Streaming                           | Decoding                                     | Integration                       |
| :---------------------------------- | :------------------------------------------- | :-------------------------------- |
| Standard WHATWG `TransformStream`   | WebAssembly by default; JavaScript available | Node.js, Bun, Deno and browsers   |
| Arbitrary `Uint8Array` input chunks | Checksum validation and output limits        | ESM imports with TypeScript types |
| Compression and decompression       | Optional worker-based decompression          | Embedded WASM and worker scripts  |

## Quick start

### 1. Install

Requires **Node.js 22.12.0 or newer** when running in Node.js. The package is **ESM-only**; other runtimes need the standard Web Streams globals.

```sh
npm install bzip2-codec
```

### 2. Decompress a file

```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { createDecompressionStream } from 'bzip2-codec';

const source = Readable.toWeb(createReadStream('archive.bz2')) as ReadableStream<Uint8Array>;
const destination = Writable.toWeb(createWriteStream('archive'));

await source.pipeThrough(createDecompressionStream()).pipeTo(destination);
```

Input chunks can end at any byte; they do not need to align with bzip2 blocks. Output is emitted as `Uint8Array` chunks, with each block checksum-validated before its output is emitted.

In Bun, use `Bun.file('archive.bz2').stream()` as the source. A fetch response's `body` is also a compatible source in browsers and other runtimes.

### 3. Compress a file

```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { createCompressionStream } from 'bzip2-codec';

const source = Readable.toWeb(createReadStream('archive')) as ReadableStream<Uint8Array>;
const destination = Writable.toWeb(createWriteStream('archive.bz2'));

await source.pipeThrough(createCompressionStream({ blockSize: 9 })).pipeTo(destination);
```

Larger blocks generally improve compression at the cost of memory and latency.

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
safe integers or `auto`. Without worker support (including Node.js without Web Workers), explicit
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

## Work with small values

```ts
import { compress, decompress } from 'bzip2-codec';

const encoded = compress(new TextEncoder().encode('hello'));
const decoded = decompress(encoded);

console.log(new TextDecoder().decode(decoded)); // hello
```

Both functions are synchronous and return a new `Uint8Array`. They collect the complete result in memory; use the stream APIs for large files.

## API reference

All three entries—`bzip2-codec`, `bzip2-codec/wasm`, and `bzip2-codec/js`—export these functions and their option types:

| Function                              | Returns                                   | Options                      |
| :------------------------------------ | :---------------------------------------- | :--------------------------- |
| `createCompressionStream(options?)`   | `TransformStream<Uint8Array, Uint8Array>` | `CompressOptions`            |
| `createDecompressionStream(options?)` | `TransformStream<Uint8Array, Uint8Array>` | `DecompressionStreamOptions` |
| `compress(input, options?)`           | `Uint8Array`                              | `CompressOptions`            |
| `decompress(input, options?)`         | `Uint8Array`                              | `DecompressOptions`          |

The synchronous functions accept a `Uint8Array` as `input`. All options are optional.

### Compression options

`CompressOptions` applies to both compression functions.

| Option            | Type                          | Default  | Behavior                                                      |
| :---------------- | :---------------------------- | :------- | :------------------------------------------------------------ |
| `blockSize`       | `BlockSize` (`1` through `9`) | `9`      | Block size in units of 100,000 bytes.                         |
| `outputChunkSize` | `number`                      | `65,536` | Maximum emitted chunk size in bytes; a positive safe integer. |

### Decompression options

`DecompressOptions` applies to both decompression functions.

| Option            | Type                  | Default    | Behavior                                                                     |
| :---------------- | :-------------------- | :--------- | :--------------------------------------------------------------------------- |
| `concatenated`    | `boolean`             | `true`     | Decode adjacent bzip2 members.                                               |
| `trailingData`    | `'error' \| 'ignore'` | `'error'`  | Reject or ignore bytes after the final decoded member.                       |
| `maxOutputBytes`  | `number`              | `Infinity` | Maximum total decompressed bytes; a non-negative safe integer or `Infinity`. |
| `outputChunkSize` | `number`              | `65,536`   | Maximum emitted chunk size in bytes; a positive safe integer.                |

`DecompressionStreamOptions` adds these stream-only options:

| Option         | Type               | Default  | Behavior                                                                                                                |
| :------------- | :----------------- | :------- | :---------------------------------------------------------------------------------------------------------------------- |
| `yieldAfterMs` | `number`           | Disabled | Yield between blocks after this much work; a non-negative finite number. `0` yields after every block.                  |
| `concurrency`  | `number \| 'auto'` | `1`      | Maximum worker count; a positive safe integer, or use reported hardware concurrency. `1` decodes on the calling thread. |

`outputChunkSize` controls emitted chunks, not total memory use or the size of the result returned by the synchronous functions.

## Control memory and responsiveness

Set `maxOutputBytes` when decoding untrusted input to enforce an application-specific expansion limit:

```ts
await source.pipeThrough(createDecompressionStream({ maxOutputBytes: 100 * 1024 * 1024 })).pipeTo(destination);
```

When decompression shares a JavaScript thread with latency-sensitive work, set `yieldAfterMs`:

```ts
await source.pipeThrough(createDecompressionStream({ yieldAfterMs: 8 })).pipeTo(destination);
```

Yielding happens between blocks, so `yieldAfterMs` is not a hard deadline. Omit it for maximum throughput.

### Parallel decompression

```ts
await source.pipeThrough(createDecompressionStream({ concurrency: 'auto' })).pipeTo(destination);
```

Workers require the Web Worker API, available in Bun, Deno and browsers. These rules apply to both the JavaScript and WASM decoders:

| Runtime                     | `concurrency: 'auto'`                                     | Explicit count above `1`              |
| :-------------------------- | :-------------------------------------------------------- | :------------------------------------ |
| Node.js without Web Workers | Falls back to `1`                                         | Throws `TypeError`                    |
| Runtime with Web Workers    | Uses reported hardware concurrency, or `4` if unavailable | Uses up to the requested worker count |

> [!NOTE]
> Web Worker support is coming to Node.js: its [development documentation](https://github.com/nodejs/node/blob/main/doc/api/globals.md#class-worker) includes an experimental implementation behind `--experimental-web-worker`. Parallel decompression was verified on **Node.js `v27.0.0-nightly2026090729667e046b`** with this flag enabled. This package detects the API at runtime, enabling `concurrency` for both JavaScript and WASM decoding.

Output stays in order and is checksum-validated. Worker scripts are embedded and loaded from Blob URLs; no asset configuration is needed. Browser CSP must allow `worker-src 'self' blob:`.

Memory use grows with concurrency because workers buffer complete decoded blocks. Use fewer workers and an appropriate `maxOutputBytes` limit when memory is constrained. `yieldAfterMs` is unnecessary with workers.

## WebAssembly decoder

The main `bzip2-codec` import uses the WebAssembly decoder. The explicit `bzip2-codec/wasm` import remains available with the same API and implementation:

```ts
import { decompress, createDecompressionStream } from 'bzip2-codec/wasm';

// Synchronous decoding uses WASM too.
const decoded = decompress(compressedBytes);

// With a ReadableStream source and WritableStream destination:
await source.pipeThrough(createDecompressionStream()).pipeTo(destination);
```

WASM is embedded and initialized on first use, with no extra assets or setup. Compression uses JavaScript in every entry. To use the pure JavaScript decoder instead, import from `bzip2-codec/js`:

```ts
import { compress, decompress, createDecompressionStream } from 'bzip2-codec/js';
```

All three entries export the same functions, error class and types. The JS entry does not load WASM. For the CLI, select `--backend js` when needed. There is no automatic fallback when WebAssembly is unavailable.

Each WASM instance uses **16 MiB of linear memory** plus input/output buffers and buffers a complete decoded block before emission. Set `maxOutputBytes` to limit expansion. Node.js supports synchronous and single-threaded WASM decoding; workers have the same runtime requirements described above.

If WebAssembly is unavailable or disallowed, use `bzip2-codec/js`. For browser CSP, allow `script-src 'self' 'wasm-unsafe-eval'` and, when using workers, `worker-src 'self' blob:`. See the [benchmark results](benchmark.md) to compare decoders and the [WASM build instructions](wasm/README.md) to rebuild the embedded decoder.

## Handle errors

Malformed data, checksum failures, output limits, and invalid decoder state reject the stream or throw a `BzipError`:

```ts
import { BzipError, decompress } from 'bzip2-codec';

try {
	decompress(compressedBytes);
} catch (error) {
	if (error instanceof BzipError) {
		console.error(error.code, error.byteOffset, error.member, error.block);
	} else {
		throw error;
	}
}
```

`BzipError.code` is stable for programmatic handling; its type is exported as `BzipErrorCode`. Depending on where an error occurs, the instance also includes `byteOffset`, `bitOffset`, `member`, `block`, `expected`, and `actual` details, described by the exported `BzipErrorDetails` type. Invalid API arguments use the standard `TypeError` or `RangeError` classes.

For streams, catch errors around the awaited `source.pipeThrough(...).pipeTo(...)` call.

## Documentation

| Read                                      | What you will find                                                     |
| :---------------------------------------- | :--------------------------------------------------------------------- |
| [API reference](#api-reference)           | All four functions, option types, defaults, and accepted values        |
| [Benchmark results](benchmark.md)         | JavaScript, WASM, bzip2 and lbzip2 results grouped by CPU              |
| [Contributing](CONTRIBUTING.md)           | Local checks, large-file tests, memory reports, and benchmark commands |
| [WASM build instructions](wasm/README.md) | Rebuilding the embedded decoder                                        |
| [Changelog](CHANGELOG.md)                 | Released changes                                                       |

## Development

```sh
bun install
bun run typecheck
npm test
bun run build
```

See [Contributing](CONTRIBUTING.md) for worker, WASM, interoperability, and package checks.

## License

[GPL-3.0](LICENSE). See [NOTICE](NOTICE) for third-party attributions.
