# Licensing

**Read this before you redistribute the data or deploy this commercially.**

There are two different things in play, under two different licences.

| | Licence |
|---|---|
| The **code** in this repository | MIT — see `LICENSE` |
| The **data packs** `npm run fetch-data` downloads | **not MIT** — see below |

An MIT badge on this repository covers the software. It does not, and cannot,
relicense the scripture database, the translations, the vector indexes or the
models. Those come from other people, under other terms.

---

## The data

**BaniDB** (Khalis Foundation) is the source of the Gurmukhi text, the verse and
shabad structure, the English translations and the Punjabi teekas. It is
licensed **NPOSL-3.0 — the Non-Profit Open Software License**. That is not a
permissive licence: it permits non-profit use. If your use is commercial, this
licence does not cover you.

Every vector index is derived from that text, so the same terms reach the
indexes. The `pa-ssa` index in particular records `"enriched": "arth"` in its
manifest: its vectors are built with Sahib Singh's teeka as an ingredient, even
though the text it indexes is the Gurmukhi.

**Translations and teekas**, with their translators named as the API names them:

| id | |
|---|---|
| `bdb` | BaniDB's corrected edition of Sant Singh Khalsa's English |
| `ms` | Manmohan Singh, English |
| `pa-ss` | Prof. Sahib Singh, *Guru Granth Darpan* |
| `pa-ss-pad` | Prof. Sahib Singh, pad-arth |
| `pa-ms` | Manmohan Singh, Punjabi |
| `pa-fk` | Faridkot Teeka |

The underlying source documents are **Dr Kulbir Thind's** corrected editions,
and the English traces to **Sant Singh Khalsa, MD**. Their notice requires
**written approval from both for commercial use or for internet projects**.

**Models.** `BAAI/bge-small-en-v1.5` and `intfloat/multilingual-e5-small` are
MIT; the ONNX exports are by Xenova. The Gurbani fine-tune and the
vocabulary-trimmed variant shipped here are derived from the latter and carry
the same MIT terms.

**Mahan Kosh** — Bhai Kahn Singh Nabha, *Gur Shabad Ratnakar Mahan Kosh* (1930),
digitised by redroyals/mahan-kosh-multilingual under **CC BY 4.0**. It was used
at build time only. **Nothing from it is in any data pack**; the attribution is
given because it is owed, not because it ships.

---

## The writings

The `writings-*` packs are prose *about* Gurbani -- essays, commentaries and
biographies -- searchable by meaning through `/api/writings/search`, which
returns whole passages, a bounded number per query. They are off by default;
nothing here is fetched unless asked for.

| pack | author | works | note |
|---|---|---:|---|
| `writings-writings` | Bau Ji | 39 | mostly translated from Punjabi; five essays are his own English |
| `writings-akj` | Bhai Sahib Bhai Randhir Singh Ji (one book by Subedar Dharam Singh Sujjon) | 5 | translations |
| `writings-puran` | Prof. Puran Singh | 6 | his own English |
| `writings-virsingh` | Bhai Vir Singh | 6 | translations; two OCR-damaged books held back |
| `writings-raghbir` | Bhai Raghbir Singh | 1 | translation |
| `writings-bariaran` | Sant Kartar Singh Ji Bariaranwale (the life, compiled by Bhai Joginder Singh Chopra and Bibi Gurbaksh Kaur; the discourses, his own) | 2 | translation |
| `writings-rama` | Bhai Rama Singh Ji | 1 | translation |

These are published on the project owner's statement (16 September 2026) that
the writings are offered as a service to readers and that no licensing issue
applies to their publication here. Each passage carries its author's name and
its book and page, and `original` says whether the words are the author's own
English or a translator's. The permission paragraph below applies to these packs
exactly as it does to the scripture data: it was obtained for *this*
publication and is not a licence you inherit. A rights holder who wants a work
withdrawn should open an issue on this repository; the pack will be rebuilt
without it.

---

## Permission does not transfer

Permission for *this* publication was obtained by the project's owner. **It is
not a licence you inherit.** If you intend to redistribute the data packs, mirror
them, or run a commercial deployment on top of them, you need your own written
permission from the rights holders above. Downloading the packs for your own
non-profit use is what the terms above contemplate; republishing them is a
separate act.

`scripts/fetch-data.mjs` writes `LICENSE-DATA.txt` alongside the files it
downloads, so these terms stay with the bytes even when the directory is copied
to a server.

---

## Two rules that are not licensing, but matter as much

These are correctness rules carried over from the project this was extracted
from. If you build a client on this API, carry them through.

**Machine-translated text is never presented as a human translation.** The
`translators` table marks machine text with `machine = 1`. In particular the
Darpan's machine English (`en-ss-mt`, `en-ss-pad-mt`) exists to drive the English
meaning indexes — it is good enough to retrieve with, and not good enough to put
in front of a reader as Sahib Singh's words. The API does not offer it as a
translation view, and neither should you.

**Sahib Singh's ਨੋਟ side notes never leave the server.** They are frequently
about a scholarly controversy unrelated to the shabad in front of the reader.
They are not in `translations.sqlite`, not in any data pack, and not reachable
through any endpoint.

And the general form of both: the Gurmukhi is scripture and is reproduced
exactly; a translation is a named person's reading of it; a summary is neither.
Keeping those three apart is the whole point of labelling them.
