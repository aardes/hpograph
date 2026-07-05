#!/usr/bin/env python3
"""
Build a compact SQLite database for HPOGraph from raw HPO / HGNC / OMIM source files.

Inputs (in RAW_DIR):
  hp.json                       - HPO ontology graph (terms + is_a edges + synonyms)
  phenotype.hpoa                - disease <-> HPO annotations (frequency, onset, evidence)
  genes_to_disease.txt          - gene <-> disease associations
  hgnc_complete_set_*.tsv       - HGNC gene metadata

Output:
  hpo.db  (SQLite, self-contained, ready for sql.js in the browser)

Usage:
  python3 build_db.py --raw-dir /path/to/raw_data --out /path/to/hpo.db
"""
import argparse
import csv
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

    return terms, synonyms, alt_ids, edges


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
        lines = [l for l in f if not l.startswith("#")]
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
    return diseases, disease_hpo


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
        return []
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
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if os.path.exists(args.out):
        os.remove(args.out)

    print("Loading ontology (hp.json)...")
    terms, synonyms, alt_ids, edges = load_ontology(args.raw_dir)
    print(f"  {len(terms)} terms, {len(edges)} is_a edges, {len(alt_ids)} alt-ids")

    print("Loading disease annotations (phenotype.hpoa)...")
    diseases, disease_hpo = load_hpoa(args.raw_dir)
    print(f"  {len(diseases)} diseases, {len(disease_hpo)} disease-HPO rows")

    print("Loading gene-disease associations (genes_to_disease.txt)...")
    gene_disease = load_gene_disease(args.raw_dir)
    print(f"  {len(gene_disease)} gene-disease rows")

    print("Loading HGNC gene metadata...")
    genes = load_hgnc(args.raw_dir)
    print(f"  {len(genes)} approved genes")

    print("Computing ancestor closures for IC...")
    direct_parents = build_ancestor_map(edges)
    closure = compute_ancestor_closure(terms.keys(), direct_parents)

    # Disease -> set of directly-annotated phenotypic-abnormality (aspect P) HPO terms
    disease_terms = defaultdict(set)
    for did, hid, freq, onset, evidence, aspect, qualifier in disease_hpo:
        if aspect == "P" and qualifier != "NOT" and hid in terms:
            disease_terms[did].add(hid)

    num_diseases = len(disease_terms)
    print(f"Computing information content over {num_diseases} diseases with P-aspect annotations...")

    term_disease_count = defaultdict(int)
    for did, hset in disease_terms.items():
        propagated = set()
        for h in hset:
            propagated |= closure.get(h, {h})
        for t in propagated:
            term_disease_count[t] += 1

    ic = {}
    for t in terms:
        count = term_disease_count.get(t, 0)
        # Laplace smoothing: never-annotated terms get count=1 (max informativeness for this corpus)
        freq = (count if count > 0 else 1) / num_diseases
        ic[t] = -math.log(freq)

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
        ic REAL
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
    """)

    cur.executemany(
        "INSERT INTO terms VALUES (?,?,?,?,?,?)",
        [(tid, t["name"], t["name"].lower(), t["definition"], t["obsolete"], ic[tid])
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

    cur.executescript("""
    CREATE INDEX idx_terms_name_lc ON terms(name_lc);
    CREATE INDEX idx_syn_lc ON synonyms(synonym_lc);
    CREATE INDEX idx_syn_term ON synonyms(term_id);
    CREATE INDEX idx_edges_child ON edges(child);
    CREATE INDEX idx_edges_parent ON edges(parent);
    CREATE INDEX idx_dh_disease ON disease_hpo(disease_id);
    CREATE INDEX idx_dh_hpo ON disease_hpo(hpo_id);
    CREATE INDEX idx_gd_gene ON gene_disease(gene_symbol);
    CREATE INDEX idx_gd_disease ON gene_disease(disease_id);
    CREATE INDEX idx_gene_symbol ON gene(symbol);
    """)

    import datetime
    cur.executemany("INSERT INTO meta VALUES (?,?)", [
        ("build_date", datetime.date.today().isoformat()),
        ("num_diseases_scored", str(num_diseases)),
        ("num_terms", str(len(terms))),
        ("num_genes", str(len(genes))),
    ])

    conn.commit()
    conn.execute("VACUUM")
    conn.commit()
    conn.close()

    size_mb = os.path.getsize(args.out) / (1024 * 1024)
    print(f"Done. {args.out} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
