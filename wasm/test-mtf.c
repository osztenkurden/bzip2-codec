/* Word-MTF regression oracle, compiled only by check-mtf.ts. GPL-3.0. */
#include "encoder-bridge.c"

EXPORT("test") unsigned test_mtf(void) {
  uint8_t actual[256], expected[256];
  unsigned cases = 0;
  /* Exercise every selected byte and every non-front rank, including matches
     in the last word and subtraction borrows into neighboring byte lanes. */
  for (unsigned front = 0; front < 256; front++) {
    for (unsigned rank = 0; rank < 255; rank++) {
      for (unsigned i = 0; i < 256; i++)
        actual[i] = expected[i] = (front + i + 1) & 255;
      uint8_t selected = expected[rank];
      for (unsigned i = rank; i > 0; i--) expected[i] = expected[i - 1];
      expected[0] = front;
      if (mtf_word(actual, selected, front) != rank + 2) return 0;
      for (unsigned i = 0; i < 256; i++) if (actual[i] != expected[i]) return 0;
      cases++;
    }
  }
  uint32_t seed = 42;
  uint8_t front = 0;
  for (unsigned i = 0; i < 256; i++) actual[i] = expected[i] = (i + 1) & 255;
  for (unsigned round = 0; round < 100000; round++) {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    unsigned rank = seed % 255;
    uint8_t selected = expected[rank];
    for (unsigned i = rank; i > 0; i--) expected[i] = expected[i - 1];
    expected[0] = front;
    if (mtf_word(actual, selected, front) != rank + 2) return 0;
    front = selected;
    for (unsigned i = 0; i < 256; i++) if (actual[i] != expected[i]) return 0;
    cases++;
  }
  return cases;
}
