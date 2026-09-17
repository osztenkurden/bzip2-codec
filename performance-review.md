# Compression review — 2026-09-17

## Environment and reproducibility

Work started on a clean `cli` at `f040e95071322f5765201dc792613106ed31bbe3`.
`origin/master` was `502da96`; decompression optimizations `d780c5f` and
`88357d1` were inspected. Final results use that revision plus this uncommitted
working-tree change. No existing implementation changes were discarded.

- Linux aarch64; `lscpu` reports Apple vendor, model 0, four logical CPUs,
  one thread per core. The VM does **not** expose the physical Apple chip model.
- Container CPU quota: `300000 / 100000` = three CPUs. Memory limit: 4 GiB.
  Bun `os.availableParallelism()` and `navigator.hardwareConcurrency` both report 3.
- Bun 1.3.14 (`0d9b296af`); bzip2 1.0.8; lbzip2 2.5.
  The default Node is 20.19.2, below the package requirement. Node validation used
  Node 24.21.0 via `npx --yes --package=node@24`.
- Actual concurrency: bzip2 1; library single-thread 1; library auto 3 workers;
  lbzip2 `-n 4` (all visible logical CPUs, matching the decoder benchmark).
- Compression block size 9; three separate-process rounds per method, rotated
  method order. Each trial preloads input, streams 64 KiB input chunks and retains
  output. Startup, worker startup, collection, native pipes and output buffering
  are timed; input loading, hashes and round-trip validation are excluded.

Inputs supplied by the user, both verified available:

| Input under `~/workspaces/`                |     Bytes | SHA-256                                                            |
| ------------------------------------------ | --------: | ------------------------------------------------------------------ |
| `003842189672549712349_0179118028.dem`     | 321837400 | `8c79250cc0e4d90ae076a022c0802f312a6058f05beddcff65de883d16214f02` |
| `003842189672549712349_0179118028.dem.bz2` | 220127546 | `ff3a48e9a72f338784023ad81291b87583058dbb1a47df1027799b35e3c7fe3d` |

`bzip2 -dc` of the supplied archive produced the raw input hash. Full real-input
JS and WASM worker compression was also piped through native `bzip2 -dc`; both
produced that same hash.

### Preserved evidence

Fresh baselines were captured **before encoder changes**, separately from final
results. The only baseline modification was the benchmark memory fix described
below. These machine-local files retain the full precision, hashes and CPU usage:

- `/tmp/opencode/compression-baseline-owned.md.json`
- `/tmp/opencode/decompression-baseline-owned.md.json`
- `/tmp/opencode/compression-final.md.json`
- `/tmp/opencode/decompression-after.md.json`
- `/tmp/opencode/corpus-baseline.json`, `/tmp/opencode/corpus-after.json`
- CPU profiles: `/tmp/opencode/encoder-baseline`, `encoder-induced`,
  `encoder-cyclic`, `encoder-final`, `encoder-parallel-main`.

The `encoder-final` profile is of the subsequently rejected accumulator
experiment; `encoder-cyclic` is an intermediate retained implementation profile.
The tables below preserve all real-input trial times to millisecond precision
independently of those temporary files. Historical benchmark reports from other
machines were not used as baselines.

Reproduce with distinct report paths to avoid overwriting evidence:

```sh
BZIP_COMPRESS_REPORT=/tmp/compression-new.md bun run benchmark:compress ~/workspaces/003842189672549712349_0179118028.dem 3
BZIP_BENCHMARK_REPORT=/tmp/decompression-new.md bun benchmark.ts ~/workspaces/003842189672549712349_0179118028.dem.bz2 3
bun --cpu-prof-md scripts/profile-compression.ts ~/workspaces/003842189672549712349_0179118028.dem 16 3
bun scripts/benchmark-compression-corpus.ts src/js.ts /tmp/corpus-new.json
```

Both focused scripts accept a different source module path, allowing comparison
against an extracted `git archive f040e95` without modifying the working tree.

## Real-input compression

Times are seconds, in round order. Median speedup compares the fresh baseline
to final code, not to the older Ryzen report.

| Method           | Before trials             | After trials           | Median before → after |   Speedup | Compressed bytes (both) |
| ---------------- | ------------------------- | ---------------------- | --------------------- | --------: | ----------------------: |
| bzip2, 1         | 19.694, 19.853, 19.889    | 19.903, 19.759, 19.833 | 19.853 → 19.833       |     1.00× |               220127546 |
| JS, 1            | 157.663, 158.328, 158.494 | 33.291, 33.755, 33.339 | 158.328 → 33.339      | **4.75×** |               220191521 |
| WASM, 1          | 18.348, 18.553, 18.431    | 18.330, 18.408, 18.404 | 18.431 → 18.404       |     1.00× |               220010648 |
| lbzip2, all CPUs | 6.058, 6.134, 6.123       | 6.043, 6.104, 6.081    | 6.123 → 6.081         |     1.01× |               220023656 |
| JS, auto         | 91.190, 93.157, 94.086    | 13.402, 13.525, 13.629 | 93.157 → 13.525       | **6.89×** |               220191521 |
| WASM, auto       | 7.075, 7.009, 7.055       | 7.038, 6.995, 7.101    | 7.055 → 7.038         |     1.00× |               220010648 |

JS throughput is now 9.65 MB/s single-thread and 23.80 MB/s auto. Worker speedup
improved from 1.70× to 2.47×. Single-thread JS still takes **1.68× bzip2's time**;
auto JS takes **2.22× lbzip2's time**. The native-competitive decompression target
has not yet been reached for compression.

On this replay, output bytes are unchanged, not just output sizes:

- JS SHA-256: `ebfd48c3c163dac6054322d6f9b5b1babd06608cd6f364f414d23bb60412af1f`
- WASM SHA-256: `77f6094122dc30797afeeaf4a6988c16b09ae654dfcc679a0e92b61d0b4af4e3`

These match before/after, single/parallel and all rounds within each backend.
In general the new sorter can select a different origin among equal periodic
rotations, so archives are not promised identical to previous releases.

## Decompression control

| Method           | Before trials (s)      | After trials (s)       | Median before → after (s) |
| ---------------- | ---------------------- | ---------------------- | ------------------------- |
| bzip2, 1         | 11.352, 11.180, 11.218 | 11.157, 11.150, 11.151 | 11.218 → 11.151           |
| JS, 1            | 9.902, 9.903, 9.926    | 9.865, 9.859, 9.894    | 9.903 → 9.865             |
| WASM, 1          | 8.412, 8.394, 8.424    | 8.392, 8.398, 8.368    | 8.412 → 8.392             |
| lbzip2, all CPUs | 2.950, 2.944, 2.952    | 2.903, 2.933, 2.942    | 2.950 → 2.933             |
| JS, auto         | 4.498, 4.270, 4.479    | 4.330, 4.254, 4.336    | 4.479 → 4.330             |
| WASM, auto       | 3.319, 3.299, 3.328    | 3.272, 3.295, 3.339    | 3.319 → 3.295             |

No measured decoder regression. Small control improvements are treated as
run-to-run variation, not optimization claims. JS single-thread decompression
remains faster than the native single-core reference on this machine.

## Profiling, retained changes, and rejected experiments

The old decompression changes used local hot-loop state, grouped MTF, bulk CRC,
bit accumulators and removal of speculative repeated work. Compression profiling
identified where those lessons actually apply:

1. **Sorting dominated (~70% of initial samples).** Replace full-block prefix
   doubling with cyclic induced sorting. Classify S/L rows, sort LMS substrings,
   recurse on their names, and induce the remaining rows. Each recursive problem
   has at most half the rows; uniform/periodic inputs terminate without repeated
   long-prefix passes. `lbzip2`'s vendored `divbwt.c` informed the induced-row and
   cyclic-boundary approach; this is not a line-for-line divsufsort port.
2. **Avoid doubled text.** An initial sentinel/doubled-text SA-IS implementation
   improved the 16 MiB sample from ~10.5 s to ~4.5 s. Direct cyclic sorting reduced
   work and allocation further. Extracting the induction loop from its closure
   removed a pronounced JIT warmup penalty; using one integer-array representation
   for initial and recursive inputs avoids polymorphic hot-loop access.
3. **Grouped forward MTF.** A simple lbzip2-style search-and-shift was only a small
   improvement. Drifting 16-byte rows with physical-position and row maps reduced
   the focused sample from ~2.23 s to ~2.00 s. At most 15 entries within a row and
   15 row-boundary entries move, rather than updating up to 255 inverse ranks.
4. **Huffman selection.** Add two independent 16-bit costs per integer and scan
   the symbols once for all six candidate tables. A 50-symbol group's maximum
   cost cannot carry between lanes. Preserve four refinement iterations, tie
   selection and code construction, hence no compression-ratio tradeoff.
5. **CRC/RLE collection.** Keep RLE state local and update CRC over each raw span
   between block boundaries with the existing slice-by-four routine. This removes
   per-byte method calls without changing block formation. The focused sample
   fell from ~2.00 s to ~1.80 s; it also reduces caller-thread work for workers.
6. **Bit output.** Replace bit-at-a-time exponentiation with up-to-eight-bit
   writes. Batch unaligned worker-block stitching to the output buffer capacity.
   A focused 28 MiB stitching trial fell from 69.8–103.2 ms to 22.5–33.1 ms.
   A separate wider-accumulator implementation slightly worsened the encoder
   sample (~1.82–1.84 s versus ~1.79–1.81 s) and was discarded.

Typed-array iterator overhead was also removed from the large encoder loops.
No workspace pool, backend-specific scheduling policy, or Huffman-ratio shortcut
was added. WASM/native controls were already close; no unmeasured WASM rewrite
was justified.

## Varied inputs, memory and responsiveness

The corpus script checks JS and native round trips and deterministic output for
every block size 1–9. It measures three rounds after a warmup per case. Non-small
inputs contain 1,800,100 bytes, crossing multiple blocks even at block size 9
(except RLE-compressible data, whose encoded block is intentionally tiny).

Representative **block size 9** results:

| Input                   | Before median (range), ms | After median (range), ms | Output bytes, before = after |
| ----------------------- | ------------------------- | ------------------------ | ---------------------------: |
| Seeded random           | 468.31 (467.68–468.72)    | 186.27 (186.08–186.54)   |                      1807726 |
| Repeated sentence       | 332.88 (332.41–332.95)    | 65.14 (64.86–65.78)      |                          635 |
| Repeated byte           | 40.98 (40.51–41.04)       | 7.34 (7.32–7.65)         |                           49 |
| Period-251 sequence     | 347.81 (346.89–348.47)    | 42.34 (41.86–42.97)      |                         2179 |
| Small random, 127 bytes | 0.348 (0.338–0.417)       | 0.328 (0.314–0.423)      |                          201 |

Sizes matched for **all 45 cases**. Tiny timings are JIT/allocation-sensitive;
no small-input speedup is claimed. Earlier repeated-byte rounds in the baseline
showed substantial warmup, so the complete corpus JSON should be used rather
than averaging across block sizes.

Three 32 MiB real-input async-buffer trials (including output concatenation):

- Cooperative JS before: 18.94–19.82 s, maximum 1 ms timer gaps 618–748 ms,
  process RSS high-water 803292 KiB.
- Cooperative JS after: 3.56–3.71 s, gaps 101–162 ms,
  RSS high-water 200548 KiB.
- Auto JS after: ~1.93–2.11 s in the last focused run, gaps 40–69 ms,
  RSS high-water 319080 KiB. Four-worker trials took 2.21–2.33 s, so automatic
  concurrency remains three under this CPU quota.

RSS is a process high-water mark, includes the runtime, retained input/output and
JIT, and is not a per-block allocation measurement. Timers are responsiveness
observations, not deadline guarantees. Sorting still executes a whole block before
cooperative yielding; an 8 ms yield budget is not an 8 ms maximum pause.

The caller-thread worker profile identified collection and unaligned bit stitching
as its primary JS work; `postMessage` itself was a small sampled contributor.
Three-worker process CPU time was close to three times wall time on the focused
sample. This supports good CPU utilization but is not a direct queue occupancy
measurement. At most twice the worker count is outstanding, including completed
out-of-order blocks; dedicated stalled-worker tests verify that limit and cleanup.

## Quality and correctness review

- **Benchmark ownership:** retaining Bun native-pipe views caused exit 137 under
  the 4 GiB limit. Compact native chunks and avoid a redundant full input copy.
  Both baseline suites were rerun successfully with this harness fix; failed
  initial attempts remain separately recorded. Comparison conditions match.
- **Cancellation:** Bun 1.3.14 ignores `Transformer.cancel`. Standard readable
  source cancellation and writable sink abort hooks now close the engine; the
  writable controller signal also handles in-flight abort on runtimes exposing it.
  Apply this to compression and parallel decompression. Existing pending-reader
  cancellation, worker-error and packaged Blob revocation tests now pass here.
- **Runtime limitation:** Bun 1.3.14 also lacks `WritableStreamDefaultController.signal`.
  Writable-only abort during a permanently stalled in-flight write cannot use
  that early signal on this runtime; cancel the readable side to interrupt such
  a wait. Idle writable abort and readable cancellation are covered. This is not
  presented as universally fixed abort behavior.
- **Worker typing:** use typed `MessageEvent` inputs and checked compression
  outcomes without casting `globalThis`. Remove the unnecessary navigator cast
  and fabricated `undefined as unknown as WorkerHandle` initialization. Actual
  DOM/Bun compiler configuration typechecks these accesses.
- **Ownership and WASM:** preserve copied JS task buffers, WASM snapshots and
  emitted bytes before native workspace reuse. Transfer only owned buffers.
  WASM state remains per stream; its fixed memory prevents stale growable-memory
  views. Shared immutable module compilation is appropriate.
- **Format and scheduling:** preserve block limits, first-stage RLE, bit-exact
  worker assembly, member CRC rotation, ordered emission, bounded worker jobs,
  lazy startup and accumulated cooperative work budgets. API unions and permissive
  handling of recognized but inapplicable runtime options are unchanged.

Regression coverage includes exhaustive ternary cyclic strings through length 8,
rotation-oracle checks, periodic and long-prefix inputs, MTF partial alphabets and
area compaction, every bit-write width/alignment including signed CRCs, and CRC/RLE
at chunk/full-block boundaries. Existing tests cover single/parallel byte equality,
block sizes 1–9, fragmented streams, native interoperability, output ownership,
worker failures and bounded outstanding work.

Remaining measured bottlenecks are induced-sort memory access, MTF and Huffman
emission. Reusing sorter scratch space or fusing BWT/MTF may help, but those are
future hypotheses, not gains claimed by this review.

## Validation completed

- TypeScript typecheck and `git diff --check` passed; changed files formatted.
- Full Node 24 suite: 90 passed, 59 environment/opt-in skips; the subsequently
  added cancellation suite also passed both tests on Node 24.
- Bun worker/WASM suite: 38 passed. The >512 MiB parallel-offset test passed.
- Built package and CLI suite with Node 24 on PATH: 42 passed, including embedded
  Blob workers, cleanup, JS-only loading and both backends.
- Build passed with supported Node 24 and with Bun; package dry-run passed.
  The default Node 20 build failure was resolved by using the supported runtime,
  without changing dependencies or the lockfile.
- Explicit native interoperability suite passed, as did full replay native
  decoding, all 45 generated corpus cases, and repeated benchmark hash checks.
- Dedicated cancellation suite: readable cancellation passed on Bun; early
  writable-abort coverage is skipped there because its controller lacks `signal`,
  and passes on Node 24. The limitation is stated above.

The optional local-fixture test uses a different, absent replay; the supplied
321.8 MB replay was validated through the benchmark and CLI checks instead.
