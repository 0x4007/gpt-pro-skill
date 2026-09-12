#!/bin/sh
# Full verification gate: type generation, formatting, linting, type checking, tests.
# Runs every gate even if an earlier one fails, then exits non-zero if any failed.
set -u
. "$(dirname -- "$0")/_bootstrap.sh"
ensure_deps

fail=0

run() {
  label="$1"
  shift
  printf '\n==> %s\n' "$label"
  if ! "$@"; then
    printf '!!! FAILED: %s\n' "$label"
    fail=1
  fi
}

# Regenerate Deno's ambient types first: without .deno-types.d.ts the type-aware
# rules silently lose findings rather than erroring.
run "deno types" deno task types
run "prettier (format check)" npx --no-install prettier --check .
run "eslint (template ruleset)" npx --no-install eslint .
run "deno lint" deno lint
run "deno check" deno check .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts
run "deno test" deno test --allow-read --allow-write .agents/skills/gpt-pro/tests/

printf '\n'
if [ "$fail" -ne 0 ]; then
  echo "verify: FAILED"
  exit 1
fi
echo "verify: OK"
