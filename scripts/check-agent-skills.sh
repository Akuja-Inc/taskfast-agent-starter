#!/usr/bin/env bash
set -euo pipefail

# Does every project skill under .agents/skills load cleanly, with its trigger
# boundary reviewable, for any account that checks this repository out?
#
# Against the tracked tree of the current directory:
#
#   1. No tracked symlink under .agents/skills. A relative one can still leave
#      the checkout, and none is needed.
#   2. Every skill directory carries a SKILL.md whose YAML frontmatter has a
#      `name` equal to its directory (so skill names are unique by
#      construction) and a `description`.
#   3. Every skill directory carries a tracked `evals/trigger-cases.json`: a
#      JSON array of objects with a string `prompt`, a boolean
#      `should_trigger` and a string `why`, so a skill's trigger boundary is
#      stated, not implied.
#
# Exit 0 when all hold, 1 with one line per violation otherwise.

bad=0
fail() { echo "FAIL: $*" >&2; bad=1; }

while read -r mode _ _ path; do
  [[ "$mode" == 120000 ]] && fail "$path is a symlink; vendor the files instead"
done < <(git -c core.quotePath=false ls-files -s .agents/skills)

while IFS= read -r dir; do
  f=".agents/skills/$dir/SKILL.md"
  if [[ ! -f "$f" ]]; then
    fail ".agents/skills/$dir/ has no SKILL.md"
    continue
  fi
  name="$(awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit }
               /^name:/ { print $2; exit }' "$f")"
  if [[ -z "$name" ]]; then
    fail "$f: frontmatter has no name:"
  elif [[ "$name" != "$dir" ]]; then
    fail "$f: name '$name' differs from its directory '$dir'"
  fi
  if ! awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit }
            /^description:/ { found = 1; exit } END { exit !found }' "$f"; then
    fail "$f: frontmatter has no description:"
  fi

  j=".agents/skills/$dir/evals/trigger-cases.json"
  if [[ -z "$(git -c core.quotePath=false ls-files -- "$j")" ]]; then
    fail ".agents/skills/$dir/ has no tracked evals/trigger-cases.json"
    continue
  fi
  set +e
  python3 - "$j" <<'PY'
import json
import sys

path = sys.argv[1]
bad = 0


def fail(message):
    global bad
    bad = 1
    print(f"FAIL: {path}: {message}", file=sys.stderr)


try:
    with open(path, encoding="utf-8") as handle:
        cases = json.load(handle)
except (OSError, UnicodeDecodeError, ValueError) as error:
    fail(f"is not readable JSON: {error}")
    sys.exit(1)
if not isinstance(cases, list):
    fail("is not a JSON array")
    sys.exit(1)
if not cases:
    fail("is an empty array; name at least one trigger case")
for index, case in enumerate(cases):
    if not isinstance(case, dict):
        fail(f"case {index} is not a JSON object")
        continue
    prompt = case.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        fail(f'case {index} has no non-empty string "prompt"')
    if not isinstance(case.get("should_trigger"), bool):
        fail(f'case {index} has no boolean "should_trigger"')
    why = case.get("why")
    if not isinstance(why, str) or not why.strip():
        fail(f'case {index} has no non-empty string "why"')
sys.exit(1 if bad else 0)
PY
  json_rc=$?
  set -e
  [[ "$json_rc" -eq 0 ]] || bad=1
done < <(git -c core.quotePath=false ls-files -z .agents/skills |
  tr '\0' '\n' | sed -nE 's|^\.agents/skills/([^/]+)/.*|\1|p' | sort -u)

if [[ "$bad" -eq 0 ]]; then
  echo "Every project skill carries a well-formed SKILL.md and trigger cases."
fi
exit "$bad"
