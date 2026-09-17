<div align="center">

# bzip2-codec

**Compress and decompress bzip2 data with standard Web Streams.**

[![npm version](https://img.shields.io/npm/v/bzip2-codec?color=cb6b26)](https://www.npmjs.com/package/bzip2-codec)
[![CI](https://github.com/osztenkurden/bzip2-codec/actions/workflows/main.yaml/badge.svg)](https://github.com/osztenkurden/bzip2-codec/actions/workflows/main.yaml)
[![Downloads](https://img.shields.io/npm/dm/bzip2-codec)](https://www.npmjs.com/package/bzip2-codec)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

[Quick start](#quick-start) · [CLI](#cli) · [API reference](#api-reference) · [WebAssembly](#webassembly) · [Benchmarks](benchmark.md) · [Changelog](CHANGELOG.md)

</div>

`bzip2-codec` provides dependency-free bzip2 compression and decompression for JavaScript. Stream large files without collecting the entire result in memory, or use synchronous functions for small values. TypeScript declarations are included. The main import and CLI use WebAssembly for compression and decompression by default; the `/js` entry provides pure JavaScript implementations.

| Streaming                           | Decoding                                     | Integration                       |
| :---------------------------------- | :------------------------------------------- | :-------------------------------- |
| Standard WHATWG `TransformStream`   | WebAssembly by default; JavaScript available | Node.js, Bun, Deno and browsers   |
| Arbitrary `Uint8Array` input chunks | Checksum validation and output limits        | ESM imports with TypeScript types |
| Compression and decompression       | Optional worker-based codecs                 | Embedded WASM and worker scripts  |

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
bunx --bun bzip2-codec compress input.txt --backend wasm --concurrency auto -o input.txt.bz2
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
| `--backend js\|wasm`      | compress/decompress/test              | `wasm`           |
| `--max-output-bytes N`    | decompress/test                       | Unlimited        |
| `--concurrency N\|auto`   | compress/decompress/test              | `1`              |

The byte limit must be a nonnegative safe integer; worker counts must be positive
safe integers or `auto`. Without worker support (including Node.js without Web Workers), explicit
counts greater than 1 warn on stderr and fall back to 1; `auto` falls back silently.
Use `bunx --bun` for Bun workers. This CLI fallback does not change the library's
strict concurrency validation. Unknown and inapplicable options are rejected.
Use `--help`/`-h` globally or with a command, and `--version` for the package version.
Use `--` before input paths beginning with a dash.

Sources are kept, and input/output aliases are rejected. File output is published
from a temporary sibling only on success; failures remove the temporary file.
Existing output requires `--force`, including files created during processing.
With `--force`, the directory entry is replaced, including output symlinks.
Stdout may contain partial output on error. Errors go to stderr with codec error
codes when available. Exit statuses: `0` success, `1` processing/I/O error,
`2` usage error.

## Work with small values

```ts
import { compress, decompress } from 'bzip2-codec';

const encoded = compress(new TextEncoder().encode('hello'));
const decoded = decompress(encoded);

console.log(new TextDecoder().decode(decoded)); // hello
```

Both functions are synchronous and return a new `Uint8Array`. They collect the complete result in memory; use the stream APIs for large files.

For buffer inputs with scheduling options, use the asynchronous helpers:

```ts
import { compressAsync, decompressAsync } from 'bzip2-codec';

const encoded = await compressAsync(bytes, { blockSize: 9, yieldAfterMs: 8 });
const decoded = await decompressAsync(encoded, { yieldAfterMs: 8 });
```

These return `Promise<Uint8Array>` and collect the entire output in memory.
They use the stream APIs' options and defaults: set `yieldAfterMs` for cooperative
yielding or `concurrency` for workers. Do not mutate input until the promise settles.

## API reference

All three entries—`bzip2-codec`, `bzip2-codec/wasm`, and `bzip2-codec/js`—export these functions and their option types:

| Function                              | Returns                                   | Options                      |
| :------------------------------------ | :---------------------------------------- | :--------------------------- |
| `createCompressionStream(options?)`   | `TransformStream<Uint8Array, Uint8Array>` | `CompressionStreamOptions`   |
| `createDecompressionStream(options?)` | `TransformStream<Uint8Array, Uint8Array>` | `DecompressionStreamOptions` |
| `compress(input, options?)`           | `Uint8Array`                              | `CompressOptions`            |
| `decompress(input, options?)`         | `Uint8Array`                              | `DecompressOptions`          |
| `compressAsync(input, options?)`      | `Promise<Uint8Array>`                     | `CompressionStreamOptions`   |
| `decompressAsync(input, options?)`    | `Promise<Uint8Array>`                     | `DecompressionStreamOptions` |

The buffer functions accept a `Uint8Array` as `input`. All options are optional.

### Compression options

`CompressOptions` applies to all compression functions.

| Option            | Type                          | Default  | Behavior                                                      |
| :---------------- | :---------------------------- | :------- | :------------------------------------------------------------ |
| `blockSize`       | `BlockSize` (`1` through `9`) | `9`      | Block size in units of 100,000 bytes.                         |
| `outputChunkSize` | `number`                      | `65,536` | Maximum emitted chunk size in bytes; a positive safe integer. |

`CompressionStreamOptions` adds the [execution options](#execution-options) for
`createCompressionStream` and `compressAsync`.

### Decompression options

`DecompressOptions` applies to all decompression functions.

| Option            | Type                  | Default    | Behavior                                                                     |
| :---------------- | :-------------------- | :--------- | :--------------------------------------------------------------------------- |
| `concatenated`    | `boolean`             | `true`     | Decode adjacent bzip2 members.                                               |
| `trailingData`    | `'error' \| 'ignore'` | `'error'`  | Reject or ignore bytes after the final decoded member.                       |
| `maxOutputBytes`  | `number`              | `Infinity` | Maximum total decompressed bytes; a non-negative safe integer or `Infinity`. |
| `outputChunkSize` | `number`              | `65,536`   | Maximum emitted chunk size in bytes; a positive safe integer.                |

`DecompressionStreamOptions` adds the [execution options](#execution-options) for
`createDecompressionStream` and `decompressAsync`.

`outputChunkSize` limits emitted chunks, not total memory use or the size of a buffer result.

### Execution options

Both stream APIs and asynchronous buffer helpers accept `ExecutionOptions`:

| Option         | Type               | Default  | Behavior                                                                                                              |
| :------------- | :----------------- | :------- | :-------------------------------------------------------------------------------------------------------------------- |
| `yieldAfterMs` | `number`           | Disabled | Yield after this many milliseconds of accumulated work; a non-negative finite number. `0` yields at every checkpoint. |
| `concurrency`  | `number \| 'auto'` | `1`      | Maximum worker count; a positive safe integer or reported hardware concurrency. `1` runs on the calling thread.       |

Decompression checks the yield budget between blocks; compression checks after
input slices of at most 65,536 bytes and after finalization. Work accumulates
across writes, excluding downstream idle time. Neither interrupts block processing,
so the budget is not a hard pause limit. Omitting `yieldAfterMs` disables yielding.

TypeScript accepts either `yieldAfterMs` or `concurrency`. If JavaScript supplies
both, workers take precedence when resolved concurrency exceeds one. Recognized
options that do not apply to the selected API or execution mode are ignored.

## Control memory and responsiveness

Set `maxOutputBytes` to cap decompressed output:

```ts
await source.pipeThrough(createDecompressionStream({ maxOutputBytes: 100 * 1024 * 1024 })).pipeTo(destination);
```

Use `yieldAfterMs` for cooperative yielding:

```ts
await source.pipeThrough(createCompressionStream({ yieldAfterMs: 8 })).pipeTo(destination);
```

### Parallel compression and decompression

```ts
await source.pipeThrough(createCompressionStream({ concurrency: 'auto' })).pipeTo(destination);
// Or decode with the same scheduling option:
await compressedSource.pipeThrough(createDecompressionStream({ concurrency: 'auto' })).pipeTo(decodedDestination);

const encoded = await compressAsync(bytes, { concurrency: 'auto' });
```

Workers require the Web Worker API, available in Bun, Deno and browsers. These rules apply to JavaScript and WASM compression and decompression:

| Runtime                     | `concurrency: 'auto'`                                     | Explicit count above `1`              |
| :-------------------------- | :-------------------------------------------------------- | :------------------------------------ |
| Node.js without Web Workers | Falls back to `1`                                         | Throws `TypeError`                    |
| Runtime with Web Workers    | Uses reported hardware concurrency, or `4` if unavailable | Uses up to the requested worker count |

On Node builds that provide it, enable `--experimental-web-worker`; the API is
detected at runtime. See [Node's development documentation](https://github.com/nodejs/node/blob/main/doc/api/globals.md#class-worker).

Output stays in order. Parallel compression writes one member with the same bytes
as single-threaded compression using the same backend and block size. It collects
blocks on the calling thread and encodes on workers, with at most twice the worker
count outstanding, including results awaiting emission. Collection yields periodically.

Workers keep separate workspaces; decompression workers buffer complete decoded
blocks. Use fewer workers to reduce memory use and `maxOutputBytes` to limit decoded
output. Worker scripts are embedded as Blob URLs; browser CSP must allow
`worker-src 'self' blob:`.

## WebAssembly

The main import and `/wasm` use the embedded lbzip2-based WASM encoder and decoder.
Use `/js` for pure JavaScript:

```ts
import * as wasm from 'bzip2-codec/wasm'; // Same as 'bzip2-codec'
import * as js from 'bzip2-codec/js';
```

All entries export the same functions, error class and types. WASM modules initialize
independently on first use and require no external assets. The JS entry does not
load WASM; select it explicitly when WASM is unavailable. For the CLI, use
`--backend js`. JS and WASM may produce different valid archives.

| WASM instance |                            Fixed linear memory | Additional buffering                                   |
| ------------- | ---------------------------------------------: | ------------------------------------------------------ |
| Encoder       | 8 MiB per active stream, plus 8 MiB per worker | Transferred blocks and queued results                  |
| Decoder       |                            16 MiB per instance | A complete decoded block in JavaScript before emission |

Instances have separate mutable state, and emitted chunks own their bytes.
For browser CSP, allow `script-src 'self' 'wasm-unsafe-eval'` and, for workers,
`worker-src 'self' blob:`. See [WASM build instructions](wasm/README.md) to rebuild.

## Handle errors

Malformed data, checksum failures, output limits, and invalid codec state reject streams and async helpers or throw a `BzipError` from synchronous functions:

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
| [API reference](#api-reference)           | All six functions, option types, defaults, and accepted values         |
| [Benchmark results](benchmark.md)         | JavaScript, WASM, bzip2 and lbzip2 results grouped by CPU              |
| [Contributing](CONTRIBUTING.md)           | Local checks, large-file tests, memory reports, and benchmark commands |
| [WASM build instructions](wasm/README.md) | Rebuilding the embedded codecs                                         |
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
