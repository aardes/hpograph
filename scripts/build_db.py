#!/usr/bin/env python3
"""
Build a compact SQLite database for HPOGraph from raw HPO / HGNC / OMIM source files.

Inputs (in RAW_DIR):
  hp.json                       - HPO ontology graph (terms + is_a edges + synonyms)
  phenotype.hpoa                - disease <-> HPO annotations (frequency, onset, evidence)
  genes_to_disease.txt          - gene <-> disease associations
  hgnc_complete_set_*.tsv       - HGNC gene metadata
  Clingen-Gene-Disease-Summary*.csv       - ClinGen gene-disease validity curations (optional)
  Clingen-Curation-Activity-Summary*.csv  - ClinGen dosage sensitivity + actionability (optional)
  mondo_exactmatch_omim.sssom.tsv         - Mondo -> OMIM exact-match crosswalk (optional)
  mondo.sssom.tsv                         - Mondo's full mapping set; only its Orphanet
                                             exact-match subset is used (optional)

  The ClinGen and Mondo files are all optional: if absent, the corresponding
  tables are simply left empty and the app treats that data as unavailable
  rather than failing. Download fresh ClinGen copies from
  https://search.clinicalgenome.org/kb/gene-validity (their filenames embed a
  download date, e.g. "-2026-07-06", which is why we glob-match the prefix
  rather than an exact filename); download Mondo's SSSOM releases from
  https://github.com/monarch-initiative/mondo/releases.

  ClinGen curations key gene<->disease pairs by HGNC gene symbol and Mondo
  disease ID. Mondo's own exact-match crosswalk (loaded into `mondo_xref`
  below) resolves the large majority of our OMIM/Orphanet diseases to a
  Mondo ID, letting most ClinGen rows be joined to one specific candidate
  disease directly; where no exact Mondo match exists, ClinGen data falls
  back to being surfaced per-GENE only (via the shared `gene` table), not
  attached to a specific candidate disease row. See README for more detail.

Output:
  hpo.db  (SQLite, self-contained, ready for sql.js in the browser)

Usage:
  python3 build_db.py --raw-dir /path/to/raw_data --out /path/to/hpo.db
"""
import argparse
import csv
import gzip
import json
import math
import os
import re
import sqlite3
import sys
from collections import defaultdict

HP_FREQ_MAP = {
    "HP:0040280": 1.00,   # Obligate (100%)
    "HP:0040281": 0.895,  # Very frequent (80-99%)
    "HP:0040282": 0.545,  # Frequent (30-79%)
    "HP:0040283": 0.17,   # Occasional (5-29%)
    "HP:0040284": 0.025,  # Very rare (1-4%)
    "HP:0040285": 0.00,   # Excluded (0%)
}

FRACTION_RE = re.compile(r"^(\d+)/(\d+)$")
PERCENT_RE = re.compile(r"^([\d.]+)\s*%$")

# Bump this whenever the `meta` table's set of keys, or any table's columns,
# change in a way the frontend should be able to detect/react to. Purely
# additive data refreshes (new HPO release, same schema) do not need a bump.
SCHEMA_VERSION = "1.3"


def parse_frequency(raw):
    if not raw:
        return None
    raw = raw.strip()
    if not raw:
        return None
    if raw in HP_FREQ_MAP:
        return HP_FREQ_MAP[raw]
    m = FRACTION_RE.match(raw)
    if m:
        n, d = int(m.group(1)), int(m.group(2))
        return n / d if d else None
    m = PERCENT_RE.match(raw)
    if m:
        return float(m.group(1)) / 100.0
    return None


def short_id(uri_or_id):
    """Normalize 'http://purl.obolibrary.org/obo/HP_0001167' or 'HP_0001167' -> 'HP:0001167'."""
    if not uri_or_id:
        return None
    frag = uri_or_id.rsplit("/", 1)[-1]
    if "_" in frag:
        prefix, num = frag.split("_", 1)
        return f"{prefix}:{num}"
    return frag


def load_ontology(raw_dir):
    path = os.path.join(raw_dir, "hp.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    g = data["graphs"][0]

    # hp.json publishes its own release identifier as a versioned IRI, e.g.
    # "http://purl.obolibrary.org/obo/hp/releases/2024-08-08/hp.json" -- this
    # is the most reliable "what HPO release is this" marker available, so we
    # surface it as build metadata (see meta table / --source-info below).
    ontology_version = (g.get("meta", {}) or {}).get("version") or data.get("id") or ""

    terms = {}          # id -> dict(name, definition, obsolete)
    synonyms = defaultdict(set)
    alt_ids = {}         # alt_id -> canonical id
    edges = []           # (child, parent)

    for n in g["nodes"]:
        tid = short_id(n["id"])
        if not tid or not tid.startswith("HP:"):
            continue
        meta = n.get("meta", {}) or {}
        obsolete = 1 if meta.get("deprecated") else 0
        name = n.get("lbl", "") or ""
        definition = (meta.get("definition") or {}).get("val", "")
        terms[tid] = {"name": name, "definition": definition, "obsolete": obsolete}

        for syn in meta.get("synonyms", []) or []:
            val = syn.get("val")
            if val:
                synonyms[tid].add(val)

        for bpv in meta.get("basicPropertyValues", []) or []:
            if bpv.get("pred", "").endswith("hasAlternativeId"):
                alt = bpv.get("val")
                if alt:
                    alt_ids[alt] = tid

    for e in g["edges"]:
        if e.get("pred") != "is_a":
            continue
        child = short_id(e.get("sub"))
        parent = short_id(e.get("obj"))
        if child in terms and parent in terms:
            edges.append((child, parent))

    return terms, synonyms, alt_ids, edges, ontology_version


def build_ancestor_map(edges):
    """child -> set of parents (direct)."""
    parents = defaultdict(set)
    for child, parent in edges:
        parents[child].add(parent)
    return parents


def compute_ancestor_closure(term_ids, direct_parents):
    """Return dict term -> set(all ancestors including self), via memoized DFS."""
    closure = {}

    def dfs(t, stack):
        if t in closure:
            return closure[t]
        if t in stack:
            return {t}  # cycle guard, shouldn't happen in HPO
        stack.add(t)
        result = {t}
        for p in direct_parents.get(t, ()):
            result |= dfs(p, stack)
        stack.discard(t)
        closure[t] = result
        return result

    for t in term_ids:
        dfs(t, set())
    return closure


def load_hpoa(raw_dir):
    path = os.path.join(raw_dir, "phenotype.hpoa")
    diseases = {}  # id -> name
    disease_hpo = []  # (disease_id, hpo_id, frequency, onset, evidence, aspect, qualifier)
    with open(path, encoding="utf-8") as f:
        raw_lines = list(f)

    # phenotype.hpoa's leading "#"-commented header carries its own release
    # date/description (e.g. "#date: 2024-08-08"); capture it as build
    # metadata before discarding comment lines for the TSV parse below.
    header_lines = [l.lstrip("#").strip() for l in raw_lines if l.startswith("#")]
    date_match = None
    for hl in header_lines:
        m = re.search(r"date:\s*(\S+)", hl, re.IGNORECASE)
        if m:
            date_match = m.group(1)
            break
    annotation_version = date_match or (header_lines[0] if header_lines else "")

    lines = [l for l in raw_lines if not l.startswith("#")]
    reader = csv.DictReader(lines, delimiter="\t")
    for row in reader:
        did = row["database_id"].strip()
        dname = row["disease_name"].strip()
        hid = row["hpo_id"].strip()
        if not did or not hid:
            continue
        diseases[did] = dname
        freq = parse_frequency(row.get("frequency", ""))
        onset = (row.get("onset") or "").strip() or None
        evidence = (row.get("evidence") or "").strip() or None
        aspect = (row.get("aspect") or "").strip() or None
        qualifier = (row.get("qualifier") or "").strip() or None
        disease_hpo.append((did, hid, freq, onset, evidence, aspect, qualifier))
    return diseases, disease_hpo, annotation_version


def load_gene_disease(raw_dir):
    path = os.path.join(raw_dir, "genes_to_disease.txt")
    rows = []
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            sym = row["gene_symbol"].strip()
            did = row["disease_id"].strip()
            assoc = row["association_type"].strip()
            ncbi = row.get("ncbi_gene_id", "").strip() or None
            if sym and did:
                rows.append((sym, did, assoc, ncbi))
    return rows


def load_hgnc(raw_dir):
    fname = None
    for f in os.listdir(raw_dir):
        if f.startswith("hgnc_complete_set"):
            fname = f
            break
    if not fname:
        return [], ""
    path = os.path.join(raw_dir, fname)
    rows = []
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            if row.get("status") != "Approved":
                continue
            rows.append({
                "hgnc_id": row.get("hgnc_id", ""),
                "symbol": row.get("symbol", ""),
                "name": row.get("name", ""),
                "entrez_id": row.get("entrez_id", "") or None,
                "ensembl_gene_id": row.get("ensembl_gene_id", "") or None,
                "omim_id": row.get("omim_id", "") or None,
                "alias_symbol": row.get("alias_symbol", "") or None,
                "prev_symbol": row.get("prev_symbol", "") or None,
                "location": row.get("location", "") or None,
            })
    return rows, fname


def _find_clingen_file(raw_dir, prefix):
    """ClinGen export filenames embed a download date (e.g. '-2026-07-06'),
    so match by prefix instead of an exact name. Returns None if not found --
    ClinGen data is optional."""
    import glob
    matches = sorted(glob.glob(os.path.join(raw_dir, prefix + "*.csv")))
    return matches[0] if matches else None


def load_clingen_validity(raw_dir):
    """Parse a ClinGen 'Gene-Disease-Summary' export: one row per gene<->MONDO
    disease Gene-Disease Validity Classification (Definitive/Strong/Moderate/
    Limited/Disputed/Refuted/No Known Disease Relationship), assigned by an
    expert Gene Curation Expert Panel (GCEP). The file has a few metadata/
    banner lines before the real header, and a decorative "+++++" divider
    row right after it -- both are skipped.

    Returns (rows, source_filename); ([], "") if the file isn't present.
    """
    path = _find_clingen_file(raw_dir, "Clingen-Gene-Disease-Summary")
    if not path:
        return [], ""
    with open(path, encoding="utf-8-sig") as f:
        lines = f.readlines()
    hdr_idx = next((i for i, l in enumerate(lines) if l.startswith('"GENE SYMBOL"')), None)
    if hdr_idx is None:
        return [], ""
    reader = csv.DictReader(lines[hdr_idx:])
    rows = []
    for row in reader:
        symbol = (row.get("GENE SYMBOL") or "").strip()
        if not symbol or symbol.startswith("+"):
            continue
        rows.append((
            symbol,
            (row.get("GENE ID (HGNC)") or "").strip(),
            (row.get("DISEASE LABEL") or "").strip(),
            (row.get("DISEASE ID (MONDO)") or "").strip(),
            (row.get("MOI") or "").strip(),
            (row.get("CLASSIFICATION") or "").strip(),
            (row.get("CLASSIFICATION DATE") or "").strip(),
            (row.get("GCEP") or "").strip(),
            (row.get("ONLINE REPORT") or "").strip(),
        ))
    return rows, os.path.basename(path)


def load_clingen_dosage_actionability(raw_dir):
    """Parse a ClinGen 'Curation-Activity-Summary' export for dosage
    sensitivity (haploinsufficiency/triplosensitivity) and clinical
    actionability fields only -- gene-disease validity is already covered,
    more cleanly, by load_clingen_validity() from the other export. Rows
    with none of these three fields populated are skipped (nothing new to
    add over the validity table). Returns (rows, source_filename).
    """
    path = _find_clingen_file(raw_dir, "Clingen-Curation-Activity-Summary")
    if not path:
        return [], ""
    with open(path, encoding="utf-8-sig") as f:
        lines = f.readlines()
    hdr_idx = next((i for i, l in enumerate(lines) if l.startswith('"gene_symbol"')), None)
    if hdr_idx is None:
        return [], ""
    reader = csv.DictReader(lines[hdr_idx:])
    rows = []
    for row in reader:
        symbol = (row.get("gene_symbol") or "").strip()
        if not symbol:
            continue
        haplo = (row.get("dosage_haploinsufficiency_assertion") or "").strip()
        triplo = (row.get("dosage_triplosensitivity_assertion") or "").strip()
        action_class = (row.get("actionability_assertion_classifications") or "").strip()
        if not haplo and not triplo and not action_class:
            continue
        rows.append((
            symbol,
            (row.get("hgnc_id") or "").strip(),
            (row.get("disease_label") or "").strip(),
            (row.get("mondo_id") or "").strip(),
            haplo,
            triplo,
            (row.get("dosage_report") or "").strip(),
            action_class,
            (row.get("actionability_assertion_reports") or "").strip(),
            (row.get("actionability_groups") or "").strip(),
        ))
    return rows, os.path.basename(path)


def _parse_sssom_rows(path):
    """Yield dict rows from a Mondo SSSOM TSV mapping file. These files carry
    a block of '#'-prefixed metadata/license lines before the real
    tab-separated header (subject_id, subject_label, predicate_id, object_id,
    object_label, mapping_justification) -- comment lines are stripped and
    the remaining lines are parsed as a normal TSV with a header row.
    """
    with open(path, encoding="utf-8-sig") as f:
        lines = [line for line in f if not line.startswith("#")]
    return csv.DictReader(lines, delimiter="\t")


def load_mondo_omim_xref(raw_dir):
    """Parse Mondo's dedicated, official exact-match crosswalk to OMIM
    (mondo_exactmatch_omim.sssom.tsv, CC0-licensed). Each row is a curated
    disease-level correspondence between one Mondo ID and one specific OMIM
    entry -- this is what lets ClinGen data (keyed by Mondo ID) be joined
    directly to one of our candidate diseases, instead of only through a
    shared gene (see clingen_validity below). Object IDs in this file are
    already in "OMIM:123456" form, matching disease.id directly.

    Returns (rows, source_filename) where rows are (disease_id, mondo_id)
    tuples; ([], "") if the file isn't present -- this crosswalk is optional.
    """
    path = os.path.join(raw_dir, "mondo_exactmatch_omim.sssom.tsv")
    if not os.path.isfile(path):
        return [], ""
    rows = []
    for row in _parse_sssom_rows(path):
        if row.get("predicate_id") != "skos:exactMatch":
            continue
        omim_id = (row.get("object_id") or "").strip()
        mondo_id = (row.get("subject_id") or "").strip()
        if omim_id and mondo_id:
            rows.append((omim_id, mondo_id))
    return rows, os.path.basename(path)


def load_mondo_orpha_xref(raw_dir):
    """Parse the Orphanet exact-match subset of Mondo's full mapping set
    (mondo.sssom.tsv). Unlike the dedicated OMIM file above, this release
    artifact bundles many source ontologies together in one file (UMLS,
    ICD, SNOMED, Orphanet, and others) -- some of which (UMLS/MedGen) carry
    their own separate, more restrictive redistribution terms. Only
    skos:exactMatch rows whose object is an Orphanet ID are extracted here;
    every other row is ignored entirely and never reaches our compiled
    database. Object IDs are rewritten from Mondo's "Orphanet:12345" to this
    project's "ORPHA:12345" convention to match disease.id.

    Returns (rows, source_filename); rows are (disease_id, mondo_id) tuples;
    ([], "") if the file isn't present -- this crosswalk is optional.
    """
    path = os.path.join(raw_dir, "mondo.sssom.tsv")
    if not os.path.isfile(path):
        return [], ""
    rows = []
    for row in _parse_sssom_rows(path):
        if row.get("predicate_id") != "skos:exactMatch":
            continue
        object_id = (row.get("object_id") or "").strip()
        if not object_id.startswith("Orphanet:"):
            continue
        orpha_id = "ORPHA:" + object_id.split(":", 1)[1]
        mondo_id = (row.get("subject_id") or "").strip()
        if mondo_id:
            rows.append((orpha_id, mondo_id))
    return rows, os.path.basename(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if os.path.exists(args.out):
        os.remove(args.out)

    print("Loading ontology (hp.json)...")
    terms, synonyms, alt_ids, edges, ontology_version = load_ontology(args.raw_dir)
    print(f"  {len(terms)} terms, {len(edges)} is_a edges, {len(alt_ids)} alt-ids")

    print("Loading disease annotations (phenotype.hpoa)...")
    diseases, disease_hpo, annotation_version = load_hpoa(args.raw_dir)
    print(f"  {len(diseases)} diseases, {len(disease_hpo)} disease-HPO rows")

    print("Loading gene-disease associations (genes_to_disease.txt)...")
    gene_disease = load_gene_disease(args.raw_dir)
    print(f"  {len(gene_disease)} gene-disease rows")

    print("Loading HGNC gene metadata...")
    genes, hgnc_source_file = load_hgnc(args.raw_dir)
    print(f"  {len(genes)} approved genes")

    print("Loading ClinGen gene-disease validity (optional)...")
    clingen_validity, clingen_validity_source = load_clingen_validity(args.raw_dir)
    print(f"  {len(clingen_validity)} rows" + (f" from {clingen_validity_source}" if clingen_validity_source else " (file not found -- skipped)"))

    print("Loading ClinGen dosage/actionability (optional)...")
    clingen_dosage, clingen_dosage_source = load_clingen_dosage_actionability(args.raw_dir)
    print(f"  {len(clingen_dosage)} rows" + (f" from {clingen_dosage_source}" if clingen_dosage_source else " (file not found -- skipped)"))

    print("Loading Mondo-OMIM exact-match crosswalk (optional)...")
    mondo_omim_xref, mondo_omim_xref_source = load_mondo_omim_xref(args.raw_dir)
    print(f"  {len(mondo_omim_xref)} rows" + (f" from {mondo_omim_xref_source}" if mondo_omim_xref_source else " (file not found -- skipped)"))

    print("Loading Mondo-Orphanet exact-match crosswalk (optional)...")
    mondo_orpha_xref, mondo_orpha_xref_source = load_mondo_orpha_xref(args.raw_dir)
    print(f"  {len(mondo_orpha_xref)} rows" + (f" from {mondo_orpha_xref_source}" if mondo_orpha_xref_source else " (file not found -- skipped)"))
    mondo_xref = (
        [(did, mid, "omim_exact") for did, mid in mondo_omim_xref]
        + [(did, mid, "orpha_exact") for did, mid in mondo_orpha_xref]
    )

    print("Computing ancestor closures for IC...")
    direct_parents = build_ancestor_map(edges)
    closure = compute_ancestor_closure(terms.keys(), direct_parents)

    # Disease -> set of directly-annotated phenotypic-abnormality (aspect P) HPO terms
    disease_terms = defaultdict(set)
    for did, hid, freq, onset, evidence, aspect, qualifier in disease_hpo:
        if aspect == "P" and qualifier != "NOT" and hid in terms:
            disease_terms[did].add(hid)

    num_diseases = len(disease_terms)
    print(f"Computing disease-based information content over {num_diseases} diseases with P-aspect annotations...")

    # term -> set of diseases annotated to it OR any of its descendants (propagated up the DAG)
    term_diseases_propagated = defaultdict(set)
    for did, hset in disease_terms.items():
        propagated_terms = set()
        for h in hset:
            propagated_terms |= closure.get(h, {h})
        for t in propagated_terms:
            term_diseases_propagated[t].add(did)

    ic = {}
    for t in terms:
        count = len(term_diseases_propagated.get(t, ()))
        # Laplace smoothing: never-annotated terms get count=1 (max informativeness for this corpus)
        freq = (count if count > 0 else 1) / num_diseases
        ic[t] = -math.log(freq)

    # ------------------------------------------------------------------
    # Gene-based term specificity/informativeness scoring.
    #
    # Two variants are computed, deliberately different in scope:
    #
    # 1. `gene_ic` -- PROPAGATED (like the disease-based `ic` above): a term's
    #    gene set is the union of genes linked to any disease annotated with
    #    that term OR any of its descendants. This keeps IC monotonically
    #    non-decreasing from root to leaf, which the Resnik/Lin MICA-based
    #    similarity engine (ranking.js) depends on to behave sensibly for
    #    ancestor terms (most of which are rarely annotated directly).
    #    This is what powers the disease/gene ranking.
    #
    # 2. `direct_final_score` / `spec_rank` -- the literal formula as
    #    specified, using ONLY each term's own direct annotations (no
    #    ontology propagation). This is a standalone "how informative is
    #    this exact HPO term" leaderboard metric, shown next to a term in
    #    the UI -- not used by the similarity engine, since most internal
    #    ontology nodes are barely ever annotated directly and would all
    #    collapse to ~0 if used for graph similarity.
    # ------------------------------------------------------------------
    print("Computing gene-based term specificity scores...")

    disease_genes = defaultdict(set)
    for sym, did, assoc, ncbi in gene_disease:
        disease_genes[did].add(sym)

    total_genes_with_any_hpo = len({sym for sym, did, assoc, ncbi in gene_disease})

    # --- 1. propagated gene_ic (feeds ranking.js) ---
    gene_ic = {}
    for t in terms:
        gene_set = set()
        for did in term_diseases_propagated.get(t, ()):
            gene_set |= disease_genes.get(did, ())
        count = len(gene_set)
        ratio = (count if count > 0 else 1) / max(total_genes_with_any_hpo, 1)
        gene_ic[t] = -math.log(ratio)

    # --- 2. direct (non-propagated) formula, exactly as specified ---
    term_diseases_direct = defaultdict(set)
    for did, hset in disease_terms.items():
        for h in hset:
            term_diseases_direct[h].add(did)

    # frequency weight per disease_hpo row (unknown frequency defaults to 0.5, same convention as ranking.js)
    def freq_weight(f):
        return f if f is not None else 0.5

    term_freq_rows = defaultdict(list)
    for did, hid, freq, onset, evidence, aspect, qualifier in disease_hpo:
        if aspect == "P" and qualifier != "NOT" and hid in terms:
            term_freq_rows[hid].append(freq)

    direct_gene_count = {}
    direct_disease_count = {}
    direct_pair_count = {}   # gene-disease PAIRS containing this term (not distinct genes)
    direct_frequency_support = {}

    for t in terms:
        dids = term_diseases_direct.get(t, ())
        direct_disease_count[t] = len(dids)
        gene_set = set()
        pair_count = 0
        for did in dids:
            g = disease_genes.get(did, ())
            gene_set |= g
            pair_count += len(g)
        direct_gene_count[t] = len(gene_set)
        direct_pair_count[t] = pair_count

        rows = term_freq_rows.get(t)
        if rows:
            direct_frequency_support[t] = sum(freq_weight(f) for f in rows) / len(rows)
        else:
            direct_frequency_support[t] = 0.0

    # normalized_IC and gene_specificity, guarding the zero-gene-count case
    # (no Laplace smoothing here: a term with zero direct gene evidence gets
    # a 0 contribution rather than being artificially treated as maximally
    # specific -- it simply has no data to be informative from).
    raw_ic = {}
    raw_specificity = {}
    log_total_genes = math.log10(max(total_genes_with_any_hpo, 2))
    for t in terms:
        c = direct_gene_count[t]
        if c <= 0:
            raw_ic[t] = 0.0
            raw_specificity[t] = 0.0
        else:
            raw_ic[t] = -math.log10(c / total_genes_with_any_hpo)
            raw_specificity[t] = 1 - (math.log10(c) / log_total_genes)

    max_ic = max(raw_ic.values()) if raw_ic else 1.0
    max_pair_count = max(direct_pair_count.values()) if direct_pair_count else 1

    direct_final_score = {}
    for t in terms:
        normalized_ic = raw_ic[t] / max_ic if max_ic > 0 else 0.0
        gene_specificity = raw_specificity[t]
        gene_disease_support = direct_pair_count[t] / max_pair_count if max_pair_count > 0 else 0.0
        frequency_support = direct_frequency_support[t]
        direct_final_score[t] = (
            0.40 * normalized_ic
            + 0.30 * gene_specificity
            + 0.20 * gene_disease_support
            + 0.10 * frequency_support
        )

    # rank 1..N: final_score DESC, disease_link_count DESC, related_gene_count ASC, hpo_id ASC
    ordered = sorted(
        terms.keys(),
        key=lambda t: (
            -direct_final_score[t],
            -direct_disease_count[t],
            direct_gene_count[t],
            t,
        ),
    )
    spec_rank = {t: i + 1 for i, t in enumerate(ordered)}

    print("Writing SQLite database...")
    conn = sqlite3.connect(args.out)
    cur = conn.cursor()
    cur.executescript("""
    PRAGMA journal_mode=OFF;
    PRAGMA synchronous=OFF;

    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE terms (
        id TEXT PRIMARY KEY,
        name TEXT,
        name_lc TEXT,
        definition TEXT,
        obsolete INTEGER DEFAULT 0,
        ic REAL,               -- disease-propagation-based IC (legacy)
        gene_ic REAL,          -- gene-propagation-based IC (drives ranking.js similarity)
        direct_gene_count INTEGER,
        direct_disease_count INTEGER,
        direct_final_score REAL,  -- literal user formula, direct annotations only
        spec_rank INTEGER         -- 1..N leaderboard rank by direct_final_score
    );
    CREATE TABLE alt_ids (
        alt_id TEXT PRIMARY KEY,
        term_id TEXT
    );
    CREATE TABLE synonyms (
        term_id TEXT,
        synonym TEXT,
        synonym_lc TEXT
    );
    CREATE TABLE edges (
        child TEXT,
        parent TEXT
    );
    CREATE TABLE disease (
        id TEXT PRIMARY KEY,
        name TEXT,
        db TEXT
    );
    CREATE TABLE disease_hpo (
        disease_id TEXT,
        hpo_id TEXT,
        frequency REAL,
        onset TEXT,
        evidence TEXT,
        aspect TEXT,
        qualifier TEXT
    );
    CREATE TABLE gene (
        symbol TEXT PRIMARY KEY,
        hgnc_id TEXT,
        name TEXT,
        entrez_id TEXT,
        ensembl_gene_id TEXT,
        omim_id TEXT,
        alias_symbol TEXT,
        prev_symbol TEXT,
        location TEXT
    );
    CREATE TABLE gene_disease (
        gene_symbol TEXT,
        disease_id TEXT,
        association_type TEXT,
        ncbi_gene_id TEXT
    );
    -- ClinGen data is keyed by MONDO disease ID, which has no built-in
    -- mapping to the OMIM/Orphanet IDs disease.id uses here. mondo_xref
    -- below (from Mondo's own official exact-match crosswalks) supplies that
    -- mapping for ~99% of our OMIM/Orphanet diseases, letting most ClinGen
    -- rows be joined to one specific candidate disease directly. Where no
    -- exact Mondo match exists for a disease, the app falls back to
    -- attaching ClinGen info via a shared gene instead (less precise, since
    -- one gene can be linked to several diseases) -- see ranking.js.
    CREATE TABLE clingen_validity (
        gene_symbol TEXT,
        hgnc_id TEXT,
        disease_label TEXT,
        mondo_id TEXT,
        moi TEXT,
        classification TEXT,
        classification_date TEXT,
        gcep TEXT,
        report_url TEXT
    );
    CREATE TABLE clingen_dosage_actionability (
        gene_symbol TEXT,
        hgnc_id TEXT,
        disease_label TEXT,
        mondo_id TEXT,
        dosage_haploinsufficiency TEXT,
        dosage_triplosensitivity TEXT,
        dosage_report_url TEXT,
        actionability_classification TEXT,
        actionability_report_url TEXT,
        actionability_group TEXT
    );
    -- Mondo's official exact-match crosswalk: one row per (disease_id,
    -- mondo_id) correspondence, sourced from Mondo's own dedicated OMIM
    -- mapping release plus the Orphanet subset of its full mapping set
    -- (see load_mondo_omim_xref / load_mondo_orpha_xref above). `source`
    -- records which of the two crosswalk files a row came from, for
    -- provenance/debugging only.
    CREATE TABLE mondo_xref (
        disease_id TEXT,
        mondo_id TEXT,
        source TEXT
    );
    """)

    cur.executemany(
        "INSERT INTO terms VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [(tid, t["name"], t["name"].lower(), t["definition"], t["obsolete"], ic[tid],
          gene_ic[tid], direct_gene_count[tid], direct_disease_count[tid],
          direct_final_score[tid], spec_rank[tid])
         for tid, t in terms.items()]
    )
    cur.executemany("INSERT INTO alt_ids VALUES (?,?)", list(alt_ids.items()))
    syn_rows = []
    for tid, syns in synonyms.items():
        for s in syns:
            syn_rows.append((tid, s, s.lower()))
    cur.executemany("INSERT INTO synonyms VALUES (?,?,?)", syn_rows)
    cur.executemany("INSERT INTO edges VALUES (?,?)", edges)

    disease_db_rows = []
    for did, name in diseases.items():
        db = did.split(":", 1)[0]
        disease_db_rows.append((did, name, db))
    cur.executemany("INSERT INTO disease VALUES (?,?,?)", disease_db_rows)
    cur.executemany("INSERT INTO disease_hpo VALUES (?,?,?,?,?,?,?)", disease_hpo)

    gene_rows = [(g["symbol"], g["hgnc_id"], g["name"], g["entrez_id"], g["ensembl_gene_id"],
                  g["omim_id"], g["alias_symbol"], g["prev_symbol"], g["location"]) for g in genes]
    cur.executemany("INSERT INTO gene VALUES (?,?,?,?,?,?,?,?,?)", gene_rows)
    cur.executemany("INSERT INTO gene_disease VALUES (?,?,?,?)", gene_disease)
    cur.executemany("INSERT INTO clingen_validity VALUES (?,?,?,?,?,?,?,?,?)", clingen_validity)
    cur.executemany("INSERT INTO clingen_dosage_actionability VALUES (?,?,?,?,?,?,?,?,?,?)", clingen_dosage)
    cur.executemany("INSERT INTO mondo_xref VALUES (?,?,?)", mondo_xref)

    cur.executescript("""
    CREATE INDEX idx_terms_name_lc ON terms(name_lc);
    CREATE INDEX idx_terms_spec_rank ON terms(spec_rank);
    CREATE INDEX idx_syn_lc ON synonyms(synonym_lc);
    CREATE INDEX idx_syn_term ON synonyms(term_id);
    CREATE INDEX idx_edges_child ON edges(child);
    CREATE INDEX idx_edges_parent ON edges(parent);
    CREATE INDEX idx_dh_disease ON disease_hpo(disease_id);
    CREATE INDEX idx_dh_hpo ON disease_hpo(hpo_id);
    CREATE INDEX idx_gd_gene ON gene_disease(gene_symbol);
    CREATE INDEX idx_gd_disease ON gene_disease(disease_id);
    CREATE INDEX idx_gene_symbol ON gene(symbol);
    CREATE INDEX idx_clingen_validity_gene ON clingen_validity(gene_symbol);
    CREATE INDEX idx_clingen_dosage_gene ON clingen_dosage_actionability(gene_symbol);
    CREATE INDEX idx_clingen_validity_mondo ON clingen_validity(mondo_id);
    CREATE INDEX idx_mondo_xref_disease ON mondo_xref(disease_id);
    CREATE INDEX idx_mondo_xref_mondo ON mondo_xref(mondo_id);
    """)

    import datetime
    cur.executemany("INSERT INTO meta VALUES (?,?)", [
        ("build_date", datetime.date.today().isoformat()),
        ("num_diseases_scored", str(num_diseases)),
        ("num_terms", str(len(terms))),
        ("num_genes", str(len(genes))),
        ("total_genes_with_any_hpo", str(total_genes_with_any_hpo)),
        ("schema_version", SCHEMA_VERSION),
        ("hpo_source", ontology_version or "https://hpo.jax.org (hp.json) -- version string not present in source file"),
        ("phenotype_annotation_source", annotation_version or "https://hpo.jax.org (phenotype.hpoa) -- version string not present in source file"),
        ("hgnc_source", hgnc_source_file or "https://www.genenames.org (hgnc_complete_set) -- file not found at build time"),
        ("clingen_validity_source", clingen_validity_source or "not included in this build"),
        ("clingen_dosage_actionability_source", clingen_dosage_source or "not included in this build"),
        ("num_clingen_validity_rows", str(len(clingen_validity))),
        ("mondo_omim_xref_source", mondo_omim_xref_source or "not included in this build"),
        ("mondo_orpha_xref_source", mondo_orpha_xref_source or "not included in this build"),
        ("num_mondo_xref_rows", str(len(mondo_xref))),
    ])

    conn.commit()
    conn.execute("VACUUM")
    conn.commit()
    conn.close()

    size_mb = os.path.getsize(args.out) / (1024 * 1024)
    print(f"Done. {args.out} ({size_mb:.1f} MB)")

    # Cloudflare Pages (and most static hosts) reject/refuse individual files
    # over ~25 MiB. The raw sqlite file comes out well above that, but it
    # compresses very well (SQLite pages are mostly text/low-entropy), so we
    # also ship a gzipped copy. The browser fetches THIS file and decompresses
    # it client-side with the native DecompressionStream API (see db.js) --
    # no server-side gzip negotiation required, and no extra JS library needed.
    gz_path = args.out + ".gz"
    print("Compressing for static hosting (gzip)...")
    with open(args.out, "rb") as f_in, gzip.open(gz_path, "wb", compresslevel=9) as f_out:
        f_out.write(f_in.read())
    gz_size_mb = os.path.getsize(gz_path) / (1024 * 1024)
    print(f"Done. {gz_path} ({gz_size_mb:.1f} MB) -- this is the file committed to git / deployed.")


if __name__ == "__main__":
    main()
