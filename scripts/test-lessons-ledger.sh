#!/usr/bin/env bash
set -euo pipefail
# Regression test for scripts/check-lessons-ledger.py.
#
# One throwaway git repo per case. Each rule in the checker has a fixture that
# trips it and nothing else, so dropping that rule turns exactly one case red.
# The clean case is the positive control for the whole contract: a ledger whose
# rows name a tracked path and a check-row issue URL passes.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/scripts/check-lessons-ledger.py"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/lessons-ledger-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
failures=0

HEADER=$'source_id\torigin\tfirst_seen\tdisposition\ttarget\tnote'
ROW_OK=$'mem:claude:feedback_tui_bun.md\tclaude-memory\t2026-10-08T12:00:00Z\tlesson\t.agents/lessons/tui.md\tpnpm tui:test needs Bun'
ROW_SKILL=$'hand:0123456789ab\tcodex\t2026-10-08T12:00:00Z\tskill\t.agents/skills/demo/SKILL.md\tfolded into the setup skill'
ROW_CHECK=$'mem:kimi:reference_flake.md\tkimi-memory\t2026-10-08T12:00:00Z\tcheck\thttps://github.com/Akuja-Inc/taskfast-agent-starter/issues/12\tvitest ordering flake rerun'
ROW_DISCARD=$'mem:codex:project_stale_note.md\tcodex-memory\t2026-10-08T12:00:00Z\tdiscard\t\tstale README claim'

setup_repo() {
  local dir
  dir="$(mktemp -d "$TMP/case-XXXXXX")"
  (
    cd "$dir"
    git init -q
    git config user.email t@example.com
    git config user.name t
    mkdir -p .agents/lessons .agents/skills/demo
    printf '# demo\n' >.agents/lessons/tui.md
    printf -- '---\nname: demo\n---\n' >.agents/skills/demo/SKILL.md
    printf '%s\n' "$HEADER" >.agents/lessons/LEDGER.tsv
    git add -A && git commit -q -m seed
  )
  echo "$dir"
}

# run_case <name> <expected-exit> <ledger-body-after-header> [expected-substring]
# Every case repo tracks .agents/lessons/tui.md, so run_case prepends ROW_OK
# to keep that file covered and a case trips only the rule it names.
# run_case_raw writes the body verbatim, for cases about the coverage rule.
run_case() {
  run_case_raw "$1" "$2" "$ROW_OK${3:+
$3}" "${4:-}"
}

run_case_raw() {
  local name="$1" expected="$2" body="$3" want="${4:-}"
  local dir actual output
  dir="$(setup_repo)"
  printf '%s\n' "$HEADER" >"$dir/.agents/lessons/LEDGER.tsv"
  if [[ -n "$body" ]]; then printf '%s\n' "$body" >>"$dir/.agents/lessons/LEDGER.tsv"; fi
  set +e
  output="$(cd "$dir" && python3 "$CHECK" 2>&1)"
  actual=$?
  set -e
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $name expected exit $expected, got $actual"; echo "$output" | sed 's/^/    /'
    failures=$((failures + 1)); return
  fi
  if [[ -n "$want" && "$output" != *"$want"* ]]; then
    echo "FAIL: $name output lacks '$want'"; echo "$output" | sed 's/^/    /'
    failures=$((failures + 1)); return
  fi
  echo "PASS: $name (exit $actual)"
}

run_case "rows that agree with the contract pass" 0 "$ROW_SKILL
$ROW_CHECK
$ROW_DISCARD"
run_case "GitHub keys that agree with the contract pass" 0 $'ci:0123456789ab:3\tgithub\t2026-10-09T12:00:00Z\tdiscard\t\tflaky probe
pr:12:R2-F1\tgithub\t2026-10-09T12:00:00Z\tcheck\thttps://github.com/Akuja-Inc/taskfast-agent-starter/issues/12\treviewer repeats a ruled-out claim'
run_case "a ci key without its run count fires" 1 $'ci:0123456789ab\tgithub\t2026-10-09T12:00:00Z\tdiscard\t\t' "matches no key format"
run_case "a ci run count of zero fires" 1 $'ci:0123456789ab:0\tgithub\t2026-10-09T12:00:00Z\tdiscard\t\t' "matches no key format"
run_case "an uppercase ci anchor fires" 1 $'ci:0123456789AB:3\tgithub\t2026-10-09T12:00:00Z\tdiscard\t\t' "matches no key format"
run_case "a non-numeric PR in a pr key fires" 1 $'pr:not-a-pr:F1\tgithub\t2026-10-09T12:00:00Z\tdiscard\t\t' "matches no key format"
run_case "an empty finding id in a pr key fires" 1 $'pr:12:\tgithub\t2026-10-09T12:00:00Z\tdiscard\t\t' "matches no key format"
run_case "a hand key without its anchor fires" 1 $'hand\tx\t2026-10-08T12:00:00Z\tdiscard\t\t' "matches no key format"
run_case "a short hand anchor fires" 1 $'hand:0123456789a\tx\t2026-10-08T12:00:00Z\tdiscard\t\t' "matches no key format"
run_case "a mem key with a path in the filename fires" 1 $'mem:claude:notes/trap.md\tx\t2026-10-08T12:00:00Z\tdiscard\t\t' "matches no key format"
run_case "a mem filename without .md fires" 1 $'mem:claude:feedback_trap\tx\t2026-10-08T12:00:00Z\tdiscard\t\t' "matches no key format"
run_case "a 40-hex ci anchor fires" 1 $'ci:0123456789abcdef0123456789abcdef01234567:1\tx\t2026-10-08T12:00:00Z\tdiscard\t\t' "matches no key format"
run_case "a wrong column count fires" 1 $'mem:claude:a.md\tclaude-memory\t2026-10-08T12:00:00Z\tlesson' "columns, expected 6"
run_case "a duplicate source_id fires" 1 "$ROW_OK" "already recorded on line 2"
run_case "a non-UTC first_seen fires" 1 $'mem:claude:a.md\tx\t2026-10-08 12:00\tdiscard\t\t' "YYYY-MM-DDTHH:MM:SSZ"
run_case "an unknown disposition fires" 1 $'mem:claude:a.md\tx\t2026-10-08T12:00:00Z\tmaybe\t\t' "is not one of"
run_case "a lesson whose target is untracked fires" 1 $'mem:claude:a.md\tx\t2026-10-08T12:00:00Z\tlesson\t.agents/lessons/missing.md\t' "is not a tracked path"
run_case "a check row with a foreign URL fires" 1 $'mem:claude:a.md\tx\t2026-10-08T12:00:00Z\tcheck\thttps://example.com/1\t' "issue URL"
run_case "a discard row needs no target" 0 "$ROW_DISCARD"
run_case_raw "a lesson file with no ledger row fires" 1 "" "no row with disposition lesson"
run_case "the same lesson file with a row passes" 0 ""
# an empty ledger still passes when the tree tracks no lesson files
dir="$(setup_repo)"; (cd "$dir" && git rm -q .agents/lessons/tui.md)
if (cd "$dir" && python3 "$CHECK" >/dev/null 2>&1); then echo "PASS: an empty ledger without tracked lesson files passes"; else echo "FAIL: an empty ledger without tracked lesson files should pass"; failures=$((failures + 1)); fi
# run_case always writes the real header, so the wrong-header case is explicit
dir="$(setup_repo)"; printf 'id\tx\n' >"$dir/.agents/lessons/LEDGER.tsv"
if (cd "$dir" && python3 "$CHECK" >/dev/null 2>&1); then echo "FAIL: a wrong header should exit 1"; failures=$((failures + 1)); else echo "PASS: a wrong header fires"; fi
# missing file exits 2
dir="$(setup_repo)"; rm "$dir/.agents/lessons/LEDGER.tsv"
set +e; (cd "$dir" && python3 "$CHECK" >/dev/null 2>&1); rc=$?; set -e
if [[ "$rc" == 2 ]]; then echo "PASS: a missing ledger exits 2"; else echo "FAIL: a missing ledger should exit 2, got $rc"; failures=$((failures + 1)); fi

echo "--- the real tree ---"
if (cd "$ROOT" && python3 "$CHECK" >/dev/null); then echo "PASS: the repository ledger agrees with the contract"; else echo "FAIL: the repository ledger does not pass"; failures=$((failures + 1)); fi

echo
if [[ "$failures" == 0 ]]; then echo "test-lessons-ledger: all cases passed"; else echo "test-lessons-ledger: $failures failure(s)"; exit 1; fi
