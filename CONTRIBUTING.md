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

Use Node.js 22.12.0+ and Bun. CI covers Node.js 22 and 24. Additional checks:

```sh
bun run test:parallel:large  # generated input exceeding 512 MiB; also runs in CI
bun run test:large           # local fixture in test_files/
bun run memory:decompress -- path/to/file.bz2
bun run benchmark:decompress -- path/to/file.bz2
bun run benchmark:decoder -- path/to/file.bz2
```

Set `BZIP_CONCURRENCY=auto` or a worker count for the memory and file-stream benchmarks. `benchmark:decoder` measures warmed synchronous and streaming throughput and requires system `bzip2`.

## Benchmarks

Full-file reports compare JS/WASM at concurrency 1 and auto with `bzip2`
(single-core) and `lbzip2` (all logical CPUs). Install the native tools to include
them. Auto falls back to 1 without Web Workers.

Timings include startup, streaming and output collection. Input loading, hashing
and output validation are excluded. Reports are grouped by CPU, with raw trials
in an adjacent `.md.json` file. Failed validation leaves the Markdown unchanged.

### Compression

```sh
bun run benchmark:compress ./uncompressed-file 3
```

Builds the package and reads an **uncompressed local file**. Results go to
[benchmark-compress.md](benchmark-compress.md): median time, throughput, compressed
size, size/input ratio and timing range. Every archive must round-trip to the
original input. Single/auto compressed hashes must match within each backend;
JS and WASM may produce different archives.

| Environment variable       | Default                                     |
| -------------------------- | ------------------------------------------- |
| `BZIP_COMPRESS_FILE`       | Required unless a path argument is supplied |
| `BZIP_COMPRESS_RUNS`       | `3`                                         |
| `BZIP_COMPRESS_BLOCK_SIZE` | `9` (accepts `1`–`9`)                       |
| `BZIP_COMPRESS_TIMEOUT_MS` | `1800000` per trial, including validation   |
| `BZIP_COMPRESS_REPORT`     | `benchmark-compress.md`                     |

Command-line file and round count override environment values.

For focused encoder profiling and deterministic generated-data comparisons:

```sh
bun --cpu-prof-md scripts/profile-compression.ts ./uncompressed-file 16 3
bun scripts/benchmark-compression-corpus.ts src/js.ts /tmp/compression-corpus.json
```

- Profile arguments: input, sample MiB, rounds, optional module path, then execution
  mode (`sync`, `cooperative`, `auto`, or a worker count).
- Corpus arguments: module path, report path, optional comparison module. Tests
  block sizes 1–9 with library/native round trips; a comparison module additionally
  requires identical compressed hashes. Use distinct report paths for each revision.

### Decompression

```sh
bun benchmark.ts                         # default replay archive, three rounds
bun benchmark.ts 'https://host/demo.bz2'  # another URL
bun benchmark.ts 'https://host/demo.bz2' 5
bun benchmark.ts ./archive.bz2            # a local copy; nothing is downloaded
```

Results go to [benchmark.md](benchmark.md). By default, downloads the 220 MB replay
archive once over IPv4 and runs three rounds. To use a local archive, pass its path,
set `BZIP_BENCHMARK_FILE`, or place it in the repository root under the URL's file
name. Each trial holds both compressed input and decompressed output in memory.

| Environment variable        | Default                   |
| --------------------------- | ------------------------- |
| `BZIP_BENCHMARK_URL`        | Replay archive URL        |
| `BZIP_BENCHMARK_FILE`       | Local copy of the archive |
| `BZIP_BENCHMARK_RUNS`       | `3`                       |
| `BZIP_BENCHMARK_TIMEOUT_MS` | `1800000` per trial       |
| `BZIP_BENCHMARK_REPORT`     | `benchmark.md`            |

CLI URL or file path and round count override environment variables.
