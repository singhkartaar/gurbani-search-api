# API reference

Base URL is wherever you deployed it. Every response is JSON. Errors are
`{"error": "...", "code": <status>}` and the HTTP status matches `code`.

Only `GET` and `HEAD` are accepted; anything else is **405**. If `APP_PASSWORD`
is set, every route except `/api/health` requires HTTP Basic with any username.

**Versioning.** Every response carries `X-API-Version`, and `/api/health` reports
`api_version`. Within a major version, fields are added and never removed or
repurposed. There is no `/v1/` path prefix on purpose -- one that maps to
whatever is current is worse than none. A machine-readable description of
everything below is in [openapi.yaml](../openapi.yaml).

**Rate limiting.** Off unless `RATE_LIMIT_PER_MINUTE` is set. Over the limit
is a 429 carrying `Retry-After`; `X-RateLimit-Limit`, `-Remaining` and `-Reset`
ride on every response. `/api/health` is never counted. See `/api/health`'s
`rate_limit` block for what a deployment is running.

**Cross-origin.** Off unless `CORS_ORIGINS` is set, in which case `OPTIONS`
preflights are answered 204 and allowed responses carry
`Access-Control-Allow-Origin` and `Vary: Origin`. A named origin may also send
credentials; `*` never may. See the README, and `/api/health`'s `cors` block for
what a given deployment is running.

**Start with `/api/health`.** It tells you which indexes this deployment loaded,
which of them can do free-text search, and which translations exist. A
deployment with one index and no translations is a perfectly normal deployment,
and a client that assumes five indexes and `tr_en` will break on it.

---

## `GET /api/health`

Never requires credentials, so it works as a container health check.

```json
{
  "ok": true,
  "lines": 60403,
  "indexes": { "pa-ssa": { "loaded": true, "freeText": true, "text_lang": "pa",
                           "query_scripts": ["gurmukhi", "latin"], "roles": ["neighbours","text","ask"],
                           "label": "...", "order": 15, "agreement": null } },
  "sources": ["pa-ssa"],
  "default_index": "pa-ssa",
  "translations": { "en": true, "pa": true, "pad": true, "fk": true },
  "api_version": "1.0.0",
  "cors": { "enabled": false },
  "rate_limit": { "enabled": false },
  "logging": { "enabled": false },
  "semantic": true,
  "freeText": true
}
```

`sources` is the loaded indexes in display order. `default_index` is what a
request that names no index gets — note it is *resolved*, so if the configured
`DEFAULT_INDEX` did not load, this reports the one that took over.

---

## `GET /api/text` — search by meaning

| Parameter | Default | |
|---|---|---|
| `q` | — | the query, English or Gurmukhi. Empty returns no results, not an error |
| `k` | 15 | 1–50 |
| `level` | `lines` | or `shabads` — use `shabads` for thematic questions |
| `index` | the default | an index name, or `all` |
| `tr` | none | `en`, `pa`, `pad`, `fk`, comma-separated (`level=lines` only) |

```
GET /api/text?q=how+do+I+overcome+the+fear+of+death&k=8&index=all&tr=en,pa
```

**Use `index=all`.** Every loaded index that has a query encoder and can read the
query's script votes, and the lists are fused by reciprocal rank. Each result
then carries `votes` — how many sources agreed. That is the most useful trust
signal the API gives you.

```json
{
  "index": "all", "indexes": ["en-ss", "pa-ssa", "pa-ft"],
  "score_kind": "rrf", "query": "fear of death", "level": "lines", "ms": 140,
  "results": [{
    "line_id": 13203, "shabad_id": 1054, "ang": 291,
    "gurmukhi_uni": "ਤਬ ਜਮ ਕੀ ਤ੍ਰਾਸ ਕਹਹੁ ਕਿਸੁ ਹੋਇ ॥",
    "translit_roman": "tab jam kee traas kahahu kis hoi ||",
    "kind": "line", "score": 0.032787, "votes": 2,
    "tr_en": "then who was afraid of death?"
  }]
}
```

**`score_kind` decides how to read `score`.** With one index it is a cosine
similarity and comparable across queries. With `index=all` it is `"rrf"` — a
fusion rank whose absolute value means nothing. Compare results to each other,
never to a threshold.

**A query in a script the index cannot read is a 400**, not a bad answer. A
Gurmukhi query against an English index would otherwise reach a WordPiece
tokenizer that renders every letter as `[UNK]` and returns confident nonsense.
`index=all` filters to capable indexes instead, and returns 503 if none can read
it.

Needs a query model. Without one: **503**, and every other endpoint still works.

---

## `GET /api/writings/search` — search a body of writing by meaning

The writings are prose *about* Gurbani -- essays, commentaries, biographies --
each a corpus with its own id space, its own model and its own data pack
(`writings-<key>`). `/api/health`'s `corpora` lists the ones this deployment
carries and whether each can be searched.

| Parameter | Default | |
|---|---|---|
| `q` | — | the query, in a script the corpus's model reads (English for the English corpora). Empty returns no results |
| `corpus` | `writings` | a key from `/api/health`, `all`, or a comma list |
| `work` | none | a `work` id from `/api/writings`; one corpus only |
| `k` | 10 | clamped to the server's `WRITINGS_SEARCH_MAX` |
| `cites` | — | `1` also returns the cited shabads whole, as `sources` |

```
GET /api/writings/search?q=how+to+overcome+the+fear+of+death&corpus=puran&k=5&cites=1
```

```json
{
  "corpus": "puran", "corpora": ["puran"], "query": "how to overcome the fear of death",
  "score_kind": "cosine", "min_ratio": 0, "min_score": 0, "ms": 31,
  "results": [{
    "corpus": "puran", "unit_row": 2114, "work": "spirit-of-the-sikh-2",
    "title": "Spirit of the Sikh", "author": "Prof. Puran Singh", "original": true,
    "part": "2", "page": 44, "score": 0.422,
    "text": "Death has no terror for them. Fear is destroyed, for it is the light of God in which they live and breathe. ...",
    "cites": []
  }],
  "sources": []
}
```

**Whole passages, a bounded number of them.** A result is the passage itself,
not a snippet, with its book, part, page and author, `original` (written in
this language, as opposed to translated) and the shabads it cites. At most
`WRITINGS_SEARCH_MAX` come back, best first.

**There is no relevance filter, by measurement.** `min_ratio` and `min_score`
are both 0 by default and are knobs, not policy. Across the five corpora, eight
on-topic queries against six off-topic ones: an absolute cosine cannot separate
them (an off-topic query scores 0.50 against one author while a subject he wrote
about at length tops out at 0.35); a z-score of the best hit against the whole
corpus overlaps (4.48..6.14 on-topic, 4.03..5.79 off-topic); and a relative
floor is backwards -- at 0.75 it kept 77% of on-topic rows and 87% of off-topic
ones, because an off-topic query has flat scores the ratio spares while an
on-topic one has a tail the ratio cuts.

`bge-small`'s cosines rank passages; they do not say whether anything is near.
So `score` is comparable only within one response, never against a threshold of
your own, and an off-topic question gets a full list of nearest-but-unrelated
passages. Filtering that needs a model reading question and passage together.

**`corpus=all` fuses by rank** (`score_kind: "rrf"`), as `/api/text?index=all`
does, because each corpus has its own PCA space and their cosines are not
comparable. `work` cannot be combined with it.

**`unit_row` is a passage id, never a Gurbani id.** The corpora keep their own
id space precisely so a passage number can never be mistaken for a line of the
Granth; the only bridge is `cites`, which names shabads.

A query in a script the model cannot read is a **400**. Needs the corpus's
query model: without it, **503**, and every other endpoint still works.

---

## `GET /api/writings` — the roster of a corpus

`corpus` (default `writings`). Returns the author, the model, the counts and
the `works` -- each with `work`, `title`, `title_en`, `author`, `parts`,
`units`, `original` and `quote_policy`. A `work` value is what the search route's
`work` parameter takes.

---

## `GET /api/fl` — search by first letters

| Parameter | Default | |
|---|---|---|
| `q` | — | first letter of each word, ASCII (`gnm`) or Gurmukhi (`ਗਨਮ`) |
| `limit` | 25 | 1–100 |
| `mode` | `anywhere` | or `start`, matching only from the first word |
| `tr` | none | as above |

Exact, not fuzzy. No results means those letters do not occur in that order —
try fewer, or use `/api/text`. `total` is how many lines matched in all, which is
often more than `limit`. Each result carries `highlight`, the words your letters
matched.

This is a lexical index: no model, no vectors, p95 about 1 ms.

---

## `GET /api/shabad` — read a whole shabad

| Parameter | |
|---|---|
| `id` | required; a `shabad_id` |
| `tr` | `en`, `pa`, `pad`, `fk` |
| `index` | which index's translator-agreement to attach |

Returns `{shabad, darpan, lines}`.

`shabad` has `writer`, `raag`, `ang_start`, `ang_end`, `line_count`,
`rahao_count`, `has_rahao`.

`lines` are in reading order, each with `gurmukhi_uni`, `translit_roman`,
`gurmukhi_ascii`, `ang`, `kind` and any `tr_*` you asked for.

**`kind` is one of `line`, `rahao`, `heading`, `invocation`.** A `heading` is the
raag-and-author line and an `invocation` is ੴ and similar. **Neither is a verse**
— never quote one as though the Guru said it.

**`rahao_stanza: true`** marks every line of the refrain's stanza. BaniDB marks
only the line carrying the `॥ ਰਹਾਉ ॥` marker, which is the stanza's *last* line,
so the flag is computed to cover the whole thing.

**The rahao is the shabad's thesis.** It states what the shabad is about and
everything else elaborates it. If you summarise a shabad, start there.

`darpan` is present when the deployment has translations: Prof. Sahib Singh's
`bhav` (the central point), his per-stanza `stanzas`, and the `topics` he filed
it under. His ਨੋਟ side notes are **not** included and are not available anywhere
— see [NOTICE.md](../NOTICE.md).

---

## `GET /api/similar/line` · `shabad` · `rahao` — neighbours

| Parameter | Default | |
|---|---|---|
| `id` | required | a `line_id` or `shabad_id` |
| `k` | 10 | 1–50 |
| `index` | the default | or `all`, fused like `/api/text` |

```
GET /api/similar/rahao?id=81&k=5
```

- **`line`** — lines that say the same thing.
- **`shabad`** — whole shabads, compared by their composed vector.
- **`rahao`** — compares *refrains*, so it finds shabads on the same **theme**
  rather than with similar wording. The best of the three for "what else teaches
  this".

These are lookups into a frozen index, not model calls: fast, exactly
reproducible, and **they work with no query model installed**, because the item
is already in the index and its vector is read rather than computed.

`{"results": [], "note": "this line has no text in this source"}` is not an
error: a heading, or a line a translation skips, has no vector in that index.
`"this shabad has no rahao line"` likewise.

---

## `GET /api/keyboard`

The Gurmukhi layout, so a client need not hardcode it: `rows` (the 35 akhar),
`nukta`, `matras`, `keymap` (physical key → letter, the AnmolLipi mapping
SikhiToTheMax users already know), and `roman` / `romanKeymap` for a reader who
knows the language but not the script.

---

## Field notes

**`line_id` is dense and stable** within a data release — it is the row order of
the corpus, and every index addresses lines by it. Across a *major* data release
it may change; `/api/health` and the data manifest both carry a version.

**`agreement`**, when present on a line, is how closely two translators agreed
about it, as a float. Below about 0.6 means "readings differ", which is
interesting to show and dishonest to hide.

**Translations never come back in bulk.** `?tr=` attaches text only to the lines
in the response. There is no endpoint that returns the translation corpus, by
design.
