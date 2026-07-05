# HPOGraph

A phenotype lookup tool for the Human Phenotype Ontology (HPO) that treats the
ontology as what it actually is — a directed acyclic graph, not a tree —
and turns a clinician-selected set of phenotypes into a ranked list of
candidate diseases and genes.

Live app: this repo auto-deploys to Cloudflare Pages on every push to `main`.

## Contents

- [Why a graph, not a tree](#why-a-graph-not-a-tree)
- [Running it locally](#running-it-locally)
- [Rebuilding the database](#rebuilding-the-database)
- [How search and the graph view work](#how-search-and-the-graph-view-work)
- [How disease/gene ranking works](#how-diseasegene-ranking-works)
- [Standalone term informativeness score](#standalone-term-informativeness-score)
- [Phenotype-set relationships (the distance calculator)](#phenotype-set-relationships-the-distance-calculator)
- [Project layout](#project-layout)
- [Deploying](#deploying-cloudflare-pages)
- [Data licensing](#data-licensing-note)
- [Known limitations](#known-limitations--possible-next-steps)

## Architecture, in one paragraph

Everything runs client-side: the entire dataset ships as a single SQLite file
(`data/hpo.db`, ~43MB) queried in the browser via
[sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly).
There is no backend, no server-side database, and no API to pay for or keep
running — the whole app is static files (HTML/CSS/JS + one data file), which
is why it deploys for free on Cloudflare Pages (or GitHub Pages) with zero
ongoing cost.

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
files under `file://`, so `data/hpo.db` would fail to load with the double-click-the-file
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
pulls sql.js, Cytoscape.js, and the dagre layout extension from a CDN at
load time, and everything else is plain JS files in `assets/js/`.

## Rebuilding the database

`data/hpo.db` is a compiled snapshot. It is **not** regenerated automatically
by Cloudflare Pages — you rebuild it locally and commit the new file whenever
you want to pick up a newer HPO/OMIM/HGNC release.

1. Download fresh source files into a local `raw_data/` folder (this folder is
   gitignored — it's only a rebuild input, never committed):
   - HPO ontology + annotations: https://hpo.jax.org/data/annotations
     — need `hp.json`, `phenotype.hpoa`, `genes_to_disease.txt`
   - HGNC gene metadata: https://www.genenames.org/download/statistics-and-files/
     — need `hgnc_complete_set_*.tsv`
2. Run the build script:
   ```bash
   python3 scripts/build_db.py --raw-dir raw_data --out data/hpo.db
   ```
   This is a plain Python 3 script with no third-party dependencies (only
   `sqlite3`, `json`, `csv`, `math` from the standard library) — takes under
   a minute.
3. Commit `data/hpo.db`. That's the only file that needs to change; push, and
   Cloudflare Pages redeploys the new data automatically.

The script parses the raw files and compiles them into one compact SQLite
database:

- `terms`, `edges`, `synonyms`, `alt_ids` — the HPO ontology graph (from `hp.json`)
- `disease`, `disease_hpo` — disease↔HPO annotations with frequency/onset/evidence (from `phenotype.hpoa`)
- `gene`, `gene_disease` — gene↔disease associations (from `genes_to_disease.txt`, `hgnc_complete_set.tsv`)
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
defaulting to 0.5 when unspecified. Candidate diseases are pre-filtered to
those sharing at least one term in the selected terms' ancestor closure,
which keeps scoring fast (typically well under a second in-browser).

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

## Project layout

```
index.html              entry point (also carries the on-page documentation section)
assets/css/style.css
assets/js/db.js          sql.js loader + query wrapper
assets/js/graph.js       Cytoscape.js DAG neighborhood view
assets/js/ranking.js     IC/Resnik-Lin similarity + BMA ranking, explainability, relatedness
assets/js/app.js         UI wiring (search, selected terms, tabs, ranking display)
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
