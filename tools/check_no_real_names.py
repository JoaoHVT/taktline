"""Fail if anything from the source project survived into this repository.

Two passes: every tracked text file, and every string value in the seeded database. The list is
a DENYLIST rather than a name-shape allowlist, because the failure being guarded against is a
real value slipping through, not a generated one being spelled unexpectedly.

    python tools/check_no_real_names.py        # exit 1 on any hit

Adding a term is cheap and adding one late is not: run this before every publish.
"""
from __future__ import annotations

import re
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED_DB = ROOT / "backend" / "data" / "demo.sqlite"

# Case-insensitive terms, each matched on WORD BOUNDARIES. Substring matching was tried first
# and is unusable: "gcm" fires on AES-256-GCM and ".local" on every localeCompare, which buries
# the real hits under noise and trains the reader to skip the report. Grouped by what leaks.
DENY = {
    "employer / product": [
        "wabtec", "getsa", "denodo", "optvision", "masterplanner",
    ],
    "locomotive models": [
        "es44", "es43", "es58", "ac44", "ac45", "sd70", "bbwi", "bbi43",
    ],
    "internal org codes": [
        "gcm", "gcr",
    ],
    "people / accounts": [
        "joao.voss", "joaohvteixeira",
    ],
    # The previous identity provider. No code here uses it; what these words would leak is the
    # employer's authentication stack, in comments describing a migration this repo never had.
    "identity provider": [
        # "entra" alone is the Portuguese verb; only the product name is a leak.
        "azure", "entra id", "microsoft entra", "msal", "okta", "adfs",
    ],
    "infrastructure": [
        # NOT bare "railway": this app schedules locomotives and the word is ordinary here.
        "supabase", "railway.app", "vercel", "microsoftonline",
        "onedrive", "horasb3", "capb3356103",
    ],
}

# Built once: each term as a boundary-anchored, case-insensitive pattern. The org codes also
# refuse a neighbouring hyphen, so the cipher name AES-256-GCM does not read as the org GCM —
# the two are three letters apart and only the punctuation tells them apart.
def _rx(term: str, group: str) -> "re.Pattern[str]":
    edge = "[A-Za-z0-9-]" if group == "internal org codes" else "[A-Za-z0-9]"
    return re.compile(f"(?<!{edge})" + re.escape(term) + f"(?!{edge})", re.I)


DENY_RX = {
    group: [(t, _rx(t, group)) for t in terms]
    for group, terms in DENY.items()
}

# Part-number shapes the source project used. A generated PN is "PN-0001"; anything matching
# these is a transcription.
DENY_RE = [
    re.compile(r"\b5G\d{4,}\b"),          # supplier part numbers
    re.compile(r"\bES\s*4[34]\b", re.I),  # model code with any spacing
]

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".next", "venv", "dist", "build"}
TEXT_EXT = {".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".yml", ".yaml",
            ".css", ".html", ".txt", ".toml", ".cfg"}
# Files matched by NAME, not by extension. `.env.example` was in the list above and never
# matched anything: Path(".env.example").suffix is ".example", so both template files were
# skipped silently for every run — and they were the files still naming the source project's
# database host, its identity provider and a real username. A denylist that quietly skips
# files is worse than no denylist, because it reports zero.
TEXT_NAMES = {".env.example", "Dockerfile", ".dockerignore", ".gitignore", ".gitattributes"}
# This file names every forbidden term by definition.
SELF = Path(__file__).resolve()


def tracked_files() -> list[Path]:
    try:
        out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True,
                             text=True, check=True).stdout
        return [ROOT / line for line in out.splitlines() if line]
    except (subprocess.CalledProcessError, FileNotFoundError):
        return [p for p in ROOT.rglob("*") if not SKIP_DIRS & set(p.parts)]


def scan_text() -> list[str]:
    hits: list[str] = []
    for path in tracked_files():
        if path.resolve() == SELF or not path.is_file():
            continue
        if path.suffix not in TEXT_EXT and path.name not in TEXT_NAMES:
            continue
        try:
            body = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = path.relative_to(ROOT)
        for lineno, line in enumerate(body.splitlines(), 1):
            for group, terms in DENY_RX.items():
                for term, rx in terms:
                    if rx.search(line):
                        hits.append(f"{rel}:{lineno}  [{group}] {term!r}  {line.strip()[:90]}")
            for rx in DENY_RE:
                if rx.search(line):
                    hits.append(f"{rel}:{lineno}  [shape] {rx.pattern}  {line.strip()[:90]}")
    return hits


def scan_db() -> list[str]:
    if not SEED_DB.is_file():
        return [f"{SEED_DB.relative_to(ROOT)} não existe — rode tools/seed_demo_db.py"]
    hits: list[str] = []
    terms = [(t, rx) for group in DENY_RX.values() for t, rx in group]
    with sqlite3.connect(f"file:{SEED_DB}?mode=ro", uri=True) as con:
        tables = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")]
        for table in tables:
            cols = [r[1] for r in con.execute(f'PRAGMA table_info("{table}")')]
            for row in con.execute(f'SELECT * FROM "{table}"'):
                for col, val in zip(cols, row):
                    if not isinstance(val, str):
                        continue
                    for term, rx in terms:
                        if rx.search(val):
                            hits.append(f"{table}.{col}  {term!r}  {val[:80]}")
                    for rx in DENY_RE:
                        if rx.search(val):
                            hits.append(f"{table}.{col}  {rx.pattern}  {val[:80]}")
    return hits


def main() -> int:
    # The report quotes source lines, which carry accents this console may not encode.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    text_hits = scan_text()
    db_hits = scan_db()
    for h in text_hits:
        print("TEXT  " + h)
    for h in db_hits:
        print("DB    " + h)
    total = len(text_hits) + len(db_hits)
    print(f"\n{total} ocorrência(s).")
    return 1 if total else 0


if __name__ == "__main__":
    raise SystemExit(main())
