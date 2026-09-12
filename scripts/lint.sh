#!/bin/sh
# Run ESLint with the Ubiquity ts-template ruleset.
#   scripts/lint.sh          -> report
#   scripts/lint.sh --fix    -> apply safe fixes
#
# Runs the local binary rather than `npx`: npx can install ESLint, but it cannot
# make the bare plugin imports in eslint.config.mjs resolve, so node_modules is
# required regardless and npx would only add a process spawn.
set -eu
. "$(dirname -- "$0")/_bootstrap.sh"
ensure_deps
exec "$ROOT/node_modules/.bin/eslint" "$@"
