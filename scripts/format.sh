#!/bin/sh
# Format with the ts-template Prettier config (printWidth 160).
#   scripts/format.sh          -> write
#   scripts/format.sh --check  -> verify only
#
# Runs the local binary rather than `npx`; see scripts/lint.sh for why.
set -eu
. "$(dirname -- "$0")/_bootstrap.sh"
ensure_deps

if [ "${1:-}" = "--check" ]; then
  exec "$ROOT/node_modules/.bin/prettier" --check .
fi
exec "$ROOT/node_modules/.bin/prettier" --write .
