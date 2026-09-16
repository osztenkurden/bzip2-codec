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
