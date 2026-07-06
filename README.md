# HPOGraph

A browser-based tool for exploring the Human Phenotype Ontology (HPO) as what
it actually is — a directed acyclic graph, not a tree — and for turning a
clinician-selected set of phenotypes into a ranked list of candidate diseases
and genes for differential-diagnosis and gene-prioritization support.

**Live demo:** https://hpograph.amin-davani.workers.dev
**Repository:** https://github.com/aardes/hpograph

## Clinical Disclaimer

HPOGraph is a research, education, and phenotype-exploration tool. **It is
not a standalone diagnostic tool.** Its disease/gene ranking is a
decision-support aid, not a diagnosis — any output requires independent
review and interpretation by a qualified clinical or genetics professional
before it informs a real care decision. No clinical validation study has
been performed on this tool; do not present its rankings as validated
diagnostic accuracy.

## Contents

- [Clinical Disclaimer](#clinical-disclaimer)
- [Why a graph, not a tree](#why-a-graph-not-a-tree)
- [Running it locally](#running-it-locally)
- [Rebuilding the database](#rebuilding-the-database)
- [How search and the graph view work](#how-search-and-the-graph-view-work)
- [How disease/gene ranking works](#how-diseasegene-ranking-works)
- [Standalone term informativeness score](#standalone-term-informativeness-score)
- [Phenotype-set relationships (the distance calculator)](#phenotype-set-relationships-the-distance-calculator)
- [Suggested phenotype terms](#suggested-phenotype-terms)
- [ClinGen integration](#clingen-integration)
- [Sharing and exporting a phenotype set](#sharing-and-exporting-a-phenotype-set)
- [Project layout](#project-layout)
- [Running with Docker](#running-with-docker)
- [Versioning / data provenance](#versioning--data-provenance)
- [Data verification history](#data-verification-history)
- [Testing / smoke checks](#testing--smoke-checks)
- [Data Sources and Third-Party Terms](#data-sources-and-third-party-terms)
- [Citation](#citation)
- [Known limitations](#known-limitations--possible-next-steps)
- [License and Usage](#license-and-usage)

## Architecture, in one paragraph

Everything runs client-side: the entire dataset ships as a single SQLite file
(`data/hpo.db`, ~46MB uncompressed) queried in the browser via
[sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly).
There is no backend, no server-side database, and no API to pay for or keep
running — the whole app is static files (HTML/CSS/JS + one data file), which
is why it deploys for free on Cloudflare Workers' static-assets hosting (or
GitHub Pages, or any static host) with zero ongoing cost.

The file actually committed to the repo and served to the browser is
`data/hpo.db.gz` (~11.6MB) — Cloudflare's static asset hosting (and most
static hosts) reject individual deployed files over 25 MiB, and the raw
sqlite file is ~46MB. The
browser fetches the gzipped file and decompresses it itself with the native
`DecompressionStream` API before handing the bytes to sql.js (see
`assets/js/db.js`) — no extra JS library, no server-side gzip negotiation.

## Why a graph, not a tree

Every existing HPO browser (including HPO's own official site) renders the
ontology as a tree: pick one parent, draw a branch, repeat. That's a
simplification that actively hides information. HPO is a **DAG** — a term can
be reached through more than one parent branch. For example, "Abnormality of
the hand" is reachable both via *limb → upper limb → hand* and via
*skeletal system → limb bone → ...* — two genuinely different ways of
categorizing the same finding. A tree view arbitrarily picks one path and
throws the other away.

For a clinician trying to choose the single best-fitting HPO term for a
finding, seeing only one branch can be actively misleading — it looks like
there's one "correct" place in the hierarchy when there are several
legitimate ones, each potentially useful for different downstream reasoning
(e.g. gene panels organized by skeletal vs. limb-development pathways).
The graph view here (`assets/js/graph.js`, Cytoscape.js + dagre layout) always
shows the **full ancestor closure** of the focused term — every path back to
the root — plus its direct children, so the multi-parent structure is visible
rather than hidden.

This same "it's a graph, not a tree" fact is also *why* the ranking algorithm
below uses graph-based semantic similarity (shared ancestors) rather than
simple keyword or exact-match logic — two phenotypes can be clinically related
through a shared ancestor even if their names share no words at all.

## Running it locally

This is a static site with one requirement: it must be served over `http://`,
not opened directly as a `file://` URL — browsers block `fetch()` of local
files under `file://`, so `data/hpo.db.gz` would fail to load with the double-click-the-file
approach.

From the repo root, any of these work:

```bash
# Python (built into macOS/Linux)
python3 -m http.server 8000
# then open http://localhost:8000

# Node, if you have it
npx serve .

# VS Code
# right-click index.html in the file explorer -> "Open with Live Server"
```

No build step, no `npm install`, no dependencies to install — `index.html`
pulls sql.js, Cytoscape.js, the dagre layout extension, jsPDF, and Chart.js
from a CDN at load time, and everything else is plain JS files in
`assets/js/`.

## Rebuilding the database

`data/hpo.db` / `data/hpo.db.gz` are a compiled snapshot. They are **not**
regenerated automatically by Cloudflare — you rebuild them locally and
commit the new `.gz` file whenever you want to pick up a newer HPO/OMIM/HGNC/
Mondo release. HPO, HGNC, and Mondo each cut new releases roughly once a
month, so as a maintenance cadence this project aims to refresh all source
data about **once a month** — there's no automation that does this on a
schedule (Cloudflare only serves whatever `data/hpo.db.gz` is currently
committed), so it's a manual "run the update script, review, push" step.
See [`MAINTENANCE.md`](MAINTENANCE.md) for the full step-by-step checklist
(download, sanity-check, doc cross-check, commit, verify live) to run each
time; [`docs/verification-reports/`](docs/verification-reports/) holds
dated snapshots from full verification passes.

### Option A: automated (`scripts/update_data.py`)

```bash
python3 scripts/update_data.py
```

This downloads fresh copies of every source file the build needs straight
into `raw_data/` (HPO's ontology/annotations/gene-disease files from its
GitHub releases, HGNC's complete gene set, and Mondo's OMIM/Orphanet
exact-match crosswalk files from its GitHub mappings directory — all from
stable URLs that always resolve to the current release, no version-tag
bookkeeping needed) and then runs `build_db.py` for you. Useful flags:

- `--raw-dir DIR` / `--out PATH` — same meaning as `build_db.py`'s flags,
  default to `raw_data` / `data/hpo.db`.
- `--skip-download` — reuse whatever is already sitting in `raw_data/`
  instead of re-downloading (handy if you only need to add the ClinGen
  files below and re-run the build).

The two ClinGen summary CSVs are **not** downloaded automatically — see the
note under Option B for why — so if you want fresh ClinGen data, download
those two files manually into `raw_data/` (once) and the script will pick
them up on the next run.

### Option B: manual

1. Download fresh source files into a local `raw_data/` folder (this folder is
   gitignored — it's only a rebuild input, never committed):
   - HPO ontology + annotations: https://github.com/obophenotype/human-phenotype-ontology/releases/latest
     — need `hp.json`, `phenotype.hpoa`, `genes_to_disease.txt`
   - HGNC gene metadata: https://www.genenames.org/download/statistics-and-files/
     — need `hgnc_complete_set_*.tsv`
   - **Optional:** ClinGen gene-disease validity and dosage/actionability
     summary reports from https://search.clinicalgenome.org/kb/downloads
     (`Clingen-Gene-Disease-Summary*.csv`, `Clingen-Curation-Activity-Summary*.csv`)
     — if these files are absent, the build simply skips the two ClinGen
     tables and the app degrades gracefully (no ClinGen tab/badges shown).
     ClinGen generates these as a dated, click-to-export file rather than
     publishing them at a fixed URL, which is why `update_data.py` can't
     fetch them for you.
   - **Optional:** Mondo's exact-match crosswalk files, from
     https://github.com/monarch-initiative/mondo/tree/master/src/ontology/mappings
     (`mondo_exactmatch_omim.sssom.tsv` and the full `mondo.sssom.tsv`, which
     the build filters down to its Orphanet subset) — used to attach ClinGen
     data to a specific candidate disease (see
     [ClinGen integration](#clingen-integration)); if absent, the build skips
     `mondo_xref` and ClinGen falls back to gene-level matching only.
2. Run the build script:
   ```bash
   python3 scripts/build_db.py --raw-dir raw_data --out data/hpo.db
   ```
   This is a plain Python 3 script with no third-party dependencies (only
   `sqlite3`, `json`, `csv`, `math` from the standard library) — takes under
   a minute. It writes `data/hpo.db` and then automatically also writes the
   gzip-compressed `data/hpo.db.gz` that actually gets deployed.

### After either option

Commit `data/hpo.db.gz` (the plain `data/hpo.db` is gitignored — it's
~46MB, over Cloudflare's 25 MiB per-file limit, so it must never be
committed). Push, and Cloudflare redeploys the new data automatically.

The script parses the raw files and compiles them into one compact SQLite
database:

- `terms`, `edges`, `synonyms`, `alt_ids` — the HPO ontology graph (from `hp.json`)
- `disease`, `disease_hpo` — disease↔HPO annotations with frequency/onset/evidence (from `phenotype.hpoa`)
- `gene`, `gene_disease` — gene↔disease associations (from `genes_to_disease.txt`, `hgnc_complete_set.tsv`)
- `clingen_validity`, `clingen_dosage_actionability` — optional ClinGen curations
  (see [ClinGen integration](#clingen-integration)); absent entirely if the
  source CSVs weren't in `raw_data/` at build time
- `mondo_xref` — optional Mondo-to-OMIM/Orphanet exact-match crosswalk (see
  [ClinGen integration](#clingen-integration)), used to attach ClinGen data to
  a specific candidate disease rather than only to a gene; absent entirely if
  the source SSSOM files weren't in `raw_data/` at build time
- two per-term information-content style scores (see below): `gene_ic` (powers
  the disease/gene ranking) and `direct_final_score` / `spec_rank` (a standalone
  informativeness leaderboard shown in the UI).

## How search and the graph view work

Typing in the search box (`assets/js/app.js`) matches against both a term's
own name and its synonyms (`terms.name_lc` / `synonyms.synonym_lc`, both
precomputed lowercase columns with an index), ranked so a match in the term's
own name always outranks a synonym-only match, then alphabetically by name.

Selecting a result calls `HPOGraph.render()` (`assets/js/graph.js`), which:

1. Walks **upward** from the focused term, following every `is_a` edge to
   every parent, repeated until the root — this is the full ancestor closure,
   not just one path, so convergent branches are visible as the graph
   literally merging back together.
2. Adds the focused term's **direct children** (one level down only, to keep
   the view readable — click a child to make it the new focus and reveal
   its own children).
3. Lays it out top-to-bottom with dagre (root at top, focused term
   highlighted in dark, ancestors in teal, children as outlined circles), and
   clamps the zoom to a readable range so high fan-out terms (dozens of
   children) don't shrink labels into illegibility.

Double-clicking any node (or the "+ Add to selected" button) adds that term
to the phenotype set on the right, which drives the ranking below.

## How disease/gene ranking works

For a clinician-selected HPO term set **P** and a candidate disease's
annotated term set **D**, similarity uses Lin's measure on the **most
informative common ancestor (MICA)** of each term pair, combined via a
**symmetric best-match average (BMA)** — the same family of method used by
phenotype-matching tools like Phenomizer, OwlSim, and LIRICAL:

```
sim(a, b)       = 2 * IC(MICA(a, b)) / (IC(a) + IC(b))
bestMatch(t, S) = max( sim(t, s) * frequency_weight(s) for s in S )
score(P, D)     = average( [ average(bestMatch(p, D) for p in P),
                              average(bestMatch(d, P) for d in P) ] )
```

In plain language: for every phenotype you selected, find the single most
similar phenotype annotated to the candidate disease (and vice versa, for
symmetry), then average those best-match scores. Two terms are "similar" if
they share a specific (rather than generic) common ancestor — e.g.
"Arachnodactyly" and "Long fingers" are similar because they share a fairly
specific ancestor, whereas "Arachnodactyly" and "Seizure" only share the
almost-meaningless root "Phenotypic abnormality", so they score near zero.

The `IC` (information content) used here is `gene_ic`: a term's gene set is
the union of genes linked to any disease annotated with that term **or any of
its descendants** (propagated up the DAG), so IC stays monotonically
non-decreasing from root to leaf — necessary for the MICA shortcut (max IC
among common ancestors = the deepest shared ancestor) to behave sensibly for
ancestor/internal ontology terms, most of which are rarely annotated to a
disease directly.

`frequency_weight` uses the disease-term's annotated frequency where known
(e.g. "5/8" or an HPO frequency sub-ontology term like "Occasional"),
defaulting to 0.5 when unspecified.

**Candidate pre-filtering.** Scoring every disease in the database for every
query would be needlessly slow, so `Ranking.candidateDiseases()`
(`assets/js/ranking.js`) first narrows the field to diseases annotated with
a selected term, one of its **ancestors**, or one of its **descendants**.
Ancestors catch diseases annotated more generically than what you picked;
descendants catch diseases annotated more specifically (e.g. selecting the
broad term "Abnormality of the hand" now also surfaces a disease annotated
only with a narrower descendant like a specific finger deformity, which an
ancestor-only filter would have missed entirely). Descendant expansion is
capped at 500 descendants per term — a handful of very generic, high-level
terms have thousands of descendants, and expanding those would balloon the
candidate pool toward "score everything" for little benefit, since such
broad terms are rarely what a clinician actually selects as a specific
finding; for those, only the ancestor-based candidates are used. This
pre-filter only affects which diseases get scored, never the score formula
itself — semantic similarity above always compares via ancestors/MICA only.

Gene scores are derived from each gene's best-supporting linked disease
(`gene_disease` table); the UI lets you expand a gene row to see *every*
linked disease that matched (not just the best one) and its association type
(Mendelian/polygenic/unknown — "unknown" reflects how the source database,
usually Orphanet, classified it, not scoring uncertainty). The Diseases tab
splits results into separate OMIM / Orphanet sub-tabs since the two
databases curate disease definitions differently and aren't always
apples-to-apples comparable.

This was validated against a real case during development: selecting
Arachnodactyly + Ectopia lentis + Aortic root aneurysm correctly ranks Marfan
syndrome and related fibrillinopathies at the top of both the disease and gene
lists (FBN1 first).

The **Statistics tab** shows a **score drop-off chart** for the top 15
diseases and top 15 genes -- a quick visual read on whether the ranking has a
clear leader or a cluster of near-ties, which is harder to judge from a
percentage list alone.

## Standalone term informativeness score

Separate from the ranking above, every HPO term also carries a standalone
"how informative is this *exact* term on its own" score, shown in the graph
focus bar as e.g. "informativeness rank #10,032 of 20,413". This is computed
from each term's **direct** annotations only (no ontology propagation):

```
IC                   = -log10(genes_with_this_term / total_genes_with_any_hpo)
normalized_IC        = IC / max_IC
gene_specificity     = 1 - log10(genes_with_this_term) / log10(total_genes_with_any_hpo)
gene_disease_support = gene_disease_pairs_with_this_term / max_pairs_across_all_terms
frequency_support    = average annotated frequency/evidence weight (phenotype.hpoa)

final_score = 0.40*normalized_IC + 0.30*gene_specificity
            + 0.20*gene_disease_support + 0.10*frequency_support
```

Ranked by `final_score` DESC, then disease count DESC, then gene count ASC,
then HPO ID ASC. Terms with zero direct gene annotations score 0 on the IC/
specificity components rather than being smoothed to look artificially
specific (e.g. the ontology root scores near the very bottom, correctly,
since it's never used as a direct annotation).

This intentionally does **not** feed the disease/gene ranking above — most
internal ontology nodes are rarely annotated directly and would all collapse
toward a score of 0 if used for graph similarity, which is precisely why the
ranking engine instead uses the *propagated* `gene_ic` described above. The
two scores answer different questions: "how specific is this exact term"
(this one) vs. "how similar are these two terms, accounting for shared
ancestry" (the ranking engine's `gene_ic`).

## Phenotype-set relationships (the distance calculator)

Selecting **two or more** terms reveals a "Phenotype set relationships" panel
under the Selected tab, with two pieces:

**1. Organ systems spanned.** Every term's ancestor closure is checked against
the 23 top-level categories directly under "Phenotypic abnormality" (e.g.
"Abnormality of the nervous system", "Abnormality of the eye"). The panel
lists how many distinct systems your selection touches. This matters
clinically: a phenotype set that spans many organ systems is itself a signal
worth noticing — it points toward a syndromic, multi-system condition rather
than an isolated finding, independent of what the diseases/genes ranking
says.

**2. Pairwise distance.** For every pair of selected terms, the same Lin
similarity used in disease ranking is computed *between the two phenotypes
directly* (not against a disease):

```
similarity(a, b) = 2 * IC(MICA(a, b)) / (IC(a) + IC(b))
distance(a, b)    = 1 - similarity(a, b)
```

along with which term is their most informative common ancestor (MICA) — the
"why" behind the number. A distance near 0 means the two terms are
essentially the same finding described two ways, or one is a more specific
version of the other. A distance near 1 means their only common ground is a
very generic ancestor (often just "Phenotypic abnormality" itself) — i.e.
they're phenotypically unrelated on their own, and any connection between
them would have to come from a specific disease/gene that happens to cause
both, not from ontological closeness.

Worked example from development testing: Arachnodactyly + Ectopia lentis +
Aortic root aneurysm + Seizure — four findings from four different organ
systems — showed pairwise distances all above 0.97 (their only shared
ancestor is the ontology root), correctly reflecting that these are
phenotypically unrelated findings whose only connection would have to come
from a specific multi-system disease, not from being "close" in the ontology.

A horizontal bar chart on the **Statistics tab** visualizes the organ-system
counts directly, as a companion to the "N organ systems spanned" text.

## Suggested phenotype terms

The **Suggest** tab (`Ranking.suggestTerms()` in `assets/js/ranking.js`)
proposes additional HPO terms you haven't selected yet, based purely on the
phenotype overlap of your current top candidate diseases — never on
gene/variant databases, and nothing leaves the browser. For each unselected
term appearing across the top 15 candidate diseases (by weighted score),
it computes a coverage fraction `p(t)` = the fraction of that weighted
candidate pool annotated with the term, then offers two ranked lists:

- **"Common to leaders"** (reinforcing) — terms with high `p(t)`, i.e. shared
  by almost all of your leading candidates. Useful for confirming a working
  hypothesis: if the patient also has this finding, it strengthens the whole
  leading group at once.
- **"Narrow it down"** (discriminative) — terms scored by
  `4 * p(t) * (1 - p(t)) * IC(t)`, which peaks when a term is present in
  roughly half the leading candidates (i.e. it would split the field) and is
  weighted by the term's own specificity so generic terms don't dominate.
  Useful for actively differentiating between your top candidates.

Terms seen in only one candidate disease are excluded (`SUGGEST_MIN_DISEASE_COUNT
= 2`) to avoid single-disease noise, and each list is capped at 8 results.
Each suggested term has a one-click "+ Add" action that adds it to your
selection and re-ranks immediately. As with everything else in the app, these
are suggestions to consider, not findings to accept uncritically — always
confirm against the patient/record before adding a term you didn't directly
observe.

If ClinGen data is present in the compiled database (see next section), the
15-disease pool used for suggestions is chosen using a small ClinGen-informed
adjustment on top of the raw phenotype-similarity score — described below.
This adjustment is confined to the Suggest tab's internal candidate pool; it
never changes the Diseases/Genes tab rankings themselves.

## ClinGen integration

[ClinGen](https://clinicalgenome.org) (Clinical Genome Resource) publishes
expert-panel-curated **gene-disease validity classifications**
(Definitive/Strong/Moderate/Limited/Disputed/Refuted/No Known Disease
Relationship) plus gene **dosage sensitivity** (haploinsufficiency/
triplosensitivity) and **clinical actionability** assessments. HPOGraph
compiles this into two additional tables, `clingen_validity` and
`clingen_dosage_actionability`, when the corresponding ClinGen CSV exports
are present at build time (`scripts/build_db.py`) — the app degrades
gracefully with these tables simply absent if you rebuild without them.

**Disease-level matching via Mondo's exact-match crosswalk.** ClinGen keys
its curations by Mondo Disease Ontology ID, which has no *built-in* mapping
to the OMIM/Orphanet IDs HPOGraph's `disease` table uses. Mondo itself
publishes official exact-match crosswalks to both
(`mondo_exactmatch_omim.sssom.tsv`, plus the Orphanet subset of the full
`mondo.sssom.tsv` mapping set), which `scripts/build_db.py` compiles into a
`mondo_xref` table. This resolves **99.5% of OMIM diseases and 99.7% of
Orphanet diseases** in the compiled database to an exact Mondo ID, which in
turn lets **82.6% of ClinGen's distinct Mondo IDs** be attached to one
specific candidate disease directly — not just to a gene in general. Where
no exact Mondo match exists for a disease (or ClinGen has no entry under
that Mondo ID), HPOGraph falls back to a gene-level signal: the best
classification among any gene linked to that disease. This fallback is
less precise, since one gene is often linked to several diseases with
different classifications, but it's still informative and better than
nothing.

**Where it shows up:**

- A ClinGen classification badge on candidate **disease** rows (Diseases
  tab) when Mondo's crosswalk resolves that exact disease to a curated
  Mondo ID — this is evidence for *this* disease specifically.
- A compact classification badge (e.g. "ClinGen: Definitive") next to any
  gene in the Genes tab that has a ClinGen record overall, color-coded by
  classification strength — this one is gene-level (see fallback above),
  since a gene row isn't tied to one disease.
- A dedicated **ClinGen** tab listing every currently-ranked candidate gene
  that has a ClinGen curation, with an expandable detail view showing every
  curation on file for that gene (not just the best one), plus any dosage
  sensitivity/actionability information and a link to the source ClinGen
  report.
- A modest, bounded re-weighting of the internal candidate pool used by the
  Suggest tab (see above): candidate diseases get an adjustment factor of
  `0.85 + 0.3 * clinGenWeight` (so at most a ±15% nudge) based on the
  disease-specific ClinGen classification when available (gene-level
  fallback otherwise), before the top-15 pool for term suggestion is
  chosen. This never touches the Diseases/Genes tab scores.

Only a subset of genes are ClinGen-curated (roughly 3,000 of the ~45,000
HGNC-named genes at any given ClinGen release), so the absence of a badge or
ClinGen-tab entry for a gene is not itself negative evidence — it usually
just means that gene hasn't been through ClinGen's curation process yet.

The **Statistics tab** also shows a bar chart of how many current candidate
genes fall into each classification tier, ordered strongest to weakest
evidence (not alphabetically) — a quick read on how well-validated the
current candidate pool is overall.

## Sharing and exporting a phenotype set

A selected phenotype set can be shared or saved outside the app in a few
ways (`assets/js/app.js`):

- **Shareable URL.** The page URL's `?terms=` query parameter is kept in
  sync with your selection, e.g.
  `https://hpograph.amin-davani.workers.dev/?terms=HP:0001166,HP:0001083,HP:0002616`.
  Opening a link like this preselects those terms on load (invalid/unknown
  IDs are silently skipped) and re-runs ranking automatically. A "Copy link"
  action copies the current URL to the clipboard.
- **Export as JSON.** The selected-terms panel can export a single JSON file
  containing the selected terms, the full current disease/gene ranking (ID,
  name, source, score, matched-term/association details), each disease/gene's
  ClinGen context where available (`clinGen: { classification, matchType,
  ... }` -- `matchType` is `"disease"` for a direct Mondo-crosswalk match or
  `"gene"` for the gene-level fallback, see
  [ClinGen integration](#clingen-integration)), and the current Suggest-tab
  results (`suggestedTerms.reinforcing` / `.discriminative`) -- a complete,
  self-describing snapshot of everything visible on screen, for
  record-keeping or feeding into another tool.
- **PDF report.** A one-page PDF summarizing the selection, phenotype-set
  relationships, and top candidate diseases/genes, each annotated with its
  ClinGen classification where available (see the "PDF report" button in the
  Selected tab).

None of this involves a server: the shareable URL only encodes HPO IDs (no
patient data), and JSON/PDF export happens entirely in the browser.

## Project layout

```
index.html              entry point (also carries the on-page documentation section)
assets/css/style.css
assets/js/db.js          sql.js loader + query wrapper
assets/js/graph.js       Cytoscape.js DAG neighborhood view
assets/js/ranking.js     IC/Resnik-Lin similarity + BMA ranking, explainability, relatedness,
                         phenotype suggestion, ClinGen/Mondo lookups
assets/js/app.js         UI wiring (search, selected terms, tabs, ranking display, export/share)
data/hpo.db.gz           compiled, gzip-compressed database (committed; rebuilt via scripts/build_db.py)
data/hpo.db              uncompressed build artifact (gitignored, ~46MB, never committed)
scripts/build_db.py      ETL pipeline
scripts/update_data.py   downloads fresh HPO/HGNC/Mondo source files and runs build_db.py
                         (see Rebuilding the database above)
scripts/smoke_check.py   basic syntax/file/schema sanity checks (see Testing below)
raw_data/                (gitignored — put HPO/HGNC/OMIM source files here to rebuild;
                         optionally also ClinGen CSVs and Mondo SSSOM crosswalk files)
wrangler.jsonc           Cloudflare Workers static-assets deployment config
.assetsignore            files excluded from the deployed static-asset bundle
Dockerfile               builds a self-contained nginx image serving the same static site
docker/nginx.conf        server config (gzip disabled -- see Running with Docker above)
.dockerignore            keeps raw_data/, data/hpo.db, .git out of the Docker build context
LICENSE, NOTICE          usage terms (research/non-commercial + third-party data terms)
CITATION.cff             citation metadata
DEPLOYMENT.md            Cloudflare Workers + Docker Hub deployment notes/troubleshooting
docs/verification-reports/  monthly data-verification snapshots + growth-history page
```

## Running with Docker

Prefer to run HPOGraph locally instead of (or alongside) the hosted copy?
It's the same static site, served by a plain `nginx:alpine` container — no
different from opening it with `python3 -m http.server`, just packaged.

**Option 1 — pull the prebuilt image (no build needed):**

```bash
docker run --rm -p 8080:80 aardeshi/hpograph:latest
```

Then open http://localhost:8080. See
[hub.docker.com/r/aardeshi/hpograph](https://hub.docker.com/r/aardeshi/hpograph)
for available tags.

**Option 2 — build it yourself from this repo:**

```bash
docker build -t hpograph .
docker run --rm -p 8080:80 hpograph
```

Both give you the exact same app and database that's deployed at
https://hpograph.amin-davani.workers.dev — running entirely on your own
machine, still with nothing leaving your browser. The image is defined by
`Dockerfile` + `docker/nginx.conf` at the repo root; nginx's own gzip
module is deliberately disabled there (see the comment in
`docker/nginx.conf`), since the app fetches and decompresses
`data/hpo.db.gz` itself client-side (`assets/js/db.js`) and a
server-applied `Content-Encoding: gzip` on top of that would make the
browser auto-decompress it before the app's own decompression step runs,
breaking the load.

There's no build step and no image versioning tied to app releases yet —
rebuild/re-pull to pick up a newer `data/hpo.db.gz` the same way you'd
redeploy to Cloudflare (see [Rebuilding the database](#rebuilding-the-database)).

## Versioning / data provenance

The compiled database carries its own build metadata in a `meta` table
(key/value), queried by the app and shown in the footer / About section:

- `build_date` — when `scripts/build_db.py` was run
- `schema_version` — bumped when the `meta` table's keys or any table's
  columns change in a way the frontend should detect (currently `1.3`)
- `hpo_source` — the HPO release identifier from `hp.json`'s own `meta.version`
  field (a versioned IRI), when the source file provides one
- `phenotype_annotation_source` — the release date from `phenotype.hpoa`'s
  own header comment, when present
- `hgnc_source` — the HGNC source filename (these typically embed a release
  date, e.g. `hgnc_complete_set_2026-06-01.tsv`)
- `num_terms`, `num_diseases_scored`, `num_genes`, `total_genes_with_any_hpo`
  — corpus size at build time
- `clingen_validity_source`, `clingen_dosage_actionability_source`,
  `num_clingen_validity_rows` — which ClinGen export files were used (or
  `"not included in this build"` if absent) and how many validity rows were
  loaded
- `mondo_omim_xref_source`, `mondo_orpha_xref_source`, `num_mondo_xref_rows`
  — which Mondo SSSOM crosswalk files were used (or `"not included in this
  build"` if absent) and the total number of disease-to-Mondo mappings
  loaded (see [ClinGen integration](#clingen-integration))

Older databases built before `schema_version` existed won't have these keys;
the app treats every `meta` lookup as optional and falls back to "not
recorded for this build" rather than failing, so a missing key never breaks
the UI.

## Data verification history

The **"Data verification report"** link in the app header opens
[`docs/verification-reports/index.html`](docs/verification-reports/index.html),
a standalone page tracking the same numbers above over time: HPO term/
disease/gene counts, database size, ClinGen/Mondo coverage, and source
reachability, one snapshot per month. It renders growth charts and a
last-5-months comparison table from small JSON files —
`docs/verification-reports/data/<YYYYMM>.json` (e.g. `202607.json`),
indexed by `docs/verification-reports/data/manifest.json` — rather than
scraping the database itself, so the page stays lightweight and works
identically locally or deployed. Each JSON snapshot has an accompanying
prose write-up under `docs/verification-reports/<date>-sources-verification.md`
with the full reasoning behind that month's findings. See `MAINTENANCE.md`
for how to add a new monthly snapshot.

## Testing / smoke checks

`scripts/smoke_check.py` runs basic sanity checks with no dependencies
beyond the Python 3 standard library and Node.js (for JS syntax checking):

```bash
python3 scripts/smoke_check.py
```

It checks that: every JS file under `assets/js/` parses (`node --check`),
`scripts/build_db.py` and `scripts/update_data.py` compile (`python3 -m
py_compile`), the required files
(`index.html`, `data/hpo.db.gz`, the four `assets/js/*.js` files) exist, and
the database has the expected tables (`terms`, `edges`, `disease`,
`disease_hpo`, `gene`, `gene_disease`, `meta`). It exits non-zero on any
failure, so it can be wired into CI later if desired. It also reports
(informationally, non-fatally) whether the optional `clingen_validity`,
`clingen_dosage_actionability`, and `mondo_xref` tables are present, since
these are meant to be gracefully absent on a database built without the
corresponding optional source files.

## Data Sources and Third-Party Terms

The compiled database draws on several independently maintained third-party
sources, each with its own terms — see [NOTICE](NOTICE) for the full text:

- **HPO** (ontology graph + disease-phenotype annotations) — CC BY 4.0,
  Human Phenotype Ontology Consortium, https://hpo.jax.org
- **OMIM** (disease identifiers/names referenced via HPO's annotation files)
  — subject to OMIM's own terms, https://omim.org/help/agreement
- **Orphanet** (ORPHA disease identifiers/names) — see
  https://www.orphadata.com/
- **HGNC** (approved gene symbols/metadata) — see https://www.genenames.org
- **ClinGen** (gene-disease validity, dosage sensitivity, and actionability
  curations, when present) — CC0 1.0 Public Domain Dedication, requests
  attribution where practical, see https://clinicalgenome.org/docs/terms-of-use/
- **Mondo Disease Ontology** (exact-match crosswalk to OMIM/Orphanet, used to
  attach ClinGen curations to a specific disease) — CC BY 4.0 (the dedicated
  OMIM mapping file is additionally CC0), Monarch Initiative, see
  https://github.com/monarch-initiative/mondo

Review each source's terms directly before any commercial deployment or bulk
redistribution of the compiled data — the HPOGraph license (see
[License and Usage](#license-and-usage)) covers this repository's code only,
not the third-party data it compiles.

## Citation

There's no dedicated paper yet. If you use HPOGraph in research or a
publication, please cite the GitHub repository and/or the live tool URL for
now — see [CITATION.cff](CITATION.cff) for machine-readable citation
metadata.

## Known limitations / possible next steps

- Candidate filtering uses ancestor **and** descendant closure (see above),
  but a disease whose closest relation to a selected term is a shared
  "cousin" term reached only sideways through a different branch (not a
  direct ancestor or descendant) could still be missed. Rare in practice for
  clinically-specific term selections.
- No per-term severity/onset input from the clinician yet (the underlying
  `disease_hpo.onset` column is already populated and ready to use for this).
- No accounts/persistence beyond the shareable `?terms=` URL — a selected
  term set otherwise lives in memory for the session only. Could be extended
  later via a Cloudflare Worker + D1 if needed, without changing the
  free-hosting model.
- No clinical validation study has been performed; ranking quality has only
  been sanity-checked against a handful of textbook cases during development
  (see [How disease/gene ranking works](#how-diseasegene-ranking-works)).
- ClinGen data is matched to a specific candidate disease only where Mondo's
  exact-match crosswalk covers it (~83% of ClinGen's Mondo IDs); the rest
  falls back to gene-level context — see
  [ClinGen integration](#clingen-integration) for the exact coverage figures.

## License and Usage

HPOGraph is free for research, academic, educational, and non-commercial use.

Commercial use, company use, commercial laboratory use, paid clinical
service use, product integration, hosted commercial deployment, or use as
part of a commercial software/service requires prior written permission
from the author.

Please see the `LICENSE` and `NOTICE` files for details.

HPOGraph may use or display data derived from third-party biomedical
resources, including HPO, OMIM-linked annotations, HGNC, and related
resources. These resources may have their own licenses and terms of use.
Users are responsible for ensuring compliance with all applicable
third-party terms.

HPOGraph is intended for research, education, and phenotype exploration. It
is not a standalone diagnostic tool.

Author: Amin Ardeshirdavani — https://github.com/aardes
