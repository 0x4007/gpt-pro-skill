#!/bin/sh
# Format with the ts-template Prettier config (printWidth 160).
#   scripts/format.sh          -> write
#   scripts/format.sh --check  -> verify only
set -eu
. "$(dirname -- "$0")/_bootstrap.sh"
ensure_deps

if [ "${1:-}" = "--check" ]; then
  exec npx --no-install prettier --check .
fi
exec npx --no-install prettier --write .
