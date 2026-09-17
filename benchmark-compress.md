# Compression benchmarks

Run `bun run benchmark:compress [uncompressed-file] [rounds]` to update this machine's CPU section.
With no file, the default replay is downloaded and decompressed as needed before timing.
Timings include startup, streaming and output collection, plus process startup and
pipes for native tools. Input preparation, loading, hashing and round-trip checks are excluded.
JS/WASM run with concurrency 1 and auto; bzip2 uses one core and lbzip2 all logical
CPUs. Compare the same input and block size. Outputs are round-trip verified, and
single/auto compressed hashes must match within each library backend.

Tables show median times and sizes, observed time ranges, and input throughput in
decimal MB/s. See [Contributing](CONTRIBUTING.md#compression) for benchmark options.

## AMD Ryzen 7 5800X 8-Core Processor

Updated: 2026-09-17T16:49:30.141Z. linux x64, Bun 1.4.2; 16 logical CPUs; codec auto concurrency 16.
Revision: `89f875e603b9`. 3 successful trial(s) per encoder; block size 9.
Measurement: compression-preloaded-input-v1. Input: 321,837,400 bytes. SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.
Every output was decoded and checked against the input outside the timed region. Compressed bytes may differ between encoders.
For each library backend, compressed hashes also matched across concurrency settings and rounds.
Compressed size is the median; size/input is smaller for better compression. Throughput uses decimal MB of uncompressed input.

| Encoder                  | Median time | Input throughput | Compressed bytes | Size/input |  Observed range |
| ------------------------ | ----------: | ---------------: | ---------------: | ---------: | --------------: |
| bzip2                    |    16.805 s |       19.15 MB/s |      220,127,546 |     68.40% | 16.757–16.838 s |
| bzip2-codec (JS, 1)      |    23.303 s |       13.81 MB/s |      220,191,521 |     68.42% | 22.718–23.562 s |
| bzip2-codec (WASM, 1)    |    15.213 s |       21.16 MB/s |      220,010,648 |     68.36% | 15.209–15.225 s |
| lbzip2 (all CPUs)        |     1.732 s |      185.87 MB/s |      220,023,656 |     68.36% |   1.718–1.760 s |
| bzip2-codec (JS, auto)   |     5.869 s |       54.84 MB/s |      220,191,521 |     68.42% |   5.769–5.946 s |
| bzip2-codec (WASM, auto) |     2.277 s |      141.37 MB/s |      220,010,648 |     68.36% |   2.258–2.299 s |

## Apple M1

Updated: 2026-09-17T09:36:54.764Z. darwin arm64, Bun 1.4.2; 8 logical CPUs; codec auto concurrency 8.
Revision: `0a10dbb320a2` (working tree has changes). 3 successful trial(s) per encoder; block size 9.
Measurement: compression-preloaded-input-v1. Input: 321,837,400 bytes. SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.
Every output was decoded and checked against the input outside the timed region. Compressed bytes may differ between encoders.
For each library backend, compressed hashes also matched across concurrency settings and rounds.
Compressed size is the median; size/input is smaller for better compression. Throughput uses decimal MB of uncompressed input.

| Encoder                  | Median time | Input throughput | Compressed bytes | Size/input |  Observed range |
| ------------------------ | ----------: | ---------------: | ---------------: | ---------: | --------------: |
| bzip2                    |    19.018 s |       16.92 MB/s |      220,127,546 |     68.40% | 18.996–19.031 s |
| bzip2-codec (JS, 1)      |    18.667 s |       17.24 MB/s |      220,191,521 |     68.42% | 18.613–18.685 s |
| bzip2-codec (WASM, 1)    |    16.692 s |       19.28 MB/s |      220,010,648 |     68.36% | 16.687–16.717 s |
| lbzip2 (all CPUs)        |     3.075 s |      104.65 MB/s |      220,023,656 |     68.36% |   3.074–3.089 s |
| bzip2-codec (JS, auto)   |     4.612 s |       69.78 MB/s |      220,191,521 |     68.42% |   4.606–4.653 s |
| bzip2-codec (WASM, auto) |     3.499 s |       91.98 MB/s |      220,010,648 |     68.36% |   3.449–3.556 s |

## Intel(R) Core(TM) Ultra 9 275HX

Updated: 2026-09-17T09:49:33.458Z. linux x64, Bun 1.4.2; 24 logical CPUs; codec auto concurrency 24.
Revision: `3ce3a3ede4d8`. 3 successful trial(s) per encoder; block size 9.
Measurement: compression-preloaded-input-v1. Input: 321,837,400 bytes. SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.
Every output was decoded and checked against the input outside the timed region. Compressed bytes may differ between encoders.
For each library backend, compressed hashes also matched across concurrency settings and rounds.
Compressed size is the median; size/input is smaller for better compression. Throughput uses decimal MB of uncompressed input.

| Encoder                  | Median time | Input throughput | Compressed bytes | Size/input |  Observed range |
| ------------------------ | ----------: | ---------------: | ---------------: | ---------: | --------------: |
| bzip2                    |    14.226 s |       22.62 MB/s |      220,127,546 |     68.40% | 13.960–14.273 s |
| bzip2-codec (JS, 1)      |    17.264 s |       18.64 MB/s |      220,191,521 |     68.42% | 16.869–17.603 s |
| bzip2-codec (WASM, 1)    |    13.404 s |       24.01 MB/s |      220,010,648 |     68.36% | 13.212–13.419 s |
| lbzip2 (all CPUs)        |     0.969 s |      332.19 MB/s |      220,023,656 |     68.36% |   0.962–1.039 s |
| bzip2-codec (JS, auto)   |     2.552 s |      126.12 MB/s |      220,191,521 |     68.42% |   2.436–2.555 s |
| bzip2-codec (WASM, auto) |     1.428 s |      225.32 MB/s |      220,010,648 |     68.36% |   1.373–1.455 s |
