# Browser-free GPT Pro skill

Ask `gpt-6-pro` through an authenticated ChatGPT web session using Deno. Submit
complex questions, continue other work, and retrieve each completed answer by
its durable job ID. No browser runtime is used.

This is an experimental integration with private ChatGPT endpoints. You need
your own account with access to the model and a valid web-session snapshot. The
session does not refresh automatically, and SDK changes can break it.

## Install and sign in

This repository follows the Agent Skills standard and includes a Codex plugin
manifest/marketplace for GitHub distribution. For local Codex use, ask the
built-in installer:

```text
$skill-installer install https://github.com/0x4007/gpt-pro-skill/tree/main/.agents/skills/gpt-pro
```

The current user-wide skill location is `~/.agents/skills`; the built-in
installer also supports an explicit `--dest` for that path. See
[installation and login](.agents/skills/gpt-pro/references/setup.md) for the
exact installer command and plugin alternative. The package is not listed in
OpenAI's universal public directory.

**Authentication is still a developer setup flow.** Sign in to ChatGPT in a
browser, copy the request headers from a successful models request in DevTools,
then use `--auth-import` and `--auth-check`. The importer validates and stores
your own snapshot without executing copied commands or retaining challenge
headers. The check makes no model request. There is no OAuth/device-code login,
password collection, Codex-login fallback, or automatic session refresh.

Private state now lives in `~/.local/share/gpt-pro/`, independent of repository
and install paths. It contains `.env` and `.gpt-pro-jobs/`. Directories use mode
0700 and files mode 0600. The repository contains no account credentials.
Earlier users can import their repository `.env` and copy completed job records;
see the setup guide. `--state-dir /absolute/private/directory` overrides the
location and removes the need for HOME environment access.

This is a browser-free **request runtime**, not a browser-free login flow. It is
usable by developers comfortable with DevTools; it is not turnkey consumer
onboarding. Use your own account with access to `gpt-6-pro`.

## Research routing

The skill supports explicit GPT Pro requests and deep/substantial research. It
uses the GPT Pro conversation workflow, not ChatGPT's separate Deep Research
product mode. Ask for primary-source URLs and verify important claims. Keep
Perplexity or another research tool as a fallback if Pro is unavailable.

Installing the skill does not edit another developer's global instructions. For
the same preferred routing, add this optional rule to your own AGENTS.md:

> Use gpt-pro for explicit Pro requests and substantial/deep research. Follow
> topic-specific official-documentation guidance first. Use background jobs,
> retain job IDs, verify important cited sources, and keep Perplexity as a
> fallback. Honor explicit user tool choices and existing call budgets.

## Command reference

| Command                                     | Result                                                      |
| ------------------------------------------- | ----------------------------------------------------------- |
| `<prompt>`                                  | Submit once, wait, and print the completed answer           |
| `--background <prompt>`                     | Submit once and return a JSON job summary after handoff     |
| `--jobs`                                    | List local job summaries as JSON                            |
| `--status <job-id>`                         | Read one local job summary without polling                  |
| `--result <job-id>`                         | Resume polling or print the cached answer                   |
| `--watch`                                   | Collect the current pending jobs concurrently as JSON lines |
| `--auth-import <file>` or `--auth-import -` | Import a private session from a file or stdin               |
| `--auth-check`                              | Make a read-only authentication request; no model turn      |
| `--help`                                    | Print CLI usage                                             |

Place `--state-dir /absolute/private/directory` before any command to override
private state. Commands exit 0 on success and 1 on failure. Prompts and answers
may be sensitive; job-list previews and watch output should remain private.

## Agent workflow

Use the actual installed skill directory. For a repository checkout, set
`SKILL_DIR` to `.agents/skills/gpt-pro` instead.

```sh
SKILL_DIR="$HOME/.agents/skills/gpt-pro"
```

Submit a question and wait for the answer:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" "<complex question>"
```

For several questions, submit each in background mode. Each command prints its
job ID on stderr immediately, then a JSON job summary on stdout after the server
hands off generation. Save those IDs before proceeding.

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --background "<question A>"

deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --background "<question B>"
```

The remote jobs continue after those commands exit. Retrieve one job, or collect
the pending jobs together:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --result <job-id>

deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --watch
```

`--watch` takes the current set of pending jobs and retrieves them concurrently,
printing one JSON line per result. Jobs submitted after it starts require a new
watch invocation. Run retrieval using the agent's background process/session
tool, keep its process handle, and continue independent work while it waits.
There is no installed daemon; the remote generation continues independently, and
the retrieval process must run to collect and cache results locally.

Each polling window lasts up to **six hours** after the per-job lock is
acquired. It polls every five seconds initially, then every thirty seconds, with
bounded HTTP requests. Transient read errors and HTTP 404/429/5xx are retried;
repeated 429s back off for 1, 2, 4, 8, then 15 minutes. `Retry-After` can extend
the delay. The job saves the cooldown across restarts and reports `nextPollAt`
and `rateLimitCount` in `--status`. A successful read resets the backoff. Jobs
do not share a limiter, so avoid new work while throttled. Authentication errors
stop retrieval so the session can be repaired. Resume with the same job ID after
a process interruption, auth repair, or six-hour timeout. Retrieval never
submits the prompt again. Completed results are cached and can be read without
network access or unexpired credentials.

Use one active retrieval process per job. A second `--result` or overlapping
`--watch` waits for the first process to release its lock; this lock wait is
outside the six-hour polling window. If the first process times out, the second
can begin another window. Use `--status` to inspect a job that already has an
active retrieval process. Different jobs do not share a lock.

Inspect local state without making a model request:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --jobs

deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --status <job-id>
```

Prompts can also come from stdin. Use `--` before a prompt beginning with `--`.
Submission consumes quota; do not treat a process timeout as permission to
submit again.

## Recovery and privacy

Job records use an owner-only `.gpt-pro-jobs/` directory inside private state,
atomic snapshots, and per-job OS locks. Each record includes its own message ID,
conversation ID, account fingerprint, prompt, status, and cached answer. It
contains no bearer token, cookie, or Sentinel proof. Prompts and answers can
still be sensitive: keep this directory private and Git-ignored.

A submitted request can lose its connection before the server reveals a
conversation ID. Such a job is marked `uncertain` when the error is observed; a
killed process may leave `submitting` or `preparing`. These states never trigger
automatic resubmission. Without a saved conversation ID, the helper cannot
safely recover the result. Inspect the account's conversation history before
deciding whether to submit again.

Answers must be complete final messages whose parent chain reaches the exact
submitted message. Later conversation turns do not hide an earlier job's answer;
ambiguous answers and explicit mismatched model metadata are rejected.

## Verification

```sh
deno test --allow-read --allow-write .agents/skills/gpt-pro/tests/
deno check .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts
deno fmt --check README.md .agents/skills/gpt-pro/
```

All 31 offline tests pass. Live verification covers the normal CLI, two
concurrent jobs, offline cached rereads, and a GitHub-installed copy running
outside the repository. The installed copy completed a source-backed research
request with verified `gpt-6-pro` metadata, exact message matching, and three
`web.run` calls. The plugin catalog is recognized by Codex; the tested local
installation uses the standalone skill. Six-hour expiry and resumption are
tested with a simulated clock; this is not a six-hour live soak test. See
[diagnostic findings](.agents/skills/gpt-pro/diagnostics/README.md).
