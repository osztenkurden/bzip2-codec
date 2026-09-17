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
