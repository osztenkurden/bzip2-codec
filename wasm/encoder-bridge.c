/* Freestanding lbzip2 encoder adapter. SPDX-License-Identifier: GPL-3.0 */
/* Include the pinned implementation to access its private collected-block fields.
   Snapshot only RLE input and scalar state, never sorting workspace or pointers. */
#include "vendor/encode.c"

#define EXPORT(name) __attribute__((export_name(name)))
#define INPUT_CAPACITY 65536
static _Alignas(16) unsigned char arena[5 * 1024 * 1024];
static unsigned char input[INPUT_CAPACITY];
static struct encoder_state *encoder;
static unsigned ready, pending, output_length, block_crc;
static void *output;
static struct block_snapshot {
  uint32_t maximum, length, crc, character;
  int32_t run;
  unsigned char cmap[256];
  unsigned char block[MAX_BLOCK_SIZE];
} snapshot;

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
_Noreturn void abort(void) { __builtin_trap(); }

EXPORT("init") int init(unsigned size) {
  if (!size || size > MAX_BLOCK_SIZE || encoder_alloc_size(size) > sizeof(arena)) return -1;
  encoder = (void *)arena;
  encoder_init(encoder, size, CLUSTER_FACTOR);
  ready = pending = output_length = 0;
  output = 0;
  return 0;
}
EXPORT("input") unsigned char *input_pointer(void) { return input; }
EXPORT("ready") unsigned block_ready(void) { return ready; }
EXPORT("output") void *output_pointer(void) { return output; }
EXPORT("crc") unsigned crc(void) { return block_crc; }
EXPORT("snapshot") void *snapshot_pointer(void) { return &snapshot; }
EXPORT("snapshotCapacity") unsigned snapshot_capacity(void) { return sizeof(snapshot); }

EXPORT("save") int save_block(void) {
  if (!encoder || !pending || output_length) return -1;
  snapshot.maximum = encoder->max_block_size;
  snapshot.length = encoder->nblock;
  snapshot.crc = encoder->block_crc;
  snapshot.character = encoder->rle_character;
  snapshot.run = encoder->rle_state;
  memcpy(snapshot.cmap, encoder->cmap, 256);
  memcpy(snapshot.block, (void *)(encoder->SA + encoder->max_block_size + GROUP_SIZE), snapshot.length);
  return offsetof(struct block_snapshot, block) + snapshot.length;
}

EXPORT("restore") int restore_block(unsigned length) {
  if (length < offsetof(struct block_snapshot, block) ||
      snapshot.length == 0 || snapshot.length > snapshot.maximum ||
      length != offsetof(struct block_snapshot, block) + snapshot.length ||
      snapshot.character > 255 || snapshot.run < -1 || snapshot.run > 258 ||
      init(snapshot.maximum) != 0) return -1;
  encoder->nblock = snapshot.length;
  encoder->block_crc = snapshot.crc;
  encoder->rle_character = snapshot.character;
  encoder->rle_state = snapshot.run;
  memcpy(encoder->cmap, snapshot.cmap, 256);
  memcpy((void *)(encoder->SA + encoder->max_block_size + GROUP_SIZE), snapshot.block, snapshot.length);
  pending = ready = 1;
  return 0;
}

/* Return consumed bytes; preserve unconsumed staging bytes across block resets. */
EXPORT("collect") int collect_input(unsigned offset, unsigned length) {
  if (!encoder || ready || output_length || offset > INPUT_CAPACITY || length > INPUT_CAPACITY - offset) return -1;
  size_t remaining = length;
  ready = collect(encoder, input + offset, &remaining);
  unsigned consumed = length - remaining;
  pending |= consumed != 0;
  return consumed;
}

/* lbzip2 returns byte-aligned blocks in encoder-owned storage. */
EXPORT("encode") int encode_block(void) {
  if (!encoder || !pending || output_length) return -1;
  output_length = encode(encoder, &block_crc);
  output = transmit(encoder, 0);
  block_crc ^= 0xFFFFFFFFu;
  return output_length;
}
