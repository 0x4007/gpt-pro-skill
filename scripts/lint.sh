#!/bin/sh
# Run ESLint with the Ubiquity ts-template ruleset.
#   scripts/lint.sh          -> report
#   scripts/lint.sh --fix    -> apply safe fixes
set -eu
. "$(dirname -- "$0")/_bootstrap.sh"
ensure_deps
exec npx --no-install eslint "$@"
