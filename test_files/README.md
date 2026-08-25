# Local test files

Files in this directory are ignored because bzip2 fixtures and decompressed demo data can be very large.

The optional large-file test and memory report use this fixture by default:

```text
003838660961779056911_2094919404.dem.bz2
```

You can instead pass another local bzip2 file to the memory report:

```sh
bun run memory:decompress -- path/to/file.bz2
```

Small fixtures intended for source control belong in `test/fixtures/`.
