# Embedded codec sources

The main and `/wasm` entries embed [lbzip2 at revision 724352c](https://github.com/kjn/lbzip2/tree/724352c0495904ab16e33817fae85b262f319318).
`vendor/encode.c` includes a local eight-byte MTF optimization using `i64` operations
without SIMD; other vendored files are unmodified.

Upstream copyright notices and [GPL-3.0-or-later](vendor/COPYING) are retained.
The C adapters are GPL-3.0. This directory is included in the corresponding source
archive for each GitHub release, rather than in the npm package. See [NOTICE](../NOTICE)
for instructions to obtain the source matching an npm package version.

## Rebuild

To rebuild from a repository checkout, install Clang with its WASM backend and `wasm-ld`, then run:

```sh
bun run build:wasm
bun run build
```

Set `CLANG` to override the compiler. To rebuild one target, run
`bun wasm/build.ts encoder` or `bun wasm/build.ts decoder`.

| Target  | Binary         | Embedded copy               | Build manifest       | Fixed linear memory |
| ------- | -------------- | --------------------------- | -------------------- | ------------------: |
| Encoder | `encoder.wasm` | `src/wasm/encoder-bytes.ts` | `encoder-build.json` |               8 MiB |
| Decoder | `decoder.wasm` | `src/wasm/bytes.ts`         | `build.json`         |              16 MiB |

Manifests record the compiler, flags, binary digest and C/header dependency hashes.
Rebuild after C/header changes. Ordinary package builds verify the hashes and use
the embedded bytes without Clang.

## Test

Check the optimized MTF against a scalar oracle using the same Clang toolchain:

```sh
bun wasm/check-mtf.ts
```

See [Contributing](../CONTRIBUTING.md) for codec and package tests, and
[Compression internals](COMPRESSION.md) for the encoder lifecycle and workers.
