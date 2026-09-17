# Contributing

[← README](README.md)

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

## CPU benchmark report

### Compression

```sh
bun run benchmark:compress ./uncompressed-file 3
```

This builds the package and compares its JS and WASM encoders with installed
`bzip2` (the single-core reference) and `lbzip2` (all logical CPUs). Both library
encoders are measured with concurrency 1 and auto; auto falls back to 1 if Web
Workers are unavailable. Supply an **uncompressed local file**;
the command does not download or decompress its input.

Results go to `benchmark-compress.md`, grouped by CPU, and raw trials to
`benchmark-compress.md.json`. The report includes median time, input throughput,
compressed size, size/input ratio, and observed time range. Each trial preloads
input and collects compressed output; file reads, hashing, and decoding the output
for validation are excluded from timing. Encoded bytes may differ across tools;
every decoded result must match the original input hash and size. Failed trials
leave the existing Markdown unchanged.

For each library backend, the benchmark also requires identical compressed hashes
across single-threaded and worker runs. JS and WASM may produce different archives.

| Environment variable       | Default                                     |
| -------------------------- | ------------------------------------------- |
| `BZIP_COMPRESS_FILE`       | Required unless a path argument is supplied |
| `BZIP_COMPRESS_RUNS`       | `3`                                         |
| `BZIP_COMPRESS_BLOCK_SIZE` | `9` (accepts `1`–`9`)                       |
| `BZIP_COMPRESS_TIMEOUT_MS` | `1800000` per trial, including validation   |
| `BZIP_COMPRESS_REPORT`     | `benchmark-compress.md`                     |

The command-line file and round count override environment values. These settings
are separate from decompression's `BZIP_BENCHMARK_*` settings.

For focused encoder profiling and deterministic generated-data comparisons:

```sh
bun --cpu-prof-md scripts/profile-compression.ts ./uncompressed-file 16 3
bun scripts/benchmark-compression-corpus.ts src/js.ts /tmp/compression-corpus.json
```

The profile script accepts sample MiB, rounds, an optional source module path, and
an execution mode (`sync`, `cooperative`, `auto`, or a worker count). The corpus
script checks block sizes 1–9 against the library and native bzip2 decoder. Use
distinct report paths when comparing revisions to preserve baseline evidence.
The corpus script accepts an optional third argument naming a comparison module;
it then also requires identical compressed hashes between implementations.

### Decompression

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
