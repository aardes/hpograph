# HPOGraph

A phenotype lookup tool for the Human Phenotype Ontology (HPO) that treats the
ontology as what it actually is — a directed acyclic graph, not a tree. A term
can be reached through more than one parent branch, and the graph view here
shows every path back to the root instead of hiding the others behind a single
lineage. Selecting a set of HPO terms produces a ranked list of candidate
diseases and genes using an information-content-weighted phenotype similarity
score.

Everything runs client-side: the entire dataset ships as a single SQLite file
(`data/hpo.db`) queried in the browser via [sql.js](https://github.com/sql-js/sql.js)
(SQLite compiled to WebAssembly). There is no backend, no server-side database,
and no API to pay for or keep running — the whole app is static files, which is
why it deploys for free on Cloudflare Pages / GitHub Pages.

## How it works

**Data pipeline** (`scripts/build_db.py`): parses the raw HPO/HGNC/OMIM release
files and compiles them into one compact SQLite database:

- `terms`, `edges`, `synonyms`, `alt_ids` — the HPO ontology graph (from `hp.json`)
- `disease`, `disease_hpo` — disease↔HPO annotations with frequency/onset/evidence (from `phenotype.hpoa`)
- `gene`, `gene_disease` — gene↔disease associations (from `genes_to_disease.txt`, `hgnc_complete_set.tsv`)
- a precomputed **information content (IC)** score per HPO term, based on how many
  diseases use that term or any of its descendants — rarer, more specific terms
  carry more diagnostic weight.

Raw source files are **not** committed to this repo (see `.gitignore`) — only the
compiled `data/hpo.db` ships. To rebuild it after an HPO/OMIM release update:

```bash
python3 scripts/build_db.py --raw-dir /path/to/raw_data --out data/hpo.db
```

Re-download the raw files first from:
- HPO ontology + annotations: https://hpo.jax.org/data/annotations (`hp.json`, `phenotype.hpoa`, `genes_to_disease.txt`, `genes_to_phenotype.txt`)
- HGNC: https://www.genenames.org/download/statistics-and-files/
- OMIM `mim2gene.txt`: https://omim.org/downloads

**Ranking algorithm** (`assets/js/ranking.js`): for a clinician-selected HPO term
set P and a candidate disease's annotated term set D, similarity uses Lin's
measure on the most informative common ancestor (MICA) of each term pair,
combined via a **symmetric best-match average** — the same family of method
used by phenotype-matching tools like Phenomizer/OwlSim/LIRICAL:

```
sim(a, b)      = 2 * IC(MICA(a, b)) / (IC(a) + IC(b))
bestMatch(t, S) = max( sim(t, s) * frequency_weight(s) for s in S )
score(P, D)     = average( [ average(bestMatch(p, D) for p in P),
                              average(bestMatch(d, P) for d in D) ] )
```

`frequency_weight` uses the disease-term's annotated frequency where known
(e.g. "5/8" or an HPO frequency sub-ontology term like "Occasional"), defaulting
to 0.5 when unspecified. Candidate diseases are pre-filtered to those sharing
at least one term in the selected terms' ancestor closure, which keeps scoring
fast (typically well under a second in-browser) without materially changing
the ranking, since HPO IC increases monotonically from root to leaf.

Gene scores are derived from each gene's best-supporting linked disease
(`gene_disease` table), reported alongside how many of its linked diseases
matched and their association type (Mendelian/polygenic/unknown).

This was validated against a real case during development: selecting
Arachnodactyly + Ectopia lentis + Aortic root aneurysm correctly ranks Marfan
syndrome and related fibrillinopathies at the top of both the disease and gene
lists (FBN1 first).

## Project layout

```
index.html              entry point
assets/css/style.css
assets/js/db.js          sql.js loader + query wrapper
assets/js/graph.js       Cytoscape.js DAG neighborhood view
assets/js/ranking.js     IC/Resnik-Lin similarity + BMA ranking
assets/js/app.js         UI wiring (search, selected terms, tabs)
data/hpo.db              compiled database (rebuilt via scripts/build_db.py)
scripts/build_db.py      ETL pipeline
raw_data/                (gitignored — put HPO/HGNC/OMIM source files here to rebuild)
```

## Deploying (Cloudflare Pages)

This repo is already connected: https://github.com/aardes/hpograph

Since this is a pure static site (no build step needed — `data/hpo.db` is
committed pre-built), configure the Cloudflare Pages project with:

- **Build command:** *(leave empty)*
- **Build output directory:** `/`

Every push to the connected branch redeploys automatically. If you rebuild
`data/hpo.db` locally, just commit the new file — no other steps required.

## Data licensing note

HPO ontology/annotation data is CC BY 4.0 (Human Phenotype Ontology
Consortium). OMIM-derived data (`mim2gene.txt`, and any OMIM disease
identifiers/names surfaced from `phenotype.hpoa` / `genes_to_disease.txt`) is
subject to the OMIM usage terms (https://omim.org/help/agreement) — free for
individual/academic/non-commercial use; review those terms before any
commercial deployment or bulk redistribution of OMIM-derived content.

## Known limitations / possible next steps

- Candidate filtering uses ancestor-closure overlap only; a disease whose
  closest relation to a selected term is a shared cousin term further down
  the graph (not a direct ancestor/descendant) could be missed. Rare in
  practice for clinically-specific term selections.
- No per-term severity/onset input from the clinician yet (the underlying
  `disease_hpo.onset` column is already populated and ready to use for this).
- No accounts/persistence — selected term sets live in memory for the
  session only. Could be added later via a Cloudflare Worker + D1 if needed,
  without changing the free-hosting model.
