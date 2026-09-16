# Data packs

The code in this repository is MIT. The data it serves is not — see
[NOTICE.md](../NOTICE.md) before redistributing anything. What follows is how the
packs work mechanically.

## The packs

| Pack | Download | On disk | What it buys |
|---|---:|---:|---|
| `core` *(required)* | 45.8 MB | 82.9 MB | the scripture, one index that reads both Gurmukhi and Latin queries, and the query model |
| `translations` | 30.6 MB | 113.7 MB | `?tr=` and the darpan block |
| `english` | 36.8 MB | 51.0 MB | an English index and its model |
| `punjabi-extra` | 12.3 MB | 17.5 MB | a third voter, sharing the core model |
| `extra-indexes` | 26.4 MB | 34.9 MB | the last two indexes |
| `writings-<key>` | 0.5–7 MB each | 0.6–9 MB | a body of prose about Gurbani, searchable by meaning; needs `english` (see NOTICE.md, *The writings*) |

```bash
npm run fetch-data                     # the four default packs -- 125MB
npm run fetch-data -- --core-only      # 46MB
npm run fetch-data -- --all            # everything, the writings included
npm run fetch-data -- --packs writings-puran   # one author; `english` comes along, because it is required
npm run fetch-data -- --no-model       # skip the ONNX models entirely
npm run fetch-data -- --verify         # re-hash what is on disk, download nothing
npm run fetch-data -- --dry-run        # print the plan
```

`--no-model` gives a deployment where first-letter search, shabad reading and all
three neighbour endpoints work and `/api/text` returns a clean 503. That is a
supported configuration, not a broken one: a neighbour query is an item already
in the index, so its vector is read rather than computed.

Files land under `--dest` (default `./data`) as `data/artifacts/...` and
`data/models/...`, which is what `ARTIFACTS_DIR` and `MODELS_DIR` should point
at. The Docker image already defaults to `/data/artifacts` and `/data/models`.

## Why the manifest is committed

`data/manifest.json` is in git. That is the security property, not an oversight:
its hashes were reviewed in a pull request and are pinned to the code that
expects them, so a swapped or tampered release asset fails against a digest an
attacker cannot change. The fetcher **never** downloads the manifest.

`GURBANI_DATA_BASE_URL` (or `--base-url`) points the fetcher at a mirror. The
hashes still gate what is accepted, so a mirror cannot serve you different bytes
— it can only fail.

## The manifest

```jsonc
{
  "schema": 1,
  "release": "data-v1.0.0",
  "version": "e702582f3684",     // sha256 over sorted "asset:sha256", first 12
  "base_url": "https://github.com/.../releases/download/data-v1.0.0",
  "corpus": { "lines": 60403, "shabads": 5542, "angs": 1430 },
  "packs": {
    "core": {
      "required": true, "default": true, "label": "...", "why": "...",
      "bytes": 48019261, "bytes_on_disk": 86923412, "count": 18,
      "files": [{
        "asset": "core.gurbani.sqlite.gz",   // flat name in the release
        "path":  "artifacts/gurbani.sqlite", // where it lands under --dest
        "encoding": "gzip",
        "bytes": 10329289,  "sha256": "...",        // as transferred
        "bytes_plain": 31715328, "sha256_plain": "..." // as written to disk
      }]
    }
  }
}
```

`version` is content-derived: identical bytes always produce the same digest, and
any change produces a new one. It is the right cache key.

A gzipped entry carries **both** digests because the file is decompressed onto
disk rather than streamed with `Content-Encoding`. The fetcher checks `sha256`
before decompressing and `sha256_plain` after.

## How the fetcher behaves

Node built-ins only — no tar, no shell-out, no dependencies — so Windows, macOS
and Linux take the same code path.

**One asset per file, not a tarball per pack.** Node has no built-in tar reader
and hand-rolling one is exactly the code that breaks on somebody else's machine.
Per-file assets also give per-file resume, and let a re-fetch after a data update
download only the files whose hash changed. Compressing each file individually is
what keeps that from costing 35 MB against a tarball.

**A gzipped asset is downloaded whole, then decompressed.** Never streamed
through gunzip: a partially decompressed output has no defined resume offset, so
streaming would make resume impossible. This is the one non-obvious decision in
the script.

**Resume** uses HTTP `Range`. If the server answers `200` instead of `206` — some
mirrors ignore Range — the partial is discarded and the download restarts, rather
than appending to a file that would then be corrupt.

**Nothing unverified reaches a final path.** Bytes go to `<file>.part`, get
hashed, and are renamed into place only on a match. `rename` is atomic; on
Windows, where renaming over an existing file throws, the target is removed
first.

**On a hash mismatch** the partial is deleted and the file is retried **once from
byte 0 with no Range header** — the usual causes are a stale `.part` from an
earlier release or a caching proxy, and both are fixed by a clean download. If it
fails again, that file is reported and the others continue, so one bad file does
not hide the rest.

| Exit | |
|---|---|
| 0 | everything verified |
| 1 | network or filesystem error |
| 2 | a hash did not match |
| 3 | bad arguments, or an unreadable manifest |

## What is not published, and why

`corpus.sqlite` (the build-time corpus, which holds text the API never serves),
the source documents and PDFs the writings were read from, the Mahan Kosh
database, the reader packs used by a mobile bundle, the untrimmed parent model,
and every lab/experimental index. The pack builder refuses to stage any of them,
and refuses outright if the translations database has grown a `kind='note'` row
— Sahib Singh's side notes never leave the server.

A pack may declare `requires`: the fetcher adds those packs whether or not they
were asked for. The writings packs require `english`, whose model embeds their
queries.
