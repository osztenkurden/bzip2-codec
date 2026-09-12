/* Retain invariants as WASM traps, caught by the JS compatibility fallback. */
#define assert(x) ((x) ? (void)0 : __builtin_trap())
