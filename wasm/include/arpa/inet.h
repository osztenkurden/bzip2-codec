#define ntohl(x) __builtin_bswap32(x)
#define htonl(x) __builtin_bswap32(x)
