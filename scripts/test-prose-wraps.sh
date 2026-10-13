#!/usr/bin/env bash
set -euo pipefail

# Regression test for scripts/check-prose-wraps.py.
#
# Three parts, because the gate can be wrong in three ways:
#
#   1. Behaviour. Throwaway git repos assert one exit code per markdown shape:
#      a wrapped paragraph fires, and fenced code, tables, bullet-majority
#      blocks, YAML frontmatter, short lines, terminal punctuation and
#      out-of-scope paths do not. Every skip case carries a shape that WOULD
#      fire if its skip rule were dropped, so each one is a positive control
#      rather than a file that could never fire.
#
#   2. Vacuity. The gate exits 2 when a scope prefix matches no tracked
#      markdown, because a scope that rotted to nothing certifies nothing. One
#      case removes a whole in-scope directory and asserts that exit.
#
#   3. The real tree. The repository itself must report zero breaks, and the
#      run must exit 0 rather than 2: the prefix guard is what makes that a
#      statement about a non-empty scope rather than about an empty worklist.
#
# Exits non-zero on the first-class failure of any part.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/check-prose-wraps.py"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLEANUP_ATTEMPTS=5
failures=0

fail() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}

show() {
  # Echo the captured gate run on every failure path: the log is the only
  # window into runner-specific breakage.
  printf '%s\n' "$1" | sed 's/^/  gate: /'
}

preflight() {
  local missing=""
  for tool in python3 git; do
    command -v "$tool" >/dev/null 2>&1 || missing="${missing:+$missing }$tool"
  done
  if ! python3 -c "import markdown_it" >/dev/null 2>&1; then
    missing="${missing:+$missing }markdown_it"
  fi
  if [[ -n "$missing" ]]; then
    echo "test-prose-wraps: missing tool(s): $missing" >&2
    echo "Install them and re-run: sudo apt-get install -y python3-markdown-it, or python3 -m pip install markdown-it-py." >&2
    echo "This self-test drives the gate through real git repositories." >&2
    exit 2
  fi
}

cleanup_fixture() {
  local dir="$1" attempt
  for ((attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt++)); do
    if rm -rf "$dir" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "cleanup_fixture: '$dir' survived $CLEANUP_ATTEMPTS cleanup attempts; remaining paths:" >&2
  if [[ -e "$dir" ]]; then
    find "$dir" -mindepth 1 2>/dev/null | sort | sed 's/^/  /' >&2
  fi
  return 1
}

# setup_repo echoes a fresh repo whose baseline already carries one clean file
# for every scope prefix and named path. The gate exits 2 when a prefix matches
# nothing, so a case that only wants to add one wrapped file still needs the
# rest of the scope present; that constraint is the vacuity guard working.
setup_repo() {
  local dir
  dir="$(mktemp -d)"
  (
    cd "$dir"
    # Force `main`: the runner's init.defaultBranch may be `master`, and the
    # fixture must never touch machine-wide configuration.
    git init --quiet -b main
    git config user.email t@t.test
    git config user.name test
    git config commit.gpgsign false
    git config gc.auto 0
    git config maintenance.auto false
    scaffold
    git add -A
    git commit --quiet -m baseline
  )
  echo "$dir"
}

scaffold() {
  local clean='A clean paragraph sits on one line and ends with a full stop.
'
  mkdir -p .agents/lessons .agents/skills/seed docs .github
  printf '%s' "$clean" >AGENTS.md
  for path in \
    README.md \
    INTENT.md \
    CONTEXT.md \
    .github/PULL_REQUEST_TEMPLATE.md \
    .agents/lessons/seed.md \
    .agents/skills/seed/SKILL.md \
    docs/seed.md; do
    printf '%s' "$clean" >"$path"
  done
}

commit_all() { git add -A && git commit --quiet -m "$1"; }

# run_case <name> <expected-exit> <mutation-fn> [expected-output-substring ...]
run_case() {
  local name="$1" expected="$2" mutate="$3"
  shift 3
  local dir actual output failures_before want
  dir="$(setup_repo)"
  (cd "$dir" && "$mutate")
  set +e
  output="$(cd "$dir" && python3 "$GATE" 2>&1)"
  actual=$?
  set -e
  failures_before=$failures
  if [[ "$actual" -ne "$expected" ]]; then
    fail "$name expected exit $expected, got $actual"
    show "$output"
  else
    for want in "$@"; do
      if [[ "$output" != *"$want"* ]]; then
        fail "$name expected output to name '$want'"
        show "$output"
        break
      fi
    done
  fi
  if ! cleanup_fixture "$dir"; then
    fail "$name fixture cleanup failed ($dir)"
  fi
  if [[ "$failures" -eq "$failures_before" ]]; then
    echo "PASS: $name (exit $actual)"
  fi
}

# --- cases -----------------------------------------------------------------

clean_scaffold() { :; }

wrapped_agents_md() {
  cat >AGENTS.md <<'EOF'
# House style

A paragraph that opens on one line and keeps the sentence going
onto the next line, which is the shape this gate exists to catch.
EOF
  commit_all wrap
}

wrapped_readme() {
  cat >README.md <<'EOF'
# Starter

A README paragraph that breaks a sentence across two lines exactly
like this, which the gate must report by name.
EOF
  commit_all wrap
}

wrapped_skill() {
  mkdir -p .agents/skills/demo
  cat >.agents/skills/demo/SKILL.md <<'EOF'
# Demo

A skill body that breaks a sentence across two lines exactly
like this, which is what the wrap detector reports.
EOF
  commit_all wrap
}

wrapped_template() {
  cat >.github/PULL_REQUEST_TEMPLATE.md <<'EOF'
## Summary

A pull request template paragraph that wraps mid sentence here
and continues, so the gate must name the template file.
EOF
  commit_all wrap
}

wrapped_in_two_files() {
  cat >docs/notes.md <<'EOF'
# Notes

A wrapped sentence starts in one in-scope file here and
continues, so the report must name docs/notes.md.
EOF
  cat >INTENT.md <<'EOF'
# Intent

A second in-scope file wraps its sentence here and
continues, so the report must name it too.
EOF
  commit_all wrap
}

fenced_code() {
  cat >AGENTS.md <<'EOF'
# House style

```sh
echo a fenced line long enough to pass the length threshold and then some
next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
```

One clean trailing paragraph.
EOF
  commit_all fence
}

tilde_fence() {
  cat >AGENTS.md <<'EOF'
# House style

~~~sh
echo a tilde-fenced line long enough to pass the length threshold here
next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
~~~

One clean trailing paragraph.
EOF
  commit_all tilde
}

nested_fence() {
  cat >AGENTS.md <<'EOF'
# House style

````md
```sh
echo a nested-fence line long enough to pass the length threshold here
next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
```
````

One clean trailing paragraph.
EOF
  commit_all nested
}

list_indented_fence() {
  cat >AGENTS.md <<'EOF'
# House style

1. An example:

    ```sh
    echo a fenced line long enough to pass the length threshold and then some
    next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
    ```

One clean trailing paragraph.
EOF
  commit_all list-fence
}

blockquote_fence() {
  cat >AGENTS.md <<'EOF'
# House style

> ```sh
> echo a quoted fence line long enough to pass the length threshold here
> next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
> ```

One clean trailing paragraph.
EOF
  commit_all quote-fence
}

shorter_closer() {
  cat >AGENTS.md <<'EOF'
# House style

````
echo a fence line long enough to pass the length threshold and then some
next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
```
another fenced line long enough to pass the length threshold here
still_inside_the_same_block_so_it_must_not_fire
````

One clean trailing paragraph.
EOF
  commit_all shorter-closer
}

prose_after_fence() {
  cat >AGENTS.md <<'EOF'
# House style

```sh
echo a fenced line long enough to pass the length threshold and then some
next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
```

A paragraph after the closing fence that wraps mid sentence here
and must be reported.
EOF
  commit_all after-fence
}

inline_code_span() {
  cat >AGENTS.md <<'EOF'
# House style

`openMarketplaceAgent(AgentOptions)` returns an open agent store plus tasks and
metadata that continues here, so the paragraph must still be reported.
EOF
  commit_all inline-span
}

quoted_literal_in_code() {
  cat >AGENTS.md <<'EOF'
# House style

```
> ```
echo a code line long enough to pass the length threshold and then some
next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
```

One clean trailing paragraph.
EOF
  commit_all quoted-literal
}

blockquote_fence_exit() {
  cat >AGENTS.md <<'EOF'
# House style

> ```sh
> echo a quoted fence line long enough to pass the length threshold here

A paragraph after the blockquote ends that wraps mid sentence here
and must be reported.
EOF
  commit_all quote-exit
}

list_marker_fence() {
  cat >AGENTS.md <<'EOF'
# House style

- ```sh
  echo a list-marker fence line long enough to pass the threshold here
  next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
  ```

One clean trailing paragraph.
EOF
  commit_all list-marker
}

nested_container_fence() {
  cat >AGENTS.md <<'EOF'
# House style

1. An example:

    > ```sh
    > echo a nested fence line long enough to pass the threshold here
    > next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
    > ```

One clean trailing paragraph.
EOF
  commit_all nested-containers
}

list_fence_exit() {
  cat >AGENTS.md <<'EOF'
# House style

1. An example:

    ```sh
    echo a fenced line long enough to pass the length threshold and then some
    next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned

A paragraph after the list ends that wraps mid sentence here
and must be reported.
EOF
  commit_all list-exit
}

indented_opener_top_level() {
  cat >AGENTS.md <<'EOF'
# House style

  ```sh
echo ok
```

A paragraph after the closing fence that wraps mid sentence here
and must be reported.
EOF
  commit_all indented-opener
}

dedented_code_content() {
  cat >AGENTS.md <<'EOF'
# House style

  ```sh
echo a code line long enough to pass the length threshold and then some
next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
  ```

One clean trailing paragraph.
EOF
  commit_all dedented-content
}

independently_indented_closer() {
  cat >AGENTS.md <<'EOF'
# House style

```
echo a code line long enough to pass the length threshold and then some
next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
  ```

One clean trailing paragraph.
EOF
  commit_all indented-closer
}

two_space_list_fence_exit() {
  cat >AGENTS.md <<'EOF'
# House style

- Example:

  ```sh
  echo ok

A paragraph after the list ends that wraps mid sentence here
and must be reported.
EOF
  commit_all two-space-exit
}

three_space_list_fence() {
  cat >AGENTS.md <<'EOF'
# House style

1. Example:

   ```sh
   echo a fenced line long enough to pass the length threshold and then some
   next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
   ```

One clean trailing paragraph.
EOF
  commit_all three-space-list
}

quoted_list_fence_exit() {
  cat >AGENTS.md <<'EOF'
# House style

> - Example.

   ```sh
echo a fenced line long enough to pass the length threshold and then some
next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
```

A paragraph after the closing fence that wraps mid sentence here
and must be reported.
EOF
  commit_all quoted-list-exit
}

list_fence_inside_quote_exit() {
  cat >AGENTS.md <<'EOF'
# House style

> - Example.
>
>   ```sh
>   echo a fenced line long enough to pass the length threshold and then some
>   next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
>   ```

A paragraph after the quote ends that wraps mid sentence here
and must be reported.
EOF
  commit_all quote-list-exit
}

list_then_quote_then_fence() {
  cat >AGENTS.md <<'EOF'
# House style

- Example.

>   A separate blockquote.

   ```sh
echo a fenced line long enough to pass the length threshold and then some
next_fenced_line_starts_lowercase_so_it_would_fire_if_scanned
```

A paragraph after the closing fence that wraps mid sentence here
and must be reported.
EOF
  commit_all list-quote-fence
}

table_rows() {
  cat >AGENTS.md <<'EOF'
# House style

| column | another column whose heading is deliberately long |
| --- | --- |
| value | a cell whose contents also run well past the limit |
EOF
  commit_all table
}

bullet_list() {
  cat >AGENTS.md <<'EOF'
# House style

- The first bullet runs long enough to pass the threshold and continues
  onto an indented continuation line that starts lowercase.
- The second bullet fits.
- The third bullet fits.
EOF
  commit_all bullets
}

frontmatter_description() {
  cat >.agents/skills/seed/SKILL.md <<'EOF'
---
name: seed
description: >-
  A block scalar that runs long enough to pass the length threshold and continues
  onto another line, which is how YAML frontmatter is written.
---

One clean body paragraph.
EOF
  commit_all frontmatter
}

terminal_punctuation_and_short_lines() {
  cat >AGENTS.md <<'EOF'
# House style

A line that ends at a colon and is long enough to be a prefix:
lowercase continuation that must not fire.
A line that ends inside a code span `like this`
lowercase continuation that must not fire either.
A line that ends with a parenthesised clause (like this)
lowercase continuation that must not fire as well.
Short line
lowercase continuation under a line below the threshold.
EOF
  commit_all punctuation
}

out_of_scope_doc() {
  cat >CHANGELOG.md <<'EOF'
# Changelog

A root markdown file outside the four named ones wraps mid sentence
like this and stays out of the gate's scope by design.
EOF
  commit_all changelog
}

fixture_readme() {
  mkdir -p test/fixtures/cli
  cat >test/fixtures/cli/README.md <<'EOF'
# CLI captures

A captured fixture's README wraps mid sentence exactly like this
and continues, out of the gate's scope by design.
EOF
  commit_all fixture-readme
}

rotted_scope_prefix() {
  rm -rf docs
  mkdir -p other-docs
  printf 'a note\n' >other-docs/note.md
  commit_all remove
}

preflight

echo "--- behaviour ---"
run_case "clean prose does not fire" 0 clean_scaffold
run_case "a wrapped AGENTS.md paragraph fires" 1 wrapped_agents_md "AGENTS.md:3:"
run_case "a wrapped README.md paragraph fires" 1 wrapped_readme "README.md:3:"
run_case "a wrapped pull request template fires" 1 wrapped_template ".github/PULL_REQUEST_TEMPLATE.md:3:"
run_case "a wrapped skill under .agents/skills fires" 1 wrapped_skill ".agents/skills/demo/SKILL.md:3:"
run_case "every wrapped file is named" 1 wrapped_in_two_files \
  "docs/notes.md:3:" "INTENT.md:3:"
run_case "a fenced code block does not fire" 0 fenced_code
run_case "a tilde fence does not fire" 0 tilde_fence
run_case "a longer fence around a shorter one does not fire" 0 nested_fence
run_case "a fence indented inside a list item does not fire" 0 list_indented_fence
run_case "a fence inside a blockquote does not fire" 0 blockquote_fence
run_case "a shorter closer does not end the block" 0 shorter_closer
run_case "prose after a closing fence still fires" 1 prose_after_fence "AGENTS.md:8:"
run_case "an inline code span does not open a fence" 1 inline_code_span "AGENTS.md:3:"
run_case "a quoted fence line inside code does not close it" 0 quoted_literal_in_code
run_case "prose after a blockquote fence exit still fires" 1 blockquote_fence_exit "AGENTS.md:6:"
run_case "a list-marker opener does not fire" 0 list_marker_fence
run_case "a fence in a nested container does not fire" 0 nested_container_fence
run_case "prose after a list fence exit still fires" 1 list_fence_exit "AGENTS.md:9:"
run_case "an indented opener keeps scanning prose after its closer" 1 indented_opener_top_level "AGENTS.md:7:"
run_case "dedented code inside an indented fence does not fire" 0 dedented_code_content
run_case "an independently indented closer does not fire" 0 independently_indented_closer
run_case "prose after a two-space list fence exit still fires" 1 two_space_list_fence_exit "AGENTS.md:8:"
run_case "a fence at a three-space list column does not fire" 0 three_space_list_fence
run_case "a quoted list fence keeps code excluded and prose reported" 1 quoted_list_fence_exit \
  "AGENTS.md:10:" "1 mid-sentence break(s) in 1 of"
run_case "prose after a quoted list fence exit still fires" 1 list_fence_inside_quote_exit \
  "AGENTS.md:10:" "1 mid-sentence break(s) in 1 of"
run_case "a list, then a quote, then a fence keeps code excluded" 1 list_then_quote_then_fence \
  "AGENTS.md:12:" "1 mid-sentence break(s) in 1 of"
run_case "a table does not fire" 0 table_rows
run_case "a bullet-majority block does not fire" 0 bullet_list
run_case "YAML frontmatter does not fire" 0 frontmatter_description
run_case "terminal punctuation and short lines do not fire" 0 terminal_punctuation_and_short_lines
run_case "a root markdown file outside the named four is out of scope" 0 out_of_scope_doc
run_case "a test fixture README is out of scope" 0 fixture_readme

echo "--- vacuity ---"
run_case "an in-scope prefix that matches nothing exits 2" 2 rotted_scope_prefix \
  "matched no tracked markdown"

echo "--- the missing dependency ---"
# `python3 -S` drops site packages, which is how a developer machine without
# python3-markdown-it looks to the gate. It has to fail as a gate (exit 2 with
# the install command), not as a traceback.
missing_parser_dir="$(setup_repo)"
set +e
missing_output="$(cd "$missing_parser_dir" && python3 -S "$GATE" 2>&1)"
missing_exit=$?
set -e
if [[ "$missing_exit" -ne 2 ]]; then
  fail "a missing markdown-it-py must exit 2, got $missing_exit"
  show "$missing_output"
elif [[ "$missing_output" != *"markdown-it-py is required"* ]]; then
  fail "a missing markdown-it-py must name the install command"
  show "$missing_output"
else
  echo "PASS: a missing markdown-it-py exits 2 with installation guidance"
fi
if ! cleanup_fixture "$missing_parser_dir"; then
  fail "missing-parser fixture cleanup failed ($missing_parser_dir)"
fi

echo "--- the real tree ---"
set +e
real_output="$(cd "$REPO_ROOT" && python3 "$GATE" 2>&1)"
real_exit=$?
set -e
if [[ "$real_exit" -eq 0 ]]; then
  echo "PASS: the repository tree reports zero mid-sentence breaks"
else
  fail "the repository tree must report zero mid-sentence breaks (exit $real_exit)"
  show "$real_output"
fi

echo
if [[ "$failures" -eq 0 ]]; then
  echo "test-prose-wraps: all cases passed"
else
  echo "test-prose-wraps: $failures failure(s)"
  exit 1
fi
