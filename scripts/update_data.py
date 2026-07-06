#!/usr/bin/env python3
"""
Download fresh copies of every source file HPOGraph's database is built
from, then rebuild data/hpo.db (and data/hpo.db.gz) from them.

This is meant to be run roughly once a month (HPO, HGNC, and Mondo all cut
new releases on a monthly-ish cadence) to pick up newly added phenotype
annotations, gene metadata, and Mondo cross-references. It is a convenience
wrapper around build_db.py -- it does not change how the database is
compiled, it just automates gathering the inputs build_db.py expects in
--raw-dir.

What it downloads (into --raw-dir, default "raw_data/"):
  hp.json                    <- HPO's GitHub release (ontology graph)
  phenotype.hpoa             <- HPO's GitHub release (disease<->HPO annotations)
  genes_to_disease.txt       <- HPO's GitHub release (gene<->disease associations)
  hgnc_complete_set.tsv      <- HGNC's stable bulk-download mirror
  mondo_exactmatch_omim.sssom.tsv  <- Mondo's mappings directory on GitHub
  mondo.sssom.tsv                  <- Mondo's mappings directory on GitHub
                                     (build_db.py filters this down to its
                                     Orphanet exact-match subset itself)

What it does NOT download automatically:
  Clingen-Gene-Disease-Summary*.csv
  Clingen-Curation-Activity-Summary*.csv
    ClinGen's own downloads page (https://search.clinicalgenome.org/kb/downloads)
    generates these as an interactive export with a date-stamped filename --
    there is no stable, unauthenticated URL to fetch them from
    programmatically. These two files are OPTIONAL (build_db.py already
    degrades gracefully without them -- ClinGen data just won't be attached
    in that build), so this script prints a reminder with the download URL
    instead of failing.

Usage:
  python3 scripts/update_data.py
  python3 scripts/update_data.py --raw-dir raw_data --out data/hpo.db
  python3 scripts/update_data.py --skip-download   # reuse files already in --raw-dir
"""
import argparse
import os
import subprocess
import sys
import urllib.error
import urllib.request

# (local filename saved into --raw-dir, source URL, human-readable source name)
# The HPO files use GitHub's "latest/download" alias, which always resolves
# to whichever release is currently tagged latest -- no version-tag tracking
# needed here, unlike the plain per-tag download URLs.
HPO_RELEASE_BASE = "https://github.com/obophenotype/human-phenotype-ontology/releases/latest/download"
MONDO_MAPPINGS_BASE = "https://raw.githubusercontent.com/monarch-initiative/mondo/master/src/ontology/mappings"

REQUIRED_SOURCES = [
    ("hp.json", f"{HPO_RELEASE_BASE}/hp.json", "HPO ontology (obographs JSON)"),
    ("phenotype.hpoa", f"{HPO_RELEASE_BASE}/phenotype.hpoa", "HPO disease annotations"),
    ("genes_to_disease.txt", f"{HPO_RELEASE_BASE}/genes_to_disease.txt", "HPO gene-disease associations"),
    (
        "hgnc_complete_set.tsv",
        "https://storage.googleapis.com/public-download-files/hgnc/tsv/tsv/hgnc_complete_set.txt",
        "HGNC complete gene set",
    ),
]

OPTIONAL_SOURCES = [
    (
        "mondo_exactmatch_omim.sssom.tsv",
        f"{MONDO_MAPPINGS_BASE}/mondo_exactmatch_omim.sssom.tsv",
        "Mondo -> OMIM exact-match crosswalk",
    ),
    (
        "mondo.sssom.tsv",
        f"{MONDO_MAPPINGS_BASE}/mondo.sssom.tsv",
        "Mondo's full mapping set (Orphanet exact-match subset is used)",
    ),
]

# These cannot be fetched from a stable URL (see module docstring). Listed
# here only so the "what's missing" summary at the end can mention them by
# the same glob prefix build_db.py looks for.
MANUAL_ONLY = [
    ("Clingen-Gene-Disease-Summary*.csv", "ClinGen gene-disease validity curations"),
    ("Clingen-Curation-Activity-Summary*.csv", "ClinGen dosage sensitivity + actionability"),
]

USER_AGENT = "HPOGraph-update-data-script/1.0 (+https://github.com/aardes/hpograph)"


def download(url, dest_path):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest_path, "wb") as f:
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)


def fetch_all(raw_dir, sources, required):
    ok = True
    for fname, url, label in sources:
        dest = os.path.join(raw_dir, fname)
        print(f"Downloading {label} ...")
        print(f"  {url}")
        try:
            download(url, dest)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            kind = "ERROR" if required else "skipped (optional)"
            print(f"  {kind}: {e}")
            if os.path.exists(dest):
                os.remove(dest)  # don't leave a truncated/partial file behind
            if required:
                ok = False
            continue
        size_mb = os.path.getsize(dest) / (1024 * 1024)
        print(f"  saved to {dest} ({size_mb:.1f} MB)")
    return ok


def has_clingen_file(raw_dir, prefix):
    if not os.path.isdir(raw_dir):
        return False
    return any(f.startswith(prefix) and f.endswith(".csv") for f in os.listdir(raw_dir))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw-dir", default="raw_data", help="folder to download source files into (default: raw_data)")
    ap.add_argument("--out", default="data/hpo.db", help="compiled database path (default: data/hpo.db)")
    ap.add_argument("--skip-download", action="store_true", help="reuse whatever is already in --raw-dir instead of downloading")
    args = ap.parse_args()

    os.makedirs(args.raw_dir, exist_ok=True)

    if not args.skip_download:
        print(f"== Downloading required source files into {args.raw_dir}/ ==")
        required_ok = fetch_all(args.raw_dir, REQUIRED_SOURCES, required=True)
        print()
        print(f"== Downloading optional Mondo crosswalk files into {args.raw_dir}/ ==")
        fetch_all(args.raw_dir, OPTIONAL_SOURCES, required=False)
        print()
        if not required_ok:
            print("One or more REQUIRED source files failed to download -- aborting before build.")
            print("(Required: HPO ontology/annotations/gene-disease file, HGNC complete set.)")
            sys.exit(1)
    else:
        print(f"Skipping downloads, using existing files in {args.raw_dir}/ as-is.")
        print()

    print("== ClinGen gene-disease validity + dosage/actionability (manual, optional) ==")
    for prefix, label in MANUAL_ONLY:
        found = has_clingen_file(args.raw_dir, prefix.split("*")[0])
        if found:
            print(f"  found: {label} ({prefix}) already present in {args.raw_dir}/")
        else:
            print(f"  missing: {label} ({prefix})")
    if not (has_clingen_file(args.raw_dir, "Clingen-Gene-Disease-Summary") and has_clingen_file(args.raw_dir, "Clingen-Curation-Activity-Summary")):
        print(
            "  ClinGen does not publish these as a stable, script-fetchable URL "
            "(their downloads page generates a date-stamped export interactively). "
            "To include fresh ClinGen data in this build, download the two summary "
            "CSVs yourself from https://search.clinicalgenome.org/kb/downloads and "
            f"place them in {args.raw_dir}/ before re-running with --skip-download. "
            "The build proceeds without them either way -- the app just won't show "
            "ClinGen data in that case."
        )
    print()

    print(f"== Building database: {args.out} ==")
    build_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build_db.py")
    result = subprocess.run([sys.executable, build_script, "--raw-dir", args.raw_dir, "--out", args.out])
    if result.returncode != 0:
        print("build_db.py failed -- see output above.")
        sys.exit(result.returncode)

    print()
    print("Done. Next steps:")
    print(f"  1. Sanity-check with: python3 scripts/smoke_check.py")
    print(f"  2. Commit the compiled database: git add {args.out}.gz")
    print("     (the plain .db file is gitignored and must never be committed -- ")
    print("     only the .gz that build_db.py writes alongside it)")
    print("  3. git commit && git push -- Cloudflare redeploys the new data automatically.")


if __name__ == "__main__":
    main()
