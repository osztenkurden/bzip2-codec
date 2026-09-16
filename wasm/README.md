# Embedded codec sources

The `bzip2-codec/wasm` entry uses the low-level encoder and decoder from [lbzip2](https://github.com/kjn/lbzip2/tree/724352c0495904ab16e33817fae85b262f319318), pinned at commit `724352c0495904ab16e33817fae85b262f319318`. Files in `vendor/` are unmodified; copyright notices and the upstream GPL-3.0-or-later license (`vendor/COPYING`) are retained. The adapters `bridge.c` and `encoder-bridge.c` are GPL-3.0. This directory is included in npm packages as corresponding source for the embedded binaries.

To rebuild from a repository checkout, install Clang with its WASM backend and `wasm-ld`, then run:

```sh
bun run build:wasm
bun run build
```

`CLANG` can override the compiler executable. The generated `decoder.wasm` and `src/wasm/bytes.ts` contain the same decoder binary; `encoder.wasm` and `src/wasm/encoder-bytes.ts` contain the same encoder binary. `build.json` and `encoder-build.json` record compiler version, flags, digests and all C/header source hashes. The decoder has 16 MiB fixed linear memory and the encoder has 8 MiB. Ordinary package builds validate those hashes and use the prebuilt bytes; they do not require Clang. C/header changes require rebuilding the binary first.

Test with `npm test`, `bun run test:parallel`, and (after building) `bun run test:package`.

Encoder architecture, compact worker snapshots, and scheduling are described in [the compression implementation plan](COMPRESSION.md).
