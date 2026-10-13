#!/usr/bin/env python3
"""Report mid-sentence line breaks in the agent-facing markdown this repo owns.

One question, one exit code: does any in-scope markdown file break a prose line
before its sentence ends? A paragraph whose line ends before the sentence does is
invisible once rendered and permanent in the source, so every agent that reads
the file copies its shape and the wrap spreads. This gate is what makes the rule
in AGENTS.md -> Writing style enforceable rather than advisory.

Usage:
  scripts/check-prose-wraps.py

Exit codes:
  0  no in-scope file carries a mid-sentence break
  1  at least one does; each hit prints as path:line so this output IS the worklist
  2  the gate could not run (no git, not a working tree, or a scope prefix that
     matched no tracked path: a scope that rots must not pass vacuously)

Scope. The agent-facing surfaces the writing-style rule governs, and nothing
else: every tracked AGENTS.md, the root README.md, INTENT.md and CONTEXT.md,
.agents/**, docs/**, and .github/PULL_REQUEST_TEMPLATE.md. Human-facing or
generated markdown elsewhere (test fixtures, generated outputs) stays out.

Detector contract, pinned because the check, the normalization worklist, and
any reviewer must read the same boundaries. A block is the lines between blank
lines. It is skipped when it holds a line starting `|` or `#`, or when more
than half its lines are bullets. Within a scanned block, a break is a line of
45+ characters that ends without terminal punctuation (. ! ? : ; ) ] ` * " ')
and whose successor starts with a lowercase letter or `(`. One hit per block,
because joining the paragraph clears every break in it. Code never counts, and
neither does a leading YAML frontmatter block: the writing-style rule excludes
both, and `description: >-` folds its own line breaks, so joining one would
rewrite configuration rather than style.

Where code begins and ends is markdown-it's answer, not this script's.
Container ancestry, optional opener indentation and quoted markers are a block
parser's job, so this asks one. `python3-markdown-it` on Debian and Ubuntu, or
markdown-it-py from pip, is the one dependency; main() fails with both
instructions when it is missing.
"""

import re
import subprocess
import sys
from pathlib import Path

try:
    from markdown_it import MarkdownIt

    PARSER = MarkdownIt("commonmark")
except ImportError:  # the preflight in main() explains what to install
    PARSER = None

IN_SCOPE_PREFIXES = (
    ".agents/",
    "docs/",
)

IN_SCOPE_FILES = (
    "README.md",
    "INTENT.md",
    "CONTEXT.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
)

AGENTS_BASENAME = "AGENTS.md"

TERMINAL_PUNCTUATION = re.compile(r"""[.!?:;)\]`*"']\s*$""")
CONTINUATION = re.compile(r"^[a-z(]")
MIN_WRAPPED_LENGTH = 45

FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n.*?\r?\n---[ \t]*\r?\n", re.S)

EXCERPT_LIMIT = 120


def warn(message):
    print(f"check-prose-wraps: {message}", file=sys.stderr)


def gate_error(message):
    warn(message)
    return 2


def git_root():
    """The working tree this gate runs in, or None when there is none."""
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def tracked_markdown_paths(root):
    """Every tracked .md path, relative to the tree root, or None on a git fault.

    Tracked only: an untracked scratch file is nobody's style rule. `-z` and
    core.quotePath=false keep a path with a newline or a non-ASCII byte exactly
    the path it is, instead of a git-quoted string that matches nothing.
    """
    result = subprocess.run(
        ["git", "-C", root, "-c", "core.quotePath=false", "ls-files", "-z"],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    decoded = result.stdout.decode("utf-8", errors="surrogateescape")
    return [path for path in decoded.split("\0") if path.endswith(".md")]


def in_scope(path):
    if Path(path).name == AGENTS_BASENAME:
        return True
    return path.startswith(IN_SCOPE_PREFIXES) or path in IN_SCOPE_FILES


def collect(root, paths):
    """[(path, line_number, line_text)] for every mid-sentence break, in file order."""
    hits = []
    for path in paths:
        try:
            text = (Path(root) / path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            warn(f"cannot read {path}: {error}")
            return None
        text = blank_code_blocks(blank_leading_frontmatter(text))
        for block in paragraph_blocks(text):
            hit = first_break(block)
            if hit is not None:
                hits.append((path, *hit))
    return hits


def blank_leading_frontmatter(text):
    """Blank a leading ---...--- YAML block so every line number stays put.

    Frontmatter is configuration, not prose, and `description: >-` folds its own
    line breaks: joining one would rewrite behaviour rather than style. Blanked
    rather than removed, because the hits this gate prints are line numbers in
    the file as committed.
    """
    match = FRONTMATTER.match(text)
    if match is None:
        return text
    return re.sub(r"[^\n]", "", match.group(0)) + text[match.end() :]


def blank_code_blocks(text):
    """Blank markdown-it's code blocks so every line number stays put.

    markdown-it says where code starts and ends, which is the whole point: it
    resolves containers, fence characters and lengths, and optional indentation
    the way a renderer does, so code never reaches prose detection and prose
    outside a code boundary is always scanned. Both fence tokens and indented
    code blocks (`code_block`) count.

    Blanked rather than removed, because the hits this gate prints are line
    numbers in the file as committed.
    """
    lines = text.splitlines(keepends=True)
    for token in PARSER.parse(text):
        if token.type not in ("fence", "code_block") or not token.map:
            continue
        start, end = token.map
        for index in range(start, min(end, len(lines))):
            lines[index] = "\n" if lines[index].endswith("\n") else ""
    return "".join(lines)


def paragraph_blocks(text):
    """Blank-line-separated blocks as [(line_number, line)] lists."""
    blocks = []
    current = []
    for number, line in enumerate(text.splitlines(), start=1):
        if line.strip():
            current.append((number, line))
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    return blocks


def is_prose(block):
    """False for tables, headings, and blocks whose lines are mostly bullets."""
    lines = [line.rstrip() for _, line in block]
    if len(lines) < 2:
        return False
    if any(line.lstrip().startswith(("|", "#")) for line in lines):
        return False
    bullets = sum(1 for line in lines if line.lstrip().startswith(("- ", "* ")))
    return bullets <= len(lines) / 2


def first_break(block):
    """(line_number, line_text) of the block's first mid-sentence break, else None."""
    if not is_prose(block):
        return None
    lines = [(number, line.rstrip()) for number, line in block]
    for (number, line), (_, following) in zip(lines, lines[1:]):
        if (
            len(line) >= MIN_WRAPPED_LENGTH
            and not TERMINAL_PUNCTUATION.search(line)
            and CONTINUATION.match(following.lstrip())
        ):
            return number, line
    return None


def excerpt(line):
    if len(line) <= EXCERPT_LIMIT:
        return line
    return line[:EXCERPT_LIMIT] + "…"


def report(hits, scanned):
    for path, number, line in hits:
        print(f"{path}:{number}: {excerpt(line)}")
    if not hits:
        print(f"check-prose-wraps: 0 mid-sentence breaks in {scanned} in-scope file(s).")
        return
    files = len({path for path, _, _ in hits})
    print(
        f"check-prose-wraps: {len(hits)} mid-sentence break(s) in {files} of {scanned} "
        "in-scope file(s). Keep each paragraph on one line; see AGENTS.md -> Writing style."
    )


def main():
    if PARSER is None:
        return gate_error(
            "markdown-it-py is required to find code blocks. On Debian or Ubuntu: "
            "sudo apt-get install -y python3-markdown-it. Elsewhere: "
            "python3 -m pip install markdown-it-py."
        )

    root = git_root()
    if root is None:
        return gate_error("not inside a git working tree; run from the repository checkout.")

    paths = tracked_markdown_paths(root)
    if paths is None:
        return gate_error(f"git ls-files failed in {root}.")

    rotted = [
        prefix
        for prefix in IN_SCOPE_PREFIXES
        if not any(path.startswith(prefix) for path in paths)
    ]
    if rotted:
        return gate_error(
            "scope prefix(es) matched no tracked markdown: "
            + ", ".join(rotted)
            + ". Update the prefix lists in this script; a scope that matches nothing "
            "certifies nothing."
        )

    scope = [path for path in paths if in_scope(path)]
    hits = collect(root, scope)
    if hits is None:
        return 2

    report(hits, len(scope))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
