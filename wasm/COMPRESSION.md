# Compression internals

The main and `/wasm` entries use lbzip2's `encode.c` and `divbwt.c` through
[`encoder-bridge.c`](encoder-bridge.c). The encoder is freestanding, with no host
imports and 8 MiB of fixed linear memory. See [build instructions](README.md) for
the pinned source, local MTF optimization and generated artifacts.

## Block lifecycle

Each stream or worker has a private encoder instance; the compiled WASM module is
cached. The bridge exposes input staging, collection status, output and CRC:

1. Initialize the workspace for `blockSize * 100000` bytes with `CLUSTER_FACTOR` 8.
2. Stage up to 64 KiB and call `collect`, retaining unconsumed input and RLE state
   across calls. Input chunks do not define block boundaries.
3. For a full or final nonempty block, call `encode`, then `transmit`.
4. Copy the output into JS-owned buffers before resetting the encoder for reuse.

The bridge complements lbzip2's internal block CRC before JS combines it into the
member CRC. The engine emits a `BZhN` header, ordered blocks and an end marker.
Empty input produces a valid empty member without encoding a block.

lbzip2 returns byte-aligned blocks, which are concatenated without extra padding.
JS workers instead return exact bit lengths for bit-level assembly. Each backend
produces identical single/parallel output for the same input and block size;
JS and WASM archives may differ.

## Streams and scheduling

The shared compression factory handles options, stream adapters and buffer
collection for both backends. Engines expose `push`, `finish` and `close`.
Async buffer helpers feed bounded slices through the stream and collect output.

Cooperative compression checks its accumulated work budget after each input slice
and finalization. Work carries across writes and excludes downstream idle time.
A block's encoding remains synchronous. Scheduling options and defaults are in the
[API reference](../README.md#execution-options).

## Workers and snapshots

The calling thread collects blocks; workers sort and encode them. At most twice
the worker count is outstanding, including completed results awaiting ordered
emission. Collection yields periodically. Completion, failure and cancellation
release encoder state and close the pool.

- JS tasks transfer RLE bytes and a block CRC.
- WASM tasks transfer a 276-byte header plus the collected RLE bytes. The header
  records block size, length, CRC, RLE state and alphabet map. Workers restore these
  fields into their own workspace; snapshots contain no pointers or sorting data.
- Worker scripts are embedded and loaded from Blob URLs.

See [Contributing](../CONTRIBUTING.md) for regression, interoperability, package
and benchmark commands.
