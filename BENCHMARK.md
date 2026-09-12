# Decompression benchmark

The parallel feature is based on sequential decoder revision `9e4c06b` (v1.1.1). The separate MTF and symbol-loop optimizations from the initial parallel prototype are excluded from this change. Earlier timing tables did not retain exact measured revisions and raw results, and do not establish the performance of this implementation.

## Record the measured version

Benchmark committed revisions so another checkout can reproduce the code. For each revision being compared, record:

```sh
git rev-parse HEAD
git status --short
bun --version
uname -a
```

Also record the CPU model, physical core count, logical thread count, and the commands used. If measuring uncommitted work, retain its complete patch and any untracked source files with the results; the base commit alone does not identify the measured implementation.

## Compare worker counts

Run each configuration separately on the same machine with the same fixture order and no competing benchmark process:

```sh
BZIP_CONCURRENCY=1 bun run benchmark:decompress
BZIP_CONCURRENCY=4 bun run benchmark:decompress
BZIP_CONCURRENCY=auto bun run benchmark:decompress
```

Save the full output of each command with its revision and environment information. Record the actual hardware concurrency when using `auto`. To compare against an older revision without the concurrency option, run `bun run benchmark:decompress` there and label that run with its commit hash.

The benchmark selects every `.bz2` file in `test_files/`, sorts the paths, and runs ten trials in round-robin order. Set `BZIP_BENCHMARK_RUNS` to change the trial count, or pass fixture paths after the command to choose inputs explicitly. Record input sizes and SHA-256 hashes so the fixture set is identifiable.

Each trial starts a fresh Bun process and measures:

```text
Bun.file().stream() -> createDecompressionStream() -> byte count and SHA-256 sink
```

Throughput is decompressed output in decimal MB divided by wall-clock seconds. Peak RSS comes from Bun's subprocess resource usage. Runs include file reads, worker startup, Web Streams, and output hashing. Filesystem caches are not cleared. Compare output byte counts and hashes before interpreting timings; `bun run memory:decompress` checks these across its three methods.

Median, p90, and p99 use linear interpolation. With ten observations, p99 is a descriptive near-maximum, not a robust tail-latency estimate. Compare throughput and peak RSS together, and include per-trial results rather than only a speedup ratio.

## Memory and input characteristics

Each worker retains a block workspace and materializes the whole expanded block before transferring the result. The scheduler normally limits running and completed tasks to twice the worker count; retrying a failed head can temporarily add a task. This excludes output already enqueued in the readable stream and compressed segments copied from the current input chunk.

The sequential decoder instead uses a bounded output cache and chunked emission for blocks with unusually large run-length expansion. Parallel decoding therefore has a different memory profile for highly repetitive input. `outputChunkSize` does not bound a worker's allocation. Compare representative files as well as highly compressible data, and report `maxOutputBytes` and worker count with memory results.

## Correctness checks

```sh
bun run test:parallel
bun run test:parallel:large
bun run build
bun run test:package
```

The large parallel test streams more than 512 MiB of generated compressed input into a hash sink, then checks an error beyond that boundary. The package test loads the embedded Blob worker through `dist/index.mjs`. `bun run test:browser` also re-bundles the package and runs it in headless Chromium without serving worker assets.
