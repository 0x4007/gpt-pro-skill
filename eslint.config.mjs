// @ts-check
// Ubiquity ts-template lint ruleset. Deliberate local changes are marked DIVERGENCE.
// The in-house @ubiquity-os/eslint-plugin-no-empty-strings rule is intentionally omitted.
import eslint from "@eslint/js";
import tsEslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import checkFile from "eslint-plugin-check-file";

// DIVERGENCE: the stock template used
//   prefix: ["is","should","has","can","did","will","does"], format: ["StrictPascalCase"]
// Measured against a 34-name probe that rejected 24 idiomatic booleans, and because
// prefix matching had no word boundary it mis-read `cancelled` as `can` + `celled`
// (surfacing as "trimmed as `celled` must match StrictPascalCase").
// This accepts any of:
//   1. auxiliary prefix + word boundary -> isReady, hasAccess, wasRejected
//   2. participial / adjectival suffix  -> rejected, retryable, timeoutObserved
//   3. phrasal participle               -> timedOut
//   4. irregular or progress state      -> ready, done, loading, pending
// Probe result: 34/34 idiomatic accepted, 14/15 junk rejected.
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
  `^(?:${booleanPrefixes.join("|")})(?:[A-Z0-9]|$)`,
  "^[a-z][A-Za-z0-9]{2,}(?:ed|able|ible|ous|ive|ant|ent)$",
  "^[a-z][A-Za-z0-9]*(?:ed|ing)(?:Out|Up|Down|Off|On|In|Done)$",
  `^(?:${booleanStates.join("|")})$`,
].join("|");

export default tsEslint.config(
  {
    // Stale copies, generated output, and dev scratch directories.
    ignores: ["node_modules/**", "**/*.d.ts", ".bun-cache/**", ".diagnostics/**", ".codex-worktrees/**", ".gpt-pro-jobs/**", "eslint.config.mjs"],
  },
  {
    files: ["**/*.ts"],
    plugins: {
      "@typescript-eslint": tsEslint.plugin,
      "check-file": checkFile,
    },
    extends: [
      eslint.configs.recommended,
      ...tsEslint.configs.recommended,
      ...tsEslint.configs.strictTypeChecked,
      ...tsEslint.configs.stylisticTypeChecked,
      sonarjs.configs.recommended,
    ],
    languageOptions: {
      parser: tsEslint.parser,
      parserOptions: {
        project: ["./tsconfig.lint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "check-file/filename-naming-convention": [
        "error",
        {
          "**/*.{js,ts}": "+([-._a-z0-9])",
        },
      ],
      "prefer-arrow-callback": ["warn", { allowNamedFunctions: true }],
      "func-style": ["warn", "declaration", { allowArrowFunctions: false }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "constructor-super": "error",
      "no-invalid-this": "off",
      "@typescript-eslint/no-invalid-this": "error",
      "no-restricted-syntax": ["error", "ForInStatement"],
      "use-isnan": "error",
      "no-unneeded-ternary": "error",
      // DIVERGENCE: dropped "no-nested-ternary". sonarjs/no-nested-conditional already
      // ships in the sonarjs recommended preset and reported the identical lines,
      // producing two errors for one problem.
      // DIVERGENCE: allowEmptyCatch, matching the workaround work.ubq.fi already
      // carried locally. All 11 no-empty hits here were intentional `} catch {}`
      // cleanup/teardown blocks.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          ignoreRestSiblings: true,
          vars: "all",
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-new": "error",
      "@typescript-eslint/restrict-plus-operands": "error",
      // ---------------------------------------------------------------------
      // RESTORE 1: sonarjs rules that v4 still ships but sets to "off" in its
      // recommended preset (they were "error" in v2). Mostly security hotspots.
      // ---------------------------------------------------------------------
      "sonarjs/os-command": "error",
      "sonarjs/no-unsafe-unzip": "error",
      "sonarjs/confidential-information-logging": "error",
      "sonarjs/no-ip-forward": "error",
      "sonarjs/frame-ancestors": "error",
      "sonarjs/no-mixed-content": "error",
      "sonarjs/hidden-files": "error",
      "sonarjs/no-intrusive-permissions": "error",
      "sonarjs/no-commented-code": "error",
      // ---------------------------------------------------------------------
      // RESTORE 2: rules sonarjs v4 deleted, recovered from ESLint core.
      // (their typescript-eslint equivalents arrive via strictTypeChecked,
      //  so core duplicates are deliberately not enabled.)
      // ---------------------------------------------------------------------
      "no-extend-native": "error",
      "new-cap": "error",
      "default-case": "error",
      "no-var": "error",
      "no-self-compare": "error",
      "no-useless-escape": "error",
      "max-lines": ["warn", { max: 1000 }],
      // ---------------------------------------------------------------------
      // SONARJS/TS OVERLAP: the type-aware TS rule supersedes the sonarjs one,
      // so turn the sonarjs copy off to avoid reporting one problem twice.
      // ---------------------------------------------------------------------
      "sonarjs/prefer-regexp-exec": "off",
      "sonarjs/deprecation": "off",
      // ---------------------------------------------------------------------
      // strictTypeChecked's no-unsafe-* family needs the `any` sources cleaned
      // up first; enable these once the codebase is `any`-free.
      // ---------------------------------------------------------------------
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // Intentional no-op stubs in the headless-browser shim (window.history,
      // remove(), etc.) are correct as empty methods; only flag other shapes.
      "@typescript-eslint/no-empty-function": ["error", { allow: ["methods"] }],
      "sonarjs/no-all-duplicated-branches": "error",
      "sonarjs/no-collection-size-mischeck": "error",
      "sonarjs/no-duplicated-branches": "error",
      "sonarjs/no-element-overwrite": "error",
      "sonarjs/no-identical-conditions": "error",
      "sonarjs/no-identical-expressions": "error",
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "interface",
          format: ["StrictPascalCase"],
          custom: { regex: "^I[A-Z]", match: false },
        },
        {
          selector: "memberLike",
          modifiers: ["private"],
          format: ["strictCamelCase"],
          leadingUnderscore: "require",
        },
        {
          selector: "typeLike",
          format: ["StrictPascalCase"],
        },
        {
          selector: "typeParameter",
          format: ["StrictPascalCase"],
          prefix: ["T"],
        },
        {
          selector: "variable",
          format: ["strictCamelCase", "UPPER_CASE"],
          leadingUnderscore: "allow",
          trailingUnderscore: "allow",
        },
        {
          selector: "variable",
          modifiers: ["destructured"],
          format: null,
        },
        {
          selector: "variable",
          types: ["boolean"],
          format: ["strictCamelCase"],
          custom: { regex: booleanNamePattern, match: true },
        },
        {
          selector: "variableLike",
          format: ["strictCamelCase"],
          // DIVERGENCE: exempt the bare `_` placeholder. ts-template dropped the
          // filter ubiquibot's older .eslintrc carried, so `(_, reject) => {}` was
          // reported as not strictCamelCase. `_` is the standard ignored-parameter marker.
          filter: { regex: "^_$", match: false },
        },
        {
          selector: ["function", "variable"],
          format: ["strictCamelCase"],
        },
      ],
    },
  },
  {
    // ---------------------------------------------------------------------
    // DELIBERATE-BY-DESIGN exemptions. These tests assert that insecure input
    // is REJECTED, so the insecure value is the subject under test, not a
    // defect. Narrowly scoped to one file each; suppressing at the call site
    // would hide the intent, and "fixing" the input would delete the test case.
    // ---------------------------------------------------------------------
    files: ["**/tests/web-session_test.ts"],
    // "http://chatgpt.com/" is the same-host scheme-downgrade case the test
    // proves is rejected before any credential-bearing request leaves.
    rules: { "sonarjs/no-clear-text-protocols": "off" },
  },
  {
    files: ["**/tests/authenticate_test.ts"],
    // The fixture must be encrypted with Chromium's real AES-128-CBC + "v10"
    // scheme, because production decryptCookie() only decrypts exactly that.
    rules: { "sonarjs/encryption-secure-mode": "off" },
  },
  {
    files: ["**/tests/sentinel-proof_test.ts"],
    // Patching Date.prototype is the only way to control the timezone: the
    // subject computes it internally with no injectable clock. Object
    // .defineProperty is flagged too, and swapping globalThis.Date would dodge
    // the rule while mutating more. Real fix = inject a clock into the subject.
    rules: { "no-extend-native": "off" },
  },
  {
    // Test doubles legitimately need no-op stubs: `save` callbacks for paths
    // that intentionally do not persist, fake clocks, and so on.
    // no-empty-function exists to catch ACCIDENTALLY empty implementations, so
    // it earns nothing here, and rewriting them as `() => Promise.resolve()`
    // is contortion. Narrower than turning the rule off: empty function
    // DECLARATIONS in tests are still reported.
    files: ["**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-empty-function": ["error", { allow: ["methods", "arrowFunctions"] }],
    },
  }
);
