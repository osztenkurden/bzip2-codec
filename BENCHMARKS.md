# Decompression Benchmarks

## Method

Measured on Linux aarch64 (four Apple CPU cores exposed to the environment), with Node 24.20.0 and Bun 1.3.14. Baseline: commit `02e7417`. Baseline and optimized versions ran sequentially, using the same benchmark harness and independent system bzip2 1.0.8 compression at block size 9.

`scripts/benchmark-decoder.ts` performs two warmups per fixture/API, then reports the median duration. The synthetic results below use 15 measured runs; Canterbury results use seven. Throughput is decompressed MiB/s, not compressed input throughput. Each timed operation creates a fresh decoder. Compression, file reads, fixture generation, and output SHA-256 verification are excluded. Every run's output length and digest are checked against the original input or system bzip2's output.

The sync measurement includes final output concatenation. The stream measurement includes WHATWG stream overhead and collects output chunks, with 64 KiB compressed-input chunks and the default output chunk size. This is a warmed throughput benchmark, not a cold-start, peak-memory, or bounded-memory sink benchmark. The existing `benchmark:decompress` and `memory:decompress` scripts cover file-to-hash measurements separately.

## Results

Each synthetic input is 4 MiB. Text is a repeated sentence with pseudorandom suffixes; binary mixes structured bytes and pseudorandom data; random uses deterministic xorshift32 bytes; runs changes byte value every 64 KiB. These are deliberately different workloads, not a representative weighted average.

| Runtime | Input  | API    | Baseline MiB/s | Optimized MiB/s | Speedup |
| ------- | ------ | ------ | -------------: | --------------: | ------: |
| Node    | Text   | Sync   |          67.77 |           65.23 |   0.96x |
| Node    | Text   | Stream |          66.42 |           65.05 |   0.98x |
| Node    | Binary | Sync   |          27.91 |           44.56 |   1.60x |
| Node    | Binary | Stream |          20.96 |           34.05 |   1.62x |
| Node    | Random | Sync   |          10.59 |           19.40 |   1.83x |
| Node    | Random | Stream |           9.03 |           16.83 |   1.86x |
| Node    | Runs   | Sync   |         289.96 |          404.75 |   1.40x |
| Node    | Runs   | Stream |         287.11 |          416.76 |   1.45x |
| Bun     | Text   | Sync   |          62.97 |           72.80 |   1.16x |
| Bun     | Text   | Stream |          62.05 |           63.75 |   1.03x |
| Bun     | Binary | Sync   |          33.27 |           56.60 |   1.70x |
| Bun     | Binary | Stream |          25.50 |           45.49 |   1.78x |
| Bun     | Random | Sync   |          14.80 |           26.06 |   1.76x |
| Bun     | Random | Stream |          12.83 |           22.84 |   1.78x |
| Bun     | Runs   | Sync   |          94.37 |          461.25 |   4.89x |
| Bun     | Runs   | Stream |          96.10 |          544.39 |   5.66x |

For a non-synthetic check, the [Canterbury corpus archive](https://corpus.canterbury.ac.nz/resources/cantrbry.tar.gz) was gunzipped and its entire tar recompressed with `bzip2 -9`. This includes the archive headers: 2,821,120 uncompressed bytes and 570,856 compressed bytes.

| Runtime | API    | Baseline MiB/s | Optimized MiB/s | Speedup |
| ------- | ------ | -------------: | --------------: | ------: |
| Node    | Sync   |          37.14 |           43.66 |   1.18x |
| Node    | Stream |          29.65 |           36.55 |   1.23x |
| Bun     | Sync   |          40.38 |           55.91 |   1.38x |
| Bun     | Stream |          34.27 |           47.77 |   1.39x |

Results are runtime-, hardware-, and input-dependent. Node's synthetic text case regressed by approximately 2-4%; this is not an across-the-board speedup. The optional large demo fixture was absent, and browser runtimes and x86 machines were not benchmarked.

The existing memory report also verified identical Canterbury output hashes across all three input methods. Its RSS display was implausibly low (about 90-99 KiB for an entire Bun process) with the installed Bun version, so those values were not used to make memory claims; its `resourceUsage().maxRSS` unit assumption needs separate investigation.

## Changes

- Move-to-front decoding uses native overlapping `copyWithin` for indices above 16, retaining the short scalar loop for nearby symbols. This removes long JavaScript byte-shifting loops on high-entropy inputs.
- CRC byte and run updates use slicing-by-four tables, shortening the serial dependency chain for checksum calculation. The additional lookup tables occupy 3 KiB.
- Cached decoded output is checksummed in bulk, instead of invoking run CRC updates for each inverse-BWT step. If expansion exceeds the existing bounded cache, its prefix is checksummed exactly once before switching to incremental run updates. Block CRC validation still precedes all output emission; output limits and cache bounds are unchanged.

A baseline Node CPU profile of the synthetic suite attributed about 70% of samples to `decodeNextBlock` (including inlined symbol decoding/MTF) and 18% to `validateDecodedBlock`. Stream retries still restart incomplete blocks; making them resumable is a potential follow-up, but would be a substantially larger state-machine change.

## Reproduction

```sh
BZIP_BENCHMARK_RUNS=15 bun run benchmark:decoder
BZIP_BENCHMARK_RUNS=15 node scripts/benchmark-decoder.ts
bun run benchmark:decoder -- /path/to/corpus.tar.bz2
```

Use Node with native TypeScript support. To measure another checkout without changing the harness, set `BZIP_BENCHMARK_MODULE` to its absolute `file:///.../src/index.ts` URL. The default is the current checkout's source. File inputs are independently decompressed by system bzip2 with a 256 MiB subprocess output bound; this harness is intended for moderate in-memory fixtures.

Correctness checks include an independent bitwise CRC reference, mixed CRC updates, cache-boundary/fallback cases, output limits, checksum rejection before emission, fragmented streams, and opt-in system bzip2 interoperability with sparse and full alphabets.
