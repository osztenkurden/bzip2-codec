# Compression benchmarks

Run `bun run benchmark:compress <uncompressed-file> [rounds]` to update this machine's CPU section.
Timings include startup, streaming and output collection, plus process startup and
pipes for native tools. Input loading, hashing and round-trip checks are excluded.
JS/WASM run with concurrency 1 and auto; bzip2 uses one core and lbzip2 all logical
CPUs. Compare the same input and block size. Outputs are round-trip verified, and
single/auto compressed hashes must match within each library backend.

Tables show median times and sizes, observed time ranges, and input throughput in
decimal MB/s. See [Contributing](CONTRIBUTING.md#compression) for benchmark options.

## AMD Ryzen 7 5800X 8-Core Processor

Updated: 2026-09-16T22:40:42.165Z. linux x64, Bun 1.4.2; 16 logical CPUs; codec auto concurrency 16.
Revision: `fd2e390e0922` (working tree has changes). 1 successful trial(s) per encoder; block size 9.
Measurement: compression-preloaded-input-v1. Input: 321,837,400 bytes. SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.

| Encoder                  | Median time | Input throughput | Compressed bytes | Size/input |  Observed range |
| ------------------------ | ----------: | ---------------: | ---------------: | ---------: | --------------: |
| bzip2                    |    16.431 s |       19.59 MB/s |      220,127,546 |     68.40% | 16.431–16.431 s |
| bzip2-codec (JS, 1)      |    84.561 s |        3.81 MB/s |      220,191,521 |     68.42% | 84.561–84.561 s |
| bzip2-codec (WASM, 1)    |    16.791 s |       19.17 MB/s |      220,010,648 |     68.36% | 16.791–16.791 s |
| lbzip2 (all CPUs)        |     1.841 s |      174.79 MB/s |      220,023,656 |     68.36% |   1.841–1.841 s |
| bzip2-codec (JS, auto)   |    45.258 s |        7.11 MB/s |      220,191,521 |     68.42% | 45.258–45.258 s |
| bzip2-codec (WASM, auto) |     2.733 s |      117.75 MB/s |      220,010,648 |     68.36% |   2.733–2.733 s |

## unknown

Apple ARM64 VM; the physical model is unavailable (`os.cpus()` reports `unknown`).
Measured 2026-09-17 on Linux arm64, Bun 1.3.14; four visible CPUs, three-CPU
container quota. Library auto uses three workers; lbzip2 uses all four visible CPUs.
Revision `f040e9507132` plus the uncommitted optimization changes. Three rounds,
block size 9. Input: 321,837,400 bytes; SHA-256:
`8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.

| Encoder                  | Median time | Input throughput | Compressed bytes | Size/input |  Observed range |
| ------------------------ | ----------: | ---------------: | ---------------: | ---------: | --------------: |
| bzip2                    |    19.833 s |       16.23 MB/s |      220,127,546 |     68.40% | 19.759–19.903 s |
| bzip2-codec (JS, 1)      |    33.339 s |        9.65 MB/s |      220,191,521 |     68.42% | 33.291–33.755 s |
| bzip2-codec (WASM, 1)    |    18.404 s |       17.49 MB/s |      220,010,648 |     68.36% | 18.330–18.408 s |
| lbzip2 (all CPUs)        |     6.081 s |       52.92 MB/s |      220,023,656 |     68.36% |   6.043–6.104 s |
| bzip2-codec (JS, auto)   |    13.525 s |       23.80 MB/s |      220,191,521 |     68.42% | 13.402–13.629 s |
| bzip2-codec (WASM, auto) |     7.038 s |       45.73 MB/s |      220,010,648 |     68.36% |   6.995–7.101 s |
