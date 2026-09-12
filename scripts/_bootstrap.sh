# Shared bootstrap for the dev-tooling scripts. Sourced, never executed directly.
#
# node_modules does not shadow Deno here: this repo has no tsconfig.json (the
# lint project is tsconfig.lint.json) and does not install @types/node. Those
# are the only known vectors by which a local node_modules can override Deno's
# own compiler options and Node-compat typings.

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

deps_ready() {
  [ -x node_modules/.bin/eslint ] && [ -x node_modules/.bin/prettier ]
}

ensure_deps() {
  if deps_ready; then
    return 0
  fi

  echo "==> installing dev dependencies (first run)"
  for pm in bun npm; do
    command -v "$pm" >/dev/null 2>&1 || continue
    if [ "$pm" = "bun" ]; then
      bun install --no-summary
    else
      npm install --no-audit --no-fund
    fi
    if deps_ready; then
      return 0
    fi
    echo "==> $pm did not produce node_modules; trying the next package manager" >&2
  done

  echo "error: could not install dev dependencies (tried bun, npm)" >&2
  exit 1
}
