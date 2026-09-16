# Decompression benchmarks

Run `bun benchmark.ts '<archive-url>'` to add or update this machine's CPU section.
The archive is downloaded once over IPv4 and loaded into memory before each trial.
Times include decoding, startup and output buffering; download, file reads and hash validation are excluded.
Compare sections using the same input and measurement method.

## AMD Ryzen 7 5800X 8-Core Processor

Measurement: preloaded input, download/file reads and SHA-256 validation excluded. Includes decoder startup, streaming and output buffering.

Updated: 2026-09-14T14:32:18.197Z. linux x64, Bun 1.4.2; 16 auto workers/threads, bzip2 single-threaded.
Revision: `7ecff0b593e5` (working tree has changes). 3 successful trial(s) per decoder. Source host: `replay187.valve.net`.
Input: 220,127,546 compressed bytes → 321,837,400 output bytes.
Input SHA-256: `ff3a48e9a72f338784023ad81291b87583058dbb1a47df1027799b35e3c7fe3d`. Output SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.

| Decoder                  | Median time | Output throughput |  Observed range |
| ------------------------ | ----------: | ----------------: | --------------: |
| bzip2                    |    12.582 s |        25.58 MB/s | 12.559–12.680 s |
| lbzip2                   |     0.849 s |       379.10 MB/s |   0.830–0.857 s |
| bzip2-codec (JS, auto)   |     1.496 s |       215.19 MB/s |   1.461–1.522 s |
| bzip2-codec (WASM, auto) |     0.988 s |       325.71 MB/s |   0.975–0.993 s |

## Apple M1

Measurement: preloaded input, download/file reads and SHA-256 validation excluded. Includes decoder startup, streaming and output buffering.

Updated: 2026-09-16T12:12:30.863Z. darwin arm64, Bun 1.4.2; 8 hardware threads, codec auto concurrency 8. Explicit concurrency 1 and bzip2 runs are single-threaded.
Revision: `b1feab8a4f4c`. 3 successful trial(s) per decoder. Source host: `replay187.valve.net`.
Input: 220,127,546 compressed bytes → 321,837,400 output bytes.
Input SHA-256: `ff3a48e9a72f338784023ad81291b87583058dbb1a47df1027799b35e3c7fe3d`. Output SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.

| Decoder                  | Median time | Output throughput |  Observed range |
| ------------------------ | ----------: | ----------------: | --------------: |
| bzip2                    |    10.453 s |        30.79 MB/s | 10.443–10.470 s |
| bzip2-codec (JS, 1)      |     9.590 s |        33.56 MB/s |   9.587–9.619 s |
| bzip2-codec (WASM, 1)    |     7.949 s |        40.49 MB/s |   7.948–7.971 s |
| lbzip2                   |     1.565 s |       205.66 MB/s |   1.558–1.581 s |
| bzip2-codec (JS, auto)   |     2.367 s |       135.98 MB/s |   2.328–2.402 s |
| bzip2-codec (WASM, auto) |     1.759 s |       182.97 MB/s |   1.746–1.802 s |

## Intel(R) Core(TM) Ultra 9 275HX

Measurement: preloaded input, download/file reads and SHA-256 validation excluded. Includes decoder startup, streaming and output buffering.

Updated: 2026-09-16T12:07:21.044Z. linux x64, Bun 1.4.2; 24 hardware threads, codec auto concurrency 24. Explicit concurrency 1 and bzip2 runs are single-threaded.
Revision: `f31063149d87`. 3 successful trial(s) per decoder. Source host: `replay187.valve.net`.
Input: 220,127,546 compressed bytes → 321,837,400 output bytes.
Input SHA-256: `ff3a48e9a72f338784023ad81291b87583058dbb1a47df1027799b35e3c7fe3d`. Output SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.

| Decoder                  | Median time | Output throughput |  Observed range |
| ------------------------ | ----------: | ----------------: | --------------: |
| bzip2                    |    11.521 s |        27.94 MB/s | 11.485–11.949 s |
| bzip2-codec (JS, 1)      |     8.668 s |        37.13 MB/s |   8.563–9.034 s |
| bzip2-codec (WASM, 1)    |     7.271 s |        44.26 MB/s |   7.257–7.360 s |
| lbzip2                   |     0.570 s |       564.57 MB/s |   0.529–0.576 s |
| bzip2-codec (JS, auto)   |     1.116 s |       288.41 MB/s |   1.108–1.164 s |
| bzip2-codec (WASM, auto) |     0.717 s |       449.00 MB/s |   0.663–0.748 s |
