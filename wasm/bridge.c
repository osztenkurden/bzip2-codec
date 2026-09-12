/* Experimental freestanding adapter for lbzip2. SPDX-License-Identifier: GPL-3.0-or-later */
#include "vendor/common.h"
#include "vendor/decode.h"

#define EXPORT(name) __attribute__((export_name(name)))
#define INPUT_CAPACITY (4 * 1024 * 1024)
#define OUTPUT_CAPACITY (1024 * 1024)
static _Alignas(16) unsigned char arena[4 * 1024 * 1024];
static _Alignas(16) unsigned char input[INPUT_CAPACITY + 8];
static unsigned char output[OUTPUT_CAPACITY];
static size_t allocated;
static struct decoder_state decoder;
static unsigned end_position, output_length, expected_crc;

void *memcpy(void *dst, const void *src, size_t n) {
  unsigned char *d = dst; const unsigned char *s = src;
  for (size_t i = 0; i < n; i++) d[i] = s[i];
  return dst;
}
void *memset(void *dst, int value, size_t n) {
  unsigned char *d = dst;
  for (size_t i = 0; i < n; i++) d[i] = value;
  return dst;
}
void *xmalloc(size_t n) {
  n = (n + 15) & ~(size_t)15;
  if (n > sizeof(arena) - allocated) __builtin_trap();
  void *result = arena + allocated; allocated += n; return result;
}
void free(void *p) { (void)p; } /* Arena is reset before each independent block. */
_Noreturn void abort(void) { __builtin_trap(); }

/* lbzip2's permissive/packed header reader differs from the JS API. This
   bounded preflight preserves JS's per-delta and unused-table validation.
   It is outside the per-symbol decoding loop. */
struct bits { unsigned pos, limit; bool failed; };
static unsigned take(struct bits *b, unsigned count) {
  if (count > b->limit - b->pos) { b->failed = true; return 0; }
  unsigned value = 0;
  while (count--) { value = (value << 1) | ((input[b->pos / 8] >> (7 - (b->pos & 7))) & 1); b->pos++; }
  return value;
}
static bool header_ok(unsigned length, unsigned offset, unsigned maximum) {
  struct bits b = { offset, length * 8, false };
  if (take(&b, 24) != 0x314159 || take(&b, 24) != 0x265359) return false;
  expected_crc = take(&b, 32);
  take(&b, 1);
  if (take(&b, 24) >= maximum) return false;
  unsigned groups = take(&b, 16), symbols = 0;
  for (unsigned g = 0; g < 16; g++) if (groups & (1u << (15 - g))) symbols += __builtin_popcount(take(&b, 16));
  if (!symbols) return false;
  unsigned trees = take(&b, 3), selectors = take(&b, 15);
  if (trees < 2 || trees > 6 || !selectors) return false;
  for (unsigned s = 0; s < selectors; s++) {
    unsigned index = 0;
    while (take(&b, 1)) if (++index >= trees) return false;
    if (b.failed) return false;
  }
  for (unsigned t = 0; t < trees; t++) {
    unsigned counts[21] = {0}; int current = take(&b, 5);
    for (unsigned s = 0; s < symbols + 2; s++) {
      while (take(&b, 1)) {
        current += take(&b, 1) ? -1 : 1;
        if (current < 1 || current > 20 || b.failed) return false;
      }
      if (current < 1 || current > 20 || b.failed) return false;
      counts[current]++;
    }
    int remaining = 1;
    for (unsigned k = 1; k <= 20; k++) { remaining = 2 * remaining - counts[k]; if (remaining < 0) return false; }
  }
  return !b.failed;
}

EXPORT("input") unsigned char *input_pointer(void) { return input; }
EXPORT("output") unsigned char *output_pointer(void) { return output; }
EXPORT("outputLength") unsigned produced(void) { return output_length; }
EXPORT("endPosition") unsigned end(void) { return end_position; }
EXPORT("crc") unsigned crc(void) { return decoder.crc; }

EXPORT("start") int start(unsigned length, unsigned offset, unsigned maximum) {
  if (length > INPUT_CAPACITY || offset > 7 || length * 8 < offset + 105 || maximum == 0 || maximum > MAX_BLOCK_SIZE) return -1;
  if (!header_ok(length, offset, maximum)) return -1;
  allocated = 0;
  memset(&decoder, 0, sizeof(decoder));
  decoder_init(&decoder);
  /* The native reader looks ahead in 32-bit words. Pad lookahead but reject
     any successful decode that actually consumed padding beyond real input. */
  unsigned padded = (length + 3) & ~3u;
  memset(input + length, 0, padded + 8 - length);
  unsigned payload = offset + 80;
  unsigned word = payload / 32, skip = payload & 31;
  uint32_t *words = (uint32_t *)input;
  struct bitstream bs = {0};
  bs.live = 32 - skip;
  bs.buff = (uint64_t)__builtin_bswap32(words[word]) << (32 + skip);
  bs.data = words + word + 1;
  bs.limit = words + padded / 4 + 2;
  bs.eof = true;
  int status = retrieve(&decoder, &bs);
  if (status != OK || decoder.block_size > maximum) return -1;
  end_position = (unsigned)(bs.data - words) * 32 - bs.live;
  if (end_position > length * 8) return -1;
  decode(&decoder);
  return 0;
}

/* Return 0 when complete, 1 when more output is available, -1 on error. */
EXPORT("emit") int emit_output(unsigned capacity) {
  if (!capacity || capacity > OUTPUT_CAPACITY) return -1;
  size_t remaining = capacity;
  int status = emit(&decoder, output, &remaining);
  output_length = capacity - remaining;
  if (status == OK) return decoder.crc == expected_crc ? 0 : -1;
  return status == MORE ? 1 : -1;
}
