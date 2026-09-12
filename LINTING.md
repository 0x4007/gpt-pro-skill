# Linting Setup Guidebook

Everything learned bringing `gpt-pro-skill` onto the Ubiquity `ts-template` lint stack.
Written so the next agent can spend its effort **fixing a repo**, not re-deriving the setup.

Source of truth: this repo is the reference implementation. `eslint.config.mjs`, `knip.json`,
`tsconfig.lint.json`, `deno.json`, `package.json` and `scripts/` here are all working examples.

---

## 0. TL;DR

1. Read §2 (traps) before touching anything. Most of the cost is in these, not in the rules.
2. Copy the config templates in §3, adapting paths.
3. Run the linter, `--fix` what it can, then triage what's left (§4, §5).
4. Prove every gate can actually fail (§6).
5. Keep tests untouched; if you must parallelize, give each agent disjoint files (§7).

The single most useful habit: **when a strict rule fires, ask whether the code is wrong or the
rule is wrong.** Many template rules are genuinely mis-specified (§2.9). Assuming it's always the
code wastes effort and produces contortions.

---

## 1. Decide the stack first

Ask, and write down the answers:

| Question                                                                   | Why it matters                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Is the repo Deno-first, Node/Bun, or mixed?                                | Determines most of §2                                          |
| What's the module layout? (`src/`, `.agents/skills/*/scripts/`, monorepo?) | Linters auto-detect entry points only for conventional layouts |
| Who owns `node_modules`?                                                   | Two owners = the worst trap (§2.3)                             |
| Is there existing formatting? Which width?                                 | A formatter change rewrites every file (§2.12)                 |
| Does an existing Verify flow exist?                                        | Adding lint to it is the whole point                           |

**Package manager / tool resolution.** ESLint config files import plugins by bare specifier
(`import tsEslint from "typescript-eslint"`), and Node resolves those from the config's own
location upward through `node_modules`. Therefore:

- `node_modules` in the project is **mandatory** — `npx eslint .` alone cannot work (§2.7).
- Pick one installer (`bun install` or `npm install`) and one config owner; see §2.3.

---

## 2. Trap catalogue

### 2.1 `tsconfig.json` shadows Deno (Deno only)

Deno auto-detects a root `tsconfig.json` **even when `deno.json` exists** and adopts its
`compilerOptions`. A tsconfig written for ESLint will break `deno check`.

Verified: a hostile `tsconfig.json` (`"lib": []`, `"types": []`) makes `deno check` fail;
renaming the same file to anything else fixes it.

**Do:** name the lint project something else — `tsconfig.lint.json` — and point
`parserOptions.project` at it. **Never** create a root `tsconfig.json` in a Deno repo.

### 2.2 Deno consumes `@types/node`, and the major must match

Deno does **not** ship `node:` typings via `deno types`. It reads `node_modules/@types/node`.
Remove it and `deno check` fails outright:

```
error: Could not find "@types/node" in a node_modules folder.
Deno expects the node_modules/ directory to be up to date.
```

So `@types/node` is required, and its **major must track Deno's Node compat level**:

```sh
deno eval "console.log(process.versions.node)"   # e.g. 26.3.0 -> use @types/node@^26
```

Getting this wrong is subtle: `@types/node@20` omitted `node:sqlite`, producing
`TS2591: Cannot find name 'node:sqlite'` in code that was previously fine. It looks like a code
bug and is not.

Beware: npm's `latest` tag for `@types/node` lags badly (was `22.20.2` while `26.5.1` existed).
Check majors explicitly, don't trust `latest`.

### 2.3 Two package managers owning `node_modules` — the worst trap

With `nodeModulesDir: "auto"` in `deno.json`, Deno creates `node_modules/.deno/` and turns some
entries into **symlinks** into it, while bun/npm installs real directories alongside. Result:
a plugin resolves through the symlink to a stale core.

Observed: ESLint 10 crashed in `@typescript-eslint/no-invalid-this` because the stack trace
pointed at `node_modules/.deno/eslint@9.14.0` — a v8 plugin running against a v9 core.

```sh
ls -ld node_modules/typescript-eslint        # symlink -> .deno/... means Deno owns it
find node_modules -maxdepth 1 -type l | wc -l
```

**Do:** set `"nodeModulesDir": "manual"` so the installer owns `node_modules` and Deno only reads
it. Then `rm -rf node_modules` and reinstall clean. `.deno` residue from an old `npm:` import map
persists otherwise and will bite later.

### 2.4 `**/*.ts` matches `.d.ts`

Glob patterns match declaration files. Generated `.d.ts` (e.g. `deno types > .deno-types.d.ts`,
~23k lines) gets linted and produces enormous false-positive counts.

Observed: 1,075 of 1,171 initial "violations" were `no-var` noise from a generated file.
Real count was 96.

**Do:** add `"**/*.d.ts"` to the config's `ignores`.

### 2.5 A missing generated types file silently _drops_ findings

If a generated ambient file (`.deno-types.d.ts`) is absent, type-aware rules lose type info and
report **fewer** findings — with **no error**. Observed: 52 instead of 54.

**Do:** make linting depend on type generation (`deno task` `dependencies`), and document that
the file is generated + gitignored.

### 2.6 `deno fmt` excludes silently ignore a leading `**/` (Deno only)

`"exclude": ["**/*.ts"]` does **nothing**, with no warning. Deno keeps reformatting those files.
This only surfaces once another formatter has changed them.

```jsonc
// WRONG - silently ignored
"fmt": { "exclude": ["**/*.ts"] }
// RIGHT - directory / root-relative globs
"fmt": { "exclude": [".agents", "*.md", "*.json", "*.mjs", "*.js", "*.ts"] }
```

**Two formatters cannot share files.** If Prettier owns formatting, exclude its file types from
`deno fmt`, and document that `deno fmt` is no longer the formatter for those.

Also: `deno lint`'s `no-empty` has **no** `allowEmptyCatch` option and does **not** accept a
comment as a block body. If you allow empty catches in ESLint, exclude `no-empty` from
`deno lint` (`"lint": { "rules": { "exclude": ["no-empty"] } }`) — ESLint still catches empty
blocks that aren't catches.

### 2.7 `npx` cannot resolve a config's plugins

`npx` can install a _binary_, but not make bare specifiers in the config resolve. A fresh clone
running `npx eslint .` installs ESLint and dies with `ERR_MODULE_NOT_FOUND` loading the config.

**Do:** install into the project (`bun install` / `npm install`), then invoke
`node_modules/.bin/eslint` directly. `npx --no-install` is equivalent to that plus a process
spawn, so it's redundant once `node_modules` is guaranteed. A bootstrap script that installs on
first run is genuinely useful; the `npx` layer is not.

### 2.8 `eslint-plugin-sonarjs@2` hard-crashes under ESLint 9

Three rules abort the entire run (`TypeError`, zero findings reported):

| Rule                                     | Error                                                 |
| ---------------------------------------- | ----------------------------------------------------- |
| `sonarjs/no-misused-promises`            | `tsutils.unionTypeParts is not a function`            |
| `sonarjs/no-redundant-type-constituents` | `Cannot read properties of undefined (reading 'map')` |
| `sonarjs/sonar-prefer-optional-chain`    | same class                                            |

Cause: sonarjs@2 bundles `@typescript-eslint/eslint-plugin@7.16.1`, which predates ESLint 9.
It only appears to work when a package manager hoists a newer `@typescript-eslint/utils` over it
— so behaviour differs between bun and Deno for the _same_ rule version.

Also: sonarjs@2 declares peer `eslint@^8`, producing 7 peer warnings against ESLint 9 and
silently pulling v7 packages into a v8 setup.

**Do:** use `eslint-plugin-sonarjs@^4`. Note `@typescript-eslint/eslint-plugin`'s peer range is
`>=4.8.4 <6.1.0`, so pin `typescript` explicitly (`~6.0.x`) — it is otherwise transitive and a
bump can pull in 7.x and break type-aware linting silently.

### 2.9 Template rules that are genuinely wrong

Do not assume the template is correct. These were verified wrong on real code:

| Rule                                                    | Problem                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@typescript-eslint/naming-convention` boolean prefixes | Prefix matching has **no word boundary**: `cancelled` is read as `can` + `celled`, then "must match StrictPascalCase". Also the allowlist `is\|should\|has\|can\|did\|will\|does` has no way to express past-participle booleans (`rejected`, `failed`, `expired`, `timedOut`). Measured: rejected **24 of 34** idiomatic names. |
| `no-empty`                                              | No `allowEmptyCatch`. Every empty `catch {}` in a cleanup path is an error. Other org repos patched this locally.                                                                                                                                                                                                                |
| bare `_` parameter                                      | The template dropped the `filter` that lets `(_, reject) => {}` through — `_` is then "not strictCamelCase". Older configs in the same org had this fixed, so it's a regression.                                                                                                                                                 |
| `no-nested-ternary`                                     | Duplicates `sonarjs/no-nested-conditional` from the preset — two errors for one problem. Drop the core one.                                                                                                                                                                                                                      |
| `no-explicit-any`                                       | Comes from `typescript-eslint` recommended, not an explicit choice; at least one org repo sets it `off`. Decide deliberately.                                                                                                                                                                                                    |

**A better boolean rule** (34/34 idiomatic accepted, 14/15 junk rejected):

```js
const booleanPrefixes = [
  "is",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "can",
  "could",
  "shall",
  "should",
  "will",
  "would",
  "did",
  "does",
  "do",
  "must",
  "may",
  "might",
  "needs",
  "allows",
  "supports",
  "matches",
  "contains",
  "includes",
  "exists",
];
const booleanStates = [
  "ready",
  "done",
  "terminal",
  "present",
  "background",
  "foreground",
  "valid",
  "invalid",
  "busy",
  "idle",
  "stale",
  "fresh",
  "dirty",
  "clean",
  "empty",
  "alive",
  "dead",
  "open",
  "closed",
  "locked",
  "visible",
  "enabled",
  "disabled",
  "loading",
  "pending",
  "running",
  "processing",
  "fetching",
  "saving",
  "retrying",
  "waiting",
  "streaming",
  "polling",
  "syncing",
  "uploading",
  "downloading",
  "inProgress",
  "inFlight",
];
const booleanNamePattern = [
  `^(?:${booleanPrefixes.join("|")})(?:[A-Z0-9]|$)`, // isReady, wasRejected
  "^[a-z][A-Za-z0-9]{2,}(?:ed|able|ible|ous|ive|ant|ent)$", // rejected, retryable
  "^[a-z][A-Za-z0-9]*(?:ed|ing)(?:Out|Up|Down|Off|On|In|Done)$", // timedOut
  `^(?:${booleanStates.join("|")})$`, // ready, loading
].join("|");
// { selector: "variable", types: ["boolean"], format: ["strictCamelCase"],
//   custom: { regex: booleanNamePattern, match: true } }
```

The `{2,}` stem guard is what rejects `bed`/`need`. Only `speed` slips through. Extensible by
adding words to the arrays.

Bare `_` fix: `{ selector: "variableLike", format: ["strictCamelCase"], filter: { regex: "^_$", match: false } }`.
`filter` with `match: false` means "skip this rule for names matching" — that's the mechanism for
narrow exemptions.

### 2.10 Deliberately insecure fixtures must not be "fixed"

A security test asserts that insecure input is **rejected**, so the insecure value is the subject
under test. Blindly satisfying the linter deletes the assertion while keeping the suite green.
Real examples encountered:

| Finding                           | Why it must stay                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sonarjs/no-clear-text-protocols` | `http://chatgpt.com/` is the _same-host scheme-downgrade_ case, asserted rejected with zero credential-bearing requests. Changing to `https://` leaves a duplicate of the origin case. |
| `sonarjs/encryption-secure-mode`  | The fixture must use Chromium's real AES-128-CBC + `v10` scheme, because production only decrypts exactly that.                                                                        |
| `no-extend-native`                | Patching `Date.prototype` is the only way to control the timezone when the subject has no injectable clock.                                                                            |
| `preserve-caught-error`           | New in `@eslint/js` 10. Fires where a test throws a failure signal from inside a `catch`; attaching `{ cause: error }` would embed the very secret the test asserts is absent.         |

**Do:** for each, decide _deliberate_ vs _genuine_. For deliberate ones add a **file-scoped**
exemption with the reasoning inline, and a comment at the call site. Never a blanket disable.

For `preserve-caught-error` specifically there is a better fix than exempting: hoist the assertion
out of the `catch` so the catch only captures, and the rule stays active.

### 2.11 Prettier will rewrite everything

If existing code is formatted at a different width than the template's (`printWidth: 160`), every
file shows hundreds of lines of churn and the semantic diff becomes unreviewable.

**Do:** structure commits so formatting is isolated (§8), and warn reviewers to diff _from_ the
format commit rather than from the base branch.

### 2.12 knip needs entry points for non-conventional layouts

With no config, knip reports every source file as an orphan. Model the real entry points
(CLIs, test files) and set `includeEntryExports: true` — otherwise an entry's exports are assumed
public and unused ones are never reported.

`prettier` will be reported as an unused devDependency because it's only invoked as a binary and
knip can't trace through shell scripts. Add it to `ignoreDependencies`. (Verified still needed on
knip 6.)

---

## 3. Config templates

### `package.json` (devDependencies)

```jsonc
{
  "scripts": {
    "lint": "sh scripts/lint.sh",
    "lint:fix": "sh scripts/lint.sh --fix",
    "format": "sh scripts/format.sh",
    "format:check": "sh scripts/format.sh --check",
    "knip": "sh scripts/knip.sh",
    "verify": "sh scripts/verify.sh",
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^26.0.0", // MUST match `deno eval "process.versions.node"`
    "eslint": "^10.10.0",
    "eslint-plugin-check-file": "^3.3.2",
    "eslint-plugin-sonarjs": "^4.2.0", // v2 CRASHES under ESLint 9
    "knip": "^6.35.1",
    "prettier": "^3.9.6",
    "typescript": "~6.0.3", // pin! typescript-eslint peer is <6.1.0, latest is 7.x
    "typescript-eslint": "^8.70.0",
  },
}
```

Peer ranges to check before major upgrades: `typescript-eslint`, `sonarjs` and `check-file` all
declare ESLint support explicitly — verify `^10` (or your target) before installing.

### `eslint.config.mjs` skeleton

```js
// @ts-check
import eslint from "@eslint/js";
import tsEslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import checkFile from "eslint-plugin-check-file";

export default tsEslint.config(
  {
    ignores: [
      "node_modules/**",
      "**/*.d.ts", // Trap 2.4 - generated declarations
      "eslint.config.mjs",
      // ...generated dirs, vendored copies, worktrees
    ],
  },
  {
    files: ["**/*.ts"],
    plugins: { "@typescript-eslint": tsEslint.plugin, "check-file": checkFile },
    extends: [
      eslint.configs.recommended,
      ...tsEslint.configs.recommended,
      ...tsEslint.configs.strictTypeChecked, // type-aware family
      ...tsEslint.configs.stylisticTypeChecked,
      sonarjs.configs.recommended,
    ],
    languageOptions: {
      parser: tsEslint.parser,
      parserOptions: {
        project: ["./tsconfig.lint.json"], // Trap 2.1 - NOT tsconfig.json
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ...see the reference repo for the full tuned set
      // Restore rules sonarjs@4 ships but sets "off":
      "sonarjs/os-command": "error",
      "sonarjs/no-unsafe-unzip": "error",
      "sonarjs/confidential-information-logging": "error",
      // Recover rules sonarjs deleted, from ESLint core:
      "no-extend-native": "error",
      "new-cap": "error",
      "default-case": "error",
    },
  },
  // File-scoped exemptions for deliberately insecure fixtures (Trap 2.10)
  {
    files: ["**/tests/web-session_test.ts"],
    rules: { "sonarjs/no-clear-text-protocols": "off" },
  }
);
```

**Note:** `strictTypeChecked` enables a noisy `no-unsafe-*` family. It is worth having but needs
`any` sources cleaned first — start with them off and enable once the codebase is `any`-free.

### `knip.json`

```jsonc
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["path/to/cli.ts", "path/to/other-cli.ts", "tests/**/*_test.ts"],
  "project": ["src/**/*.ts"],
  "includeEntryExports": true,
  "ignoreDependencies": ["prettier"],
}
```

### `deno.json`

```jsonc
{
  "nodeModulesDir": "manual", // Trap 2.3 - installer owns node_modules
  "tasks": {
    "types": "deno types > .deno-types.d.ts",
    "lint:deno": "deno lint",
    "check": "deno check <entry>.ts",
    "test": "deno test --allow-read --allow-write tests/",
    "verify": "sh scripts/verify.sh",
  },
  "fmt": { "exclude": ["<dirs>", "*.md", "*.json", "*.mjs", "*.js", "*.ts"] }, // Trap 2.6
  "lint": { "exclude": ["node_modules"], "rules": { "exclude": ["no-empty"] } },
}
```

---

## 4. Restoring coverage the template loses

`sonarjs@2` shipped 328 rules but only **256 were active** (72 already `off`).
`sonarjs@4` ships 279, all active. Naively upgrading looks like a loss; it isn't, because
most v2 rules were **ports of upstream plugins**. Map them back:

| Deleted from sonarjs      | Restore from                                       |
| ------------------------- | -------------------------------------------------- |
| React / JSX / hooks rules | `eslint-plugin-react`, `eslint-plugin-react-hooks` |
| Accessibility rules       | `eslint-plugin-jsx-a11y`                           |
| Type-aware correctness    | `@typescript-eslint` (`strictTypeChecked`)         |
| Core-style rules          | ESLint core                                        |

68 of 78 deleted rules have a **byte-identical** name upstream. Examples:
`jsx-key` → `react/jsx-key`; `rules-of-hooks` → `react-hooks/rules-of-hooks`;
`no-misused-promises` → `@typescript-eslint/no-misused-promises`; `new-cap` → core `new-cap`.

After restoring, coverage went **16 → 32 active rules** with zero losses.

**Also check:** every `sonar-*` prefixed rule was renamed in v3+ (`sonar-prefer-regexp-exec` →
`prefer-regexp-exec`). Any config naming a `sonar-*` rule breaks on upgrade.

**And:** 9 rules v4 **ships but sets to `off`** in `recommended`, silently downgrading from v2's
`error`. Re-enable deliberately — they're mostly security hotspots.

---

## 5. Triage protocol

Work in this order; it saves the most time.

1. **Auto-fix first.** `scripts/lint.sh --fix`. This stabilizes line numbers before you delegate
   or report anything.
2. **Separate real bugs from style.** Prioritize: security rules (ReDoS, code-eval, crypto),
   type-safety, then complexity, then style.
3. **When a rule fires, decide: code wrong, or rule wrong?** See §2.9. Genuine mis-specifications
   should be fixed in the config, not worked around in code.
4. **Watch for duplicate reporting.** Core and plugin rules overlap
   (`no-nested-ternary` / `sonarjs/no-nested-conditional`; `no-unused-vars` /
   `sonarjs/no-ignored-exceptions`). Two errors for one line is noise — drop one.
5. **Type-assertion smells.** If `no-unnecessary-condition` fires and looks wrong, check whether
   the code annotated untrusted input (e.g. parsed JSON) as a typed value _before_ validating it.
   That is a real bug, and it makes legitimate tamper checks read as "always false". Fix by
   parsing into `unknown` and validating with type predicates.
6. **Complexity refactors go last** and should be behaviour-preserving extractions only.

---

## 6. Verification protocol (non-negotiable)

Every gate must be **proven able to fail**. A gate that can't fail isn't a gate.

```sh
sh scripts/verify.sh          # full chain, exit 0
./node_modules/.bin/eslint .  # expect NO output at all
./node_modules/.bin/knip      # expect NO output at all
deno test ...                 # expect the same pass count as before you started
```

**Negative-test each gate** — plant a violation, confirm non-zero exit, revert:

```sh
printf '\nexport const unusedProbe = 1;\n' >> src/file.ts
sh scripts/knip.sh; echo "exit=$?"     # must be non-zero
git checkout src/file.ts
```

**Cold-start test the bootstrap** — delete `node_modules` and re-run; it must self-heal.

**Record the baseline first.** Note the pass count (e.g. 40/40) and the finding count before
touching anything, so you can prove you didn't drop coverage.

**Beware transient failures from concurrent agents.** Running several agents in one workspace
means they read half-written files and see phantom type errors in files they don't own. Confirm
the final state rather than trusting mid-flight output.

---

## 7. Parallelizing with subagents

If you delegate, follow these rules — they prevented every collision here.

1. **Partition by disjoint FILE OWNERSHIP, not by rule class.** Classes span files; two agents
   editing one file will clobber each other.
2. **Run `--fix` first** so agents work against stable line numbers.
3. **Never let agents edit tests.** An untouched suite is a real regression check; a suite edited
   to match a refactor proves nothing. Tell them explicitly.
4. **Instruct them to REPORT deliberate-by-design findings, not fix them** (see §2.10). Otherwise
   they will "fix" a security fixture and silently delete an assertion.
5. **Give them the dependency analysis up front.** Don't make them re-derive module boundaries.
6. **Forbid `eslint-disable`** unless genuinely impossible, and require justification.
7. **Require a report of anything that is not a pure move.**
8. **Verify their claims yourself.** Reproduce the finding counts, re-run their harnesses. In this
   session each agent was independently checked; one agent's differential harness
   (1,593 comparisons, 0 failures) was re-run rather than trusted.

**For a big behavior-preserving refactor**, ask for a **differential harness**: import the old
revision from a snapshot and the new one side by side, run both across fuzzed input and real
on-disk scenarios, and compare results, call counts, file modes and error messages.

---

## 8. Commit and review structure

A single commit makes this unreviewable (§2.11). Split it:

```
chore(lint): add tooling            # configs + scripts only, no source changes
style:       reformat               # format-only, no semantic change
refactor(lint): resolve findings    # the actual work, now readable
```

Tell reviewers to diff from the _format_ commit (`git diff <format-sha>..HEAD`) to see only the
semantic changes.

---

## 9. Org-level findings worth feeding back

Things the template itself gets wrong, so they get fixed once instead of per-repo:

1. **`ts-template` pins `eslint-plugin-sonarjs@^2.0.4`, which crashes under ESLint 9** (§2.8).
   Should be `^4`.
2. **The boolean naming rule is mis-specified** — no word boundary, and an allowlist that can't
   express `rejected`/`failed`/`timedOut`. Rejects ~70% of idiomatic names (§2.9).
3. **`no-empty` lacks `allowEmptyCatch`**, so repos keep patching it locally.
4. **The bare `_` parameter filter was dropped** in the flat-config rewrite — a regression against
   older `.eslintrc` configs in the same org.
5. **`no-nested-ternary` duplicates `sonarjs/no-nested-conditional`.**
6. **`ts-template` should not rely on SonarJS as its whole linter.** Use `typescript-eslint`
   type-checked presets + ESLint core + SonarJS only for Sonar-specific rules
   (`cognitive-complexity`, `code-eval`, `super-linear-regex`, `encryption-secure-mode`).
7. **`ts-template`'s `allowDefaultProject` looks inert** because it pairs with `project` rather
   than `projectService`. Unverified — worth confirming.
8. **Add CI.** Most org repos have no workflow running the verify chain; findings accumulate
   invisibly. This is the highest-value single fix.

---

## 10. Copy-paste bootstrap script

`scripts/_bootstrap.sh` — installs on first run so a fresh clone works:

```sh
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

deps_ready() {
  [ -x node_modules/.bin/eslint ] && [ -x node_modules/.bin/prettier ] && [ -x node_modules/.bin/knip ]
}

ensure_deps() {
  if deps_ready; then return 0; fi
  echo "==> installing dev dependencies (first run)"
  for pm in bun npm; do
    command -v "$pm" >/dev/null 2>&1 || continue
    if [ "$pm" = "bun" ]; then bun install --no-summary; else npm install --no-audit --no-fund; fi
    if deps_ready; then return 0; fi
    echo "==> $pm did not produce node_modules; trying the next package manager" >&2
  done
  echo "error: could not install dev dependencies (tried bun, npm)" >&2
  exit 1
}
```

`scripts/verify.sh` — runs **every** gate and reports, rather than stopping at the first failure
(same reasoning as `if: always()` in CI):

```sh
fail=0
run() { label="$1"; shift; printf '\n==> %s\n' "$label"
        if ! "$@"; then printf '!!! FAILED: %s\n' "$label"; fail=1; fi; }

run "deno types"   deno task types
run "prettier"     "$ROOT/node_modules/.bin/prettier" --check .
run "eslint"       "$ROOT/node_modules/.bin/eslint" .
run "knip"         "$ROOT/node_modules/.bin/knip"
run "deno lint"    deno lint
run "deno check"   deno check <entry>.ts
run "deno test"    deno test --allow-read --allow-write <tests>/
exit $fail
```

---

## 11. Checklist

- [ ] Confirmed Deno vs Node, module layout, `node_modules` owner, existing format width
- [ ] Checked peer ranges before any major upgrade
- [ ] `@types/node` major matches `process.versions.node`
- [ ] `typescript` pinned within `typescript-eslint`'s peer range
- [ ] `nodeModulesDir: "manual"` (Deno) — only one owner of `node_modules`
- [ ] Lint project named `tsconfig.lint.json`, **no** root `tsconfig.json` in a Deno repo
- [ ] `**/*.d.ts` ignored
- [ ] Type generation runs before lint (`deno task` dependencies)
- [ ] Formatter ownership resolved; `deno fmt` excludes written as directory-relative globs
- [ ] knip entry points + `includeEntryExports` configured
- [ ] `--fix` run before triage
- [ ] Deliberate-by-design findings exempted per-file with inline rationale, not blanket-disabled
- [ ] Tests untouched, or a clear justification recorded
- [ ] Every gate negative-tested (plant a violation, confirm failure)
- [ ] Cold-start tested (delete `node_modules`)
- [ ] Baseline pass count matched
- [ ] Commits split: tooling / format / semantic
- [ ] `eslint` and `knip` produce **no output at all** (not "no errors")
- [ ] CI added, or the absence stated explicitly
