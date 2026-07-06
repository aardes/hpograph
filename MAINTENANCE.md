# Monthly maintenance checklist

HPO, HGNC, and Mondo each cut new releases roughly once a month; ClinGen's
curation set also grows continuously. This project's target cadence is to
refresh all source data **about once a month**. Nothing runs this
automatically — Cloudflare only serves whatever `data/hpo.db.gz` is
currently committed — so this is a manual, run-it-yourself checklist.

Copy this list into a scratch note each time and check items off as you go.
It's designed so a fresh run takes well under 30 minutes even if everything
needs attention.

## 1. Refresh the source data

- [ ] Run `python3 scripts/update_data.py` from the repo root. It downloads
      HPO's ontology/annotations/gene-disease files, HGNC's complete gene
      set, and Mondo's OMIM/Orphanet crosswalk files into `raw_data/`, then
      builds `data/hpo.db` + `data/hpo.db.gz` automatically.
- [ ] Watch its output for `ERROR` lines on any *required* source (HPO or
      HGNC files) — those abort the build. A `skipped (optional)` line for
      Mondo just means that build won't have disease-specific ClinGen
      matching; not fatal, but worth a second look if it keeps happening.
- [ ] **ClinGen (manual, optional):** if you want fresh ClinGen data this
      month, download the two summary CSVs yourself from
      https://search.clinicalgenome.org/kb/downloads
      (`Clingen-Gene-Disease-Summary*.csv`,
      `Clingen-Curation-Activity-Summary*.csv`) into `raw_data/`, then
      re-run with `python3 scripts/update_data.py --skip-download` so it
      reuses the files already downloaded and just rebuilds. See
      `scripts/update_data.py`'s module docstring for why this one pair of
      files can't be automated.

## 2. Sanity-check the new build

- [ ] `python3 scripts/smoke_check.py` — should print `N/N checks passed`
      with no `FAIL` lines. The `[INFO] optional ClinGen tables present`
      line tells you whether this build actually picked up ClinGen data.
- [ ] Spot-check the `meta` table against expectations:
  ```bash
  python3 -c "
  import sqlite3, gzip, tempfile, os
  with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
      p = tmp.name
  with gzip.open('data/hpo.db.gz','rb') as f_in, open(p,'wb') as f_out:
      f_out.write(f_in.read())
  conn = sqlite3.connect(p)
  for k, v in conn.execute('SELECT key, value FROM meta ORDER BY key'):
      print(k, '=', v)
  os.remove(p)
  "
  ```
  Things worth eyeballing: `build_date` is today, `num_terms` /
  `num_diseases_scored` / `num_genes` haven't dropped sharply from last
  month (a big drop usually means a source file didn't download
  completely), and `num_clingen_validity_rows` / `num_mondo_xref_rows` are
  nonzero if you included those optional files this round.
- [ ] Compare `data/hpo.db.gz`'s new size against last month's — should be
      in the same ballpark (currently ~11-12MB). A sudden jump toward 25MB
      would approach Cloudflare's per-file limit; a sudden drop toward zero
      usually means a source file was empty/truncated.
- [ ] Run one worked example end-to-end (e.g. the Marfan example: select
      Arachnodactyly + Ectopia lentis + Aortic root aneurysm) and confirm
      the top disease/gene results still look right, either via
      `python3 -m http.server` locally or by checking after deploy.

## 3. Cross-check documentation still matches the data

Run through this whenever the numbers above moved meaningfully, or at least
skim it every few months even if nothing looks obviously wrong:

- [ ] `schema_version` in the `meta` table matches what
      [README.md § Versioning / data provenance](README.md#versioning--data-provenance)
      says (search for "currently").
- [ ] The `meta` table's full key list matches the bullet list in that same
      README section — if `build_db.py` ever gains/removes a meta key,
      that bullet list needs a matching edit, and `SCHEMA_VERSION` in
      `scripts/build_db.py` should be bumped.
- [ ] File-size mentions (`~46MB`, `~11.6MB`) in `README.md` and
      `DEPLOYMENT.md` still roughly match `ls -la data/hpo.db data/hpo.db.gz`.
- [ ] `NOTICE`'s third-party data section still accurately describes every
      source actually compiled in (HPO, OMIM, Orphanet, HGNC, ClinGen,
      Mondo) — only edit this if a source was added/removed, not for
      routine data refreshes.
- [ ] If you added a new UI feature since the last refresh, check the
      in-page "About HPOGraph" FAQ (`index.html`, search for `<details>`)
      and README both describe it, in the same place (README should say
      which tab something lives on, matching the actual tab bar).

## 4. Record this month's verification snapshot

The "Data verification report" page (linked from the app header, next to
"How this works") reads small JSON snapshots — this step is what keeps it
current. Takes a few minutes once you have the numbers from steps 1-2.

- [ ] Create `docs/verification-reports/data/<YYYYMM>.json` (e.g.
      `202608.json` for August 2026), copying the structure of the previous
      month's file. Fill in: the `meta` table values pulled in step 2, the
      `data/hpo.db(.gz)` sizes, the `table_counts` for `terms`, `disease`,
      `gene`, `gene_disease`, `clingen_validity`,
      `clingen_dosage_actionability`, `mondo_xref`, which sources actually
      downloaded successfully this round (and how, if any needed a manual
      step), whether the section-3 doc cross-checks all passed, and any new
      `known_gaps` worth flagging for next month.
- [ ] Add the new period key to
      `docs/verification-reports/data/manifest.json`'s `periods` array (keep
      it sorted oldest-to-newest; the page itself also sorts defensively).
- [ ] Validate both JSON files parse: `python3 -c "import json; [json.load(open(f)) for f in ['docs/verification-reports/data/manifest.json', 'docs/verification-reports/data/<YYYYMM>.json']]"`.
- [ ] Optional but recommended: also write a short prose report at
      `docs/verification-reports/<date>-sources-verification.md` (see the
      2026-07-06 one for the format) with the reasoning behind anything
      unusual this month — the JSON is what the page renders, the prose
      report is what a human reads later to understand *why*.
- [ ] Open `docs/verification-reports/index.html` locally
      (`python3 -m http.server` from the repo root, then visit
      `/docs/verification-reports/`) and confirm the new month shows up in
      the growth charts and the "compare last 5" table before committing.

## 5. Commit and deploy

- [ ] `git status --short` and `git diff --stat` **before** staging —
      this project has previously shipped a push that silently excluded
      `data/hpo.db.gz`, so don't assume; check.
- [ ] Stage everything that actually changed, including `data/hpo.db.gz`
      itself, the new `docs/verification-reports/data/*.json` files, and
      anything in `raw_data/`-adjacent tracked files (there shouldn't be
      any — `raw_data/` is gitignored).
- [ ] Commit with a message noting what was refreshed (e.g. "Monthly data
      refresh: HPO 2026-08 release, HGNC 2026-08-01, Mondo v2026-08-xx").
- [ ] `git push`. Cloudflare redeploys automatically on push to `main`.

## 6. Verify the live deploy

- [ ] `curl -sI https://hpograph.amin-davani.workers.dev/data/hpo.db.gz | head -5`
      — confirm `200` and a `content-length` matching the file you just
      pushed (not last month's size).
- [ ] Load the live URL with a cache-busting query string (e.g.
      `?v=<today's date>`) and confirm the page loads, search works, and
      any new UI features are actually visible — Cloudflare's edge cache
      can serve a stale `index.html` for a short window right after a push
      (see `DEPLOYMENT.md`'s "Edge caching after a push" note); don't
      conclude a deploy failed from the bare URL alone if something looks
      missing immediately after pushing.
- [ ] Check the footer's build-info tooltip on the live site reflects
      today's `build_date` and the new source filenames.
- [ ] Open the live `docs/verification-reports/index.html` and confirm the
      new month's data loaded correctly there too (same cache-busting
      caveat applies).
