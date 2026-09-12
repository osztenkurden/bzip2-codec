# Embedded decoder source

The `bzip2-codec/wasm` entry uses the low-level decoder from [lbzip2](https://github.com/kjn/lbzip2/tree/724352c0495904ab16e33817fae85b262f319318), pinned at commit `724352c0495904ab16e33817fae85b262f319318`. Files in `vendor/` are unmodified; copyright notices and the upstream GPL-3.0-or-later license (`vendor/COPYING`) are retained. The adapter `bridge.c` is GPL-3.0-or-later. This directory is included in npm packages as corresponding source for the embedded binary.

To rebuild from a repository checkout, install Clang with its WASM backend and `wasm-ld`, then run:

```sh
bun run build:wasm
bun run build
```

`CLANG` can override the compiler executable. The generated `decoder.wasm` and `src/wasm/bytes.ts` contain the same binary. `build.json` records compiler version, flags, digest and all C/header source hashes. Ordinary package builds validate those hashes and use the prebuilt bytes; they do not require Clang. C/header changes require rebuilding the binary first.

Test with `npm test`, `bun run test:parallel`, and (after building) `bun run test:package`.
