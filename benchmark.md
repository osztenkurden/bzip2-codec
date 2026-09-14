# Decompression benchmarks

Run `bun benchmark.ts '<archive-url>'` to add or update this machine's CPU section.
The archive is downloaded once over IPv4 and loaded into memory before each trial.
Times include decoding, startup and output buffering; download, file reads and hash validation are excluded.
Compare sections using the same input and measurement method.

## AMD Ryzen 7 5800X 8-Core Processor

Measurement: preloaded input, download/file reads and SHA-256 validation excluded. Includes decoder startup, streaming and output buffering.

Updated: 2026-09-12T09:42:50.590Z. linux x64, Bun 1.4.2; 16 auto workers/threads, bzip2 single-threaded.
Revision: `35d04687b7d0` (working tree has changes). 3 successful trial(s) per decoder. Source host: `replay187.valve.net`.
Input: 220,127,546 compressed bytes → 321,837,400 output bytes.
Input SHA-256: `ff3a48e9a72f338784023ad81291b87583058dbb1a47df1027799b35e3c7fe3d`. Output SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.

| Decoder                  | Median time | Output throughput |  Observed range |
| ------------------------ | ----------: | ----------------: | --------------: |
| bzip2                    |    12.795 s |        25.15 MB/s | 12.771–12.803 s |
| lbzip2                   |     0.882 s |       364.71 MB/s |   0.858–0.913 s |
| bzip2-codec (JS, auto)   |     1.891 s |       170.20 MB/s |   1.888–1.907 s |
| bzip2-codec (WASM, auto) |     1.129 s |       284.97 MB/s |   1.112–1.206 s |

## Apple M1

Measurement: preloaded input, download/file reads and SHA-256 validation excluded. Includes decoder startup, streaming and output buffering.

Updated: 2026-09-14T14:29:47.792Z. darwin arm64, Bun 1.4.2; 8 auto workers/threads, bzip2 single-threaded.
Revision: `fd317e3ad32c`. 3 successful trial(s) per decoder. Source host: `replay187.valve.net`.
Input: 220,127,546 compressed bytes → 321,837,400 output bytes.
Input SHA-256: `ff3a48e9a72f338784023ad81291b87583058dbb1a47df1027799b35e3c7fe3d`. Output SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.

| Decoder                  | Median time | Output throughput |  Observed range |
| ------------------------ | ----------: | ----------------: | --------------: |
| bzip2                    |    10.450 s |        30.80 MB/s | 10.431–10.466 s |
| lbzip2                   |     1.607 s |       200.28 MB/s |   1.604–1.624 s |
| bzip2-codec (JS, auto)   |     2.369 s |       135.84 MB/s |   2.338–2.546 s |
| bzip2-codec (WASM, auto) |     1.843 s |       174.61 MB/s |   1.816–1.906 s |

## Intel(R) Core(TM) Ultra 9 275HX

Measurement: preloaded input, download/file reads and SHA-256 validation excluded. Includes decoder startup, streaming and output buffering.

Updated: 2026-09-14T11:38:40.464Z. linux x64, Bun 1.4.2; 24 auto workers/threads, bzip2 single-threaded.
Revision: `d780c5fb2348`. 3 successful trial(s) per decoder. Source host: `replay187.valve.net`.
Input: 220,127,546 compressed bytes → 321,837,400 output bytes.
Input SHA-256: `ff3a48e9a72f338784023ad81291b87583058dbb1a47df1027799b35e3c7fe3d`. Output SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.

| Decoder                  | Median time | Output throughput |  Observed range |
| ------------------------ | ----------: | ----------------: | --------------: |
| bzip2                    |    11.560 s |        27.84 MB/s | 11.506–11.577 s |
| lbzip2                   |     0.628 s |       512.11 MB/s |   0.615–0.675 s |
| bzip2-codec (JS, auto)   |     1.315 s |       244.69 MB/s |   1.269–1.361 s |
| bzip2-codec (WASM, auto) |     0.829 s |       388.38 MB/s |   0.821–0.837 s |
