#!/usr/bin/env python3
"""Does .agents/lessons/LEDGER.tsv agree with its own contract and with the tracked tree?

The ledger is the lesson process's dedup index: one row per source item that
produced or rejected a lesson. Its key format and column set are defined HERE,
not in prose, so a row written by hand cannot drift from what the checker reads.

Rules, one line per violation:
  1. The header is exactly: source_id origin first_seen disposition target note
  2. Every row has exactly six tab-separated columns.
  3. source_id is unique and matches one of
       mem:<agent>:<memory filename>.md     a coding agent's persistent memory
                                            file (<agent> is a lowercase slug)
       ci:<12 lowercase hex>:<n>            a failure cause seen on n CI runs on
                                            main
       pr:<pr number>:<finding id>          one PR review finding, judged once
       hand:<12 lowercase hex>              a lesson written from one session; the
                                            hex hashes the lesson text, so the
                                            same trap recorded twice collides
                                            on source_id
     For ci the 12-hex anchor is the cause's identity and n names one judgment
     of it. The ledger is append-only, so when a judged cause fails again the
     next row carries n+1; every row of one cause shares the ci:<anchor>: prefix.
  4. first_seen is an ISO 8601 UTC timestamp, YYYY-MM-DDTHH:MM:SSZ.
  5. disposition is one of skill, agents_md, lesson, check, discard.
  6. A non-discard row's target is a path tracked in this repository, or for a
     check row a GitHub issue URL in Akuja-Inc/taskfast-agent-starter.

Usage:
  scripts/check-lessons-ledger.py [path]      default .agents/lessons/LEDGER.tsv

Exit codes:
  0  every row agrees with the contract
  1  at least one does not; each violation prints as path:line: message
  2  the gate could not run (file missing, or not a git working tree)
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

HEADER = ["source_id", "origin", "first_seen", "disposition", "target", "note"]
DISPOSITIONS = {"skill", "agents_md", "lesson", "check", "discard"}
SOURCE_ID = re.compile(r"^(mem:[a-z][a-z0-9-]*:[^\s/\t]+\.md"
                       r"|ci:[0-9a-f]{12}:[1-9]\d*"
                       r"|pr:\d+:[A-Za-z0-9-]+"
                       r"|hand:[0-9a-f]{12})$")
FIRST_SEEN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
ISSUE_URL = re.compile(
    r"^https://github\.com/Akuja-Inc/taskfast-agent-starter/issues/\d+$"
)


def tracked_paths() -> set[str] | None:
    try:
        out = subprocess.run(["git", "-c", "core.quotePath=false", "ls-files", "-z"],
                             capture_output=True, text=True, check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return {p for p in out.split("\0") if p}


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path(".agents/lessons/LEDGER.tsv")
    if not path.is_file():
        print(f"check-lessons-ledger: {path} is missing", file=sys.stderr)
        return 2
    tracked = tracked_paths()
    if tracked is None:
        print("check-lessons-ledger: not a git working tree", file=sys.stderr)
        return 2

    lines = path.read_text(encoding="utf-8").splitlines()
    bad = 0

    def fail(lineno: int, msg: str) -> None:
        nonlocal bad
        bad += 1
        print(f"{path}:{lineno}: {msg}")

    if not lines or lines[0].split("\t") != HEADER:
        fail(1, "header must be exactly: " + "\t".join(HEADER).replace("\t", " "))
        return 1

    seen: dict[str, int] = {}
    for lineno, line in enumerate(lines[1:], start=2):
        if not line.strip():
            fail(lineno, "blank line; the ledger has no blank rows")
            continue
        cols = line.split("\t")
        if len(cols) != len(HEADER):
            fail(lineno, f"{len(cols)} columns, expected {len(HEADER)}")
            continue
        source_id, _origin, first_seen, disposition, target, _note = cols
        if not SOURCE_ID.match(source_id):
            fail(lineno, f"source_id {source_id!r} matches no key format in rule 3 of this checker's docstring")
        if source_id in seen:
            fail(lineno, f"source_id {source_id!r} already recorded on line {seen[source_id]}")
        else:
            seen[source_id] = lineno
        if not FIRST_SEEN.match(first_seen):
            fail(lineno, f"first_seen {first_seen!r} is not YYYY-MM-DDTHH:MM:SSZ")
        if disposition not in DISPOSITIONS:
            fail(lineno, f"disposition {disposition!r} is not one of {', '.join(sorted(DISPOSITIONS))}")
            continue
        if disposition == "discard":
            continue
        if disposition == "check" and ISSUE_URL.match(target):
            continue
        if target not in tracked:
            what = "a tracked path or an Akuja-Inc/taskfast-agent-starter issue URL" if disposition == "check" else "a tracked path"
            fail(lineno, f"target {target!r} is not {what}")

    if bad:
        return 1
    print(f"check-lessons-ledger: {len(seen)} row(s) agree with the contract.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
