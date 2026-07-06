# Sources verification report — 2026-07-06

Baseline integrity check covering: every upstream data source
`scripts/update_data.py` / `scripts/build_db.py` depend on, the compiled
database currently deployed, and consistency across README/NOTICE/
DEPLOYMENT.md/CITATION.cff/in-page docs. This is the first report of this
kind — see `MAINTENANCE.md` for the reusable monthly checklist this
supports. Re-run the checks below (or a Claude session) periodically and
save a new dated file alongside this one rather than editing it in place.

The structured numbers behind this report are also captured as
`docs/verification-reports/data/202607.json`, which feeds the growth
charts and comparison table on
[`docs/verification-reports/index.html`](index.html) — this prose file is
the "why", that JSON file (and the ones that follow it each month) is the
"what changed."

## 1. Source-by-source verification

| Local filename (in `raw_data/`) | Source | URL used by `update_data.py` | Required? | Reachability |
|---|---|---|---|---|
| `hp.json` | HPO ontology (obographs JSON) | `github.com/obophenotype/human-phenotype-ontology/releases/latest/download/hp.json` | Yes | See note (a) |
| `phenotype.hpoa` | HPO disease annotations | same repo, `.../releases/latest/download/phenotype.hpoa` | Yes | See note (a) |
| `genes_to_disease.txt` | HPO gene-disease associations | same repo, `.../releases/latest/download/genes_to_disease.txt` | Yes | See note (a) |
| `hgnc_complete_set.tsv` | HGNC complete gene set | `storage.googleapis.com/public-download-files/hgnc/tsv/tsv/hgnc_complete_set.txt` | Yes | **Confirmed** — fetched real TSV content directly |
| `mondo_exactmatch_omim.sssom.tsv` | Mondo→OMIM exact-match crosswalk | `raw.githubusercontent.com/monarch-initiative/mondo/master/src/ontology/mappings/mondo_exactmatch_omim.sssom.tsv` | Optional | **Confirmed** — fetched real SSSOM content directly (585 lines retrieved) |
| `mondo.sssom.tsv` | Mondo's full mapping set (Orphanet subset extracted by `build_db.py`) | `raw.githubusercontent.com/monarch-initiative/mondo/master/src/ontology/mappings/mondo.sssom.tsv` | Optional | **Confirmed reachable**, partial content fetched (real file is 12.5MB per GitHub's own file-size display; my fetch tool caps how much it can pull back into this conversation, so only the first ~78KB was inspected directly — not a concern for `update_data.py` itself, since Python's `urllib` has no such cap and downloads the whole file) |
| `Clingen-Gene-Disease-Summary*.csv` | ClinGen gene-disease validity | *(no stable URL — see note (b))* | Optional, manual-only | Not automatable |
| `Clingen-Curation-Activity-Summary*.csv` | ClinGen dosage/actionability | *(no stable URL — see note (b))* | Optional, manual-only | Not automatable |

**Note (a) — HPO GitHub release assets:** my fetch tool returned an empty
(non-error) response for all three HPO release-asset URLs, and for the
`releases/latest/download/...` alias specifically. To rule out a
problem with these particular URLs, I tested the identical pattern against
an unrelated, well-known public repo's release binary
(`github.com/jqlang/jq/releases/latest/download/jq-linux-amd64`) and got the
same empty result — indicating this is a limitation of the fetch tool with
GitHub's release-asset redirect chain in general, not evidence that HPO's
URLs are broken. I *did* independently confirm, via the GitHub release
page's asset listing (`releases/expanded_assets/v2026-06-23`), that
`hp.json` (22MB), `phenotype.hpoa` (34MB), and `genes_to_disease.txt`
(1.41MB) all currently exist as real, correctly-named assets on the latest
tagged release. The `releases/latest/download/<filename>` alias is a
standard, widely-used GitHub mechanism (not specific to this repo) that
always resolves to whatever release is currently tagged "latest," and
Python's `urllib.request` (used inside `update_data.py`) handles this kind
of redirect routinely. Net assessment: very likely to work, but not
independently byte-verified by me this round — **first live run of
`update_data.py` should be watched for `ERROR` lines on these three as a
one-time confirmation.**

**Note (b) — ClinGen:** searched multiple times (their downloads page,
their public FTP mirror at `ftp.clinicalgenome.org`, their documents page,
general web search) and could not find a stable, unauthenticated URL for
either summary CSV. `search.clinicalgenome.org/kb/downloads` is a
JavaScript-driven page that generates the export interactively with a
date-stamped filename baked in; `ftp.clinicalgenome.org` only hosts dosage
BED/TSV files (haploinsufficiency/triplosensitivity gene and region lists),
not the two gene-disease-validity/curation-activity summary reports this
project uses. These two files remain a manual download step every time —
see `MAINTENANCE.md` § 1.

## 2. Filename cross-check: `update_data.py` output → `build_db.py` input

Verified programmatically (grepped both scripts) that every file
`update_data.py` saves into `raw_dir` uses the exact filename or glob
prefix `build_db.py` looks for:

| `update_data.py` saves as | `build_db.py` expects | Match |
|---|---|---|
| `hp.json` | exact `hp.json` | Yes |
| `phenotype.hpoa` | exact `phenotype.hpoa` | Yes |
| `genes_to_disease.txt` | exact `genes_to_disease.txt` | Yes |
| `hgnc_complete_set.tsv` | prefix `hgnc_complete_set*` | Yes |
| `mondo_exactmatch_omim.sssom.tsv` | exact `mondo_exactmatch_omim.sssom.tsv` | Yes |
| `mondo.sssom.tsv` | exact `mondo.sssom.tsv` | Yes |

No renaming step is needed between the two scripts.

## 3. Compiled database vs. documentation

Read the live `meta` table out of the currently-committed `data/hpo.db.gz`
directly:

```
build_date                           = 2026-07-05
schema_version                       = 1.3
num_terms                            = 20413
num_diseases_scored                  = 12935
num_genes                            = 45003
total_genes_with_any_hpo             = 5524
num_clingen_validity_rows            = 3642
num_mondo_xref_rows                  = 19830
hpo_source                           = (placeholder — see gap below)
phenotype_annotation_source          = (placeholder — see gap below)
hgnc_source                          = (placeholder — see gap below)
clingen_validity_source              = Clingen-Gene-Disease-Summary-Report-2026-07-06.csv
clingen_dosage_actionability_source  = Clingen-Curation-Activity-Summary-Report-2026-07-06.csv
mondo_omim_xref_source               = mondo_exactmatch_omim.sssom.tsv
mondo_orpha_xref_source              = mondo.sssom.tsv
```

- `schema_version` (1.3) matches README's "Versioning / data provenance"
  section, and its full 14-key list matches the `meta` table's actual keys
  exactly — **no drift**.
- `data/hpo.db` = 47,726,592 bytes (45.5MB) / `data/hpo.db.gz` =
  12,162,040 bytes (11.6MB) — matches README's "~46MB" / "~11.6MB" and
  DEPLOYMENT.md's "11-12MB range" claims — **no drift**.
- Table row counts sanity-checked directly: `terms` 20,413, `disease`
  12,956, `gene` 45,003, `gene_disease` 15,944, `clingen_validity` 3,642,
  `clingen_dosage_actionability` 2,658, `mondo_xref` 19,830 — internally
  consistent with the `meta` counters above.
- `git status --short` was clean and the committed `data/hpo.db.gz` git
  blob size matched the working-tree file exactly — this month's push
  correctly included the database (a past session once forgot this file;
  re-checking it explicitly each time is now standard practice, see
  `MAINTENANCE.md` § 4).

**Gap found:** `hpo_source` and `hgnc_source` in the current build are
generic fallback strings ("exact release version not recorded for this
build"), not actual captured version identifiers, even though
`schema_version` is 1.3 (the fallback comment in README says this capture
started "with schema_version 1.1 rebuilds"). This means the specific
`hp.json`/HGNC source files used for *this* build didn't carry a
machine-readable version string `build_db.py` could extract (or predate the
capture logic) — functionally harmless (the app degrades gracefully and
just shows the fallback text), but worth checking after the next
`update_data.py` run: freshly-downloaded HPO release assets should have a
proper versioned `meta.version` IRI inside `hp.json`, so this placeholder
should disappear on the next rebuild. Flag it again next month if it
doesn't.

## 4. Cross-document consistency

Checked `NOTICE`, `DEPLOYMENT.md`, `CITATION.cff`, `README.md`, and the
in-page "About HPOGraph" FAQ (`index.html`) against each other and against
the actual code/data:

- `NOTICE`'s third-party data section accurately lists all six sources
  actually compiled in (HPO, OMIM, Orphanet, HGNC, ClinGen, Mondo) with
  correct license characterizations — no drift.
- `CITATION.cff`'s `date-released` (2026-07-06) matches today.
- README's three Statistics-tab mentions, the Selected-tab section order,
  and the in-page FAQ's new "What's on the Statistics tab?" entry all
  correctly reference the current tab layout (checked after this session's
  Statistics-tab consolidation and Selected-tab reorder).
- `scripts/smoke_check.py` now also compiles `scripts/update_data.py` in
  its Python-syntax check, and README's Testing section mentions this.

## 5. Live deployment check

Fetched `https://hpograph.amin-davani.workers.dev/` twice: once plain, once
with a cache-busting query string (`?cachebust=...`). **The plain fetch
returned a stale, pre-push copy of the page** (tab bar showed only
Diseases/Genes, no ClinGen/Suggest/Statistics tabs, no new FAQ entries);
**the cache-busted fetch showed the fully up-to-date page**, including the
Statistics tab, all three charts' labels, ClinGen/Suggest tabs, and every
FAQ entry added this session. This confirms the deploy itself succeeded —
it was purely an edge-cache timing artifact on the very first request after
a push. Documented as a permanent note in `DEPLOYMENT.md` ("Edge caching
after a push") and as a checklist step in `MAINTENANCE.md` § 5, so a future
"my changes aren't showing up" moment isn't mistaken for a failed deploy.

## Summary: what's solid vs. what to watch

**Solid, independently confirmed this round:** HGNC and Mondo download
URLs (real content fetched), filename compatibility between
`update_data.py` and `build_db.py`, database/README numeric consistency,
NOTICE/CITATION accuracy, live deployment correctness (after accounting for
edge-cache timing).

**Watch next time:**
1. First real run of `update_data.py` — confirm the three HPO
   `releases/latest/download/...` URLs actually succeed (I could reason
   about them but not byte-verify them from this environment).
2. Whether `hpo_source` / `hgnc_source` populate a real version string once
   built from freshly-downloaded files (currently placeholders).
3. ClinGen's two CSVs still require a manual download every month — no
   change expected here, just a recurring reminder.
