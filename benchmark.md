# Decompression benchmarks

Run `bun benchmark.ts '<archive-url>'` to add or update this machine's CPU section.
Each result measures a fresh IPv4 HTTP fetch → decoder → SHA-256 sink, with no output file.
Times include networking and hashing; compare machines only with comparable input and network conditions.

## AMD Ryzen 7 5800X 8-Core Processor

Updated: 2026-09-12T09:24:25.985Z. linux x64, Bun 1.4.2; 16 auto workers/threads, bzip2 single-threaded.
Revision: `90851d7854e8` (working tree has changes). 3 successful trial(s) per decoder. Source host: `localhost`.
Input: 220,127,546 compressed bytes → 321,837,400 output bytes.
Input SHA-256: `ff3a48e9a72f338784023ad81291b87583058dbb1a47df1027799b35e3c7fe3d`. Output SHA-256: `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02`.

| Decoder                  | Median time | Output throughput |  Observed range |
| ------------------------ | ----------: | ----------------: | --------------: |
| bzip2                    |    13.014 s |        24.73 MB/s | 12.832–13.318 s |
| lbzip2                   |     1.290 s |       249.53 MB/s |   1.138–1.291 s |
| bzip2-codec (JS, auto)   |     2.199 s |       146.33 MB/s |   2.175–2.286 s |
| bzip2-codec (WASM, auto) |     1.481 s |       217.34 MB/s |   1.456–1.587 s |
