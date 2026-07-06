#!/usr/bin/env python3
"""
Basic smoke checks for HPOGraph -- no third-party dependencies, just the
Python 3 standard library plus a `node` binary on PATH for JS syntax
checking. Not a substitute for real tests, just a fast "did I break
something obvious" gate to run before committing/deploying.

Usage:
  python3 scripts/smoke_check.py

Exits 0 if everything passes, 1 if anything fails (prints a summary either
way).
"""
import os
import shutil
import sqlite3
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REQUIRED_FILES = [
    "index.html",
    "data/hpo.db.gz",
    "assets/js/app.js",
    "assets/js/db.js",
    "assets/js/graph.js",
    "assets/js/ranking.js",
]

JS_FILES = [
    "assets/js/app.js",
    "assets/js/db.js",
    "assets/js/graph.js",
    "assets/js/ranking.js",
]

PY_FILES = [
    "scripts/build_db.py",
]

EXPECTED_TABLES = {"terms", "edges", "synonyms", "alt_ids", "disease", "disease_hpo", "gene", "gene_disease", "meta"}


def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}" + (f" -- {detail}" if detail and not ok else ""))
    return ok


def main():
    results = []

    # 1. Required files exist
    for rel in REQUIRED_FILES:
        path = os.path.join(REPO_ROOT, rel)
        results.append(check(f"file exists: {rel}", os.path.isfile(path)))

    # 2. JS syntax (requires `node` on PATH; skip with a warning if absent
    #    rather than failing the whole run in an environment without Node)
    node = shutil.which("node")
    if node:
        for rel in JS_FILES:
            path = os.path.join(REPO_ROOT, rel)
            if not os.path.isfile(path):
                continue
            proc = subprocess.run([node, "--check", path], capture_output=True, text=True)
            ok = proc.returncode == 0
            results.append(check(f"JS syntax: {rel}", ok, proc.stderr.strip()))
    else:
        print("[SKIP] JS syntax checks -- `node` not found on PATH")

    # 3. Python syntax
    for rel in PY_FILES:
        path = os.path.join(REPO_ROOT, rel)
        if not os.path.isfile(path):
            continue
        proc = subprocess.run([sys.executable, "-m", "py_compile", path], capture_output=True, text=True)
        ok = proc.returncode == 0
        results.append(check(f"Python syntax: {rel}", ok, proc.stderr.strip()))

    # 4. Database schema sanity (only if the DB exists -- it's a build
    #    artifact, so a fresh clone without it shouldn't be treated as a
    #    hard failure for this specific check)
    db_path = os.path.join(REPO_ROOT, "data", "hpo.db")
    gz_path = db_path + ".gz"
    if os.path.isfile(db_path):
        results.append(_check_schema(db_path))
    elif os.path.isfile(gz_path):
        import gzip
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            with gzip.open(gz_path, "rb") as f_in, open(tmp_path, "wb") as f_out:
                f_out.write(f_in.read())
            results.append(_check_schema(tmp_path))
        finally:
            os.remove(tmp_path)
    else:
        results.append(check("database schema", False, "neither data/hpo.db nor data/hpo.db.gz found"))

    print()
    passed = sum(1 for r in results if r)
    total = len(results)
    print(f"{passed}/{total} checks passed")
    return 0 if passed == total else 1


def _check_schema(db_path):
    try:
        conn = sqlite3.connect(db_path)
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        conn.close()
        missing = EXPECTED_TABLES - tables
        return check("database schema: expected tables present", not missing, f"missing: {sorted(missing)}")
    except Exception as e:
        return check("database schema", False, str(e))


if __name__ == "__main__":
    sys.exit(main())
