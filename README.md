# Browser-free GPT Pro skill

Ask `gpt-6-pro` through an authenticated ChatGPT web session using Deno. Submit
complex questions, continue other work, and retrieve each completed answer by
its durable job ID. No browser runtime is used.

This is an experimental integration with private ChatGPT endpoints. You need
your own account with access to the model and a valid web-session snapshot.
Private endpoint and SDK changes can break it.

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

**On macOS, sign in to ChatGPT once in your normal browser, then let the agent
run:**

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write \
  --allow-run=/usr/bin/security --allow-net=chatgpt.com \
  ~/.agents/skills/gpt-pro/scripts/authenticate.ts
```

The command reads only ChatGPT sign-in, device, and integrity cookies from a
local browser profile through macOS Keychain. It obtains the access token and
current client metadata over HTTPS, checks authentication, and saves it locally.
It launches no browser, captures no traffic, and prints no credentials. macOS
may ask for Keychain access. Multiple signed-in profiles require a selection.

Brave on macOS is live-verified. Chrome, Chromium, and Edge are implemented but
not live-tested. Native bootstrap on Windows/Linux and alternative browser
install locations are not implemented. Users without an existing ChatGPT session
must sign in once; the helper cannot create credentials or complete MFA.

Private state lives in `~/.local/share/gpt-pro/`, independent of installation.
Directories use mode 0700 and files 0600. Near-expiry or expired access tokens
renew automatically through the stored ChatGPT session cookie, without browser
access. Revoked or expired sign-in cookies require signing in again and
rerunning the command. Renewal rejects account changes and never retries a model
request.

This remains an experimental private-endpoint integration. There is no supported
OAuth/device-code flow for this helper, and a successful authentication check is
not proof that a model submission will be accepted. See
[setup and platform limits](.agents/skills/gpt-pro/references/setup.md).

## Research routing

The skill requires an explicit user request for GPT Pro. Generic research, deep
research, planning, reviews, and stalled work do not trigger it.
`allow_implicit_invocation: false` disables automatic skill selection in Codex.
It uses the GPT Pro conversation workflow, not ChatGPT's separate Deep Research
product mode. Ask for primary-source URLs and verify important claims.

Installing the skill does not edit another developer's global instructions. For
the same preferred routing, add this optional rule to your own AGENTS.md:

> Use gpt-pro only when the user explicitly requests GPT Pro. One request
> permits one submission unless the user specifies a larger budget. Follow-up
> calls need explicit authorization or remaining batch allowance. Recurring use
> needs a maximum call count and end time. Reuse saved jobs and completed
> answers, keep one pending job by default, and do not submit extra probes
> during throttling. Use official documentation, manual search, or another
> authorized research tool for ordinary research. Retain authorization, call
> count, and job ID in handoffs.

These are agent workflow rules, not an account-wide runtime enforcement layer.
The CLI cannot establish user intent. Existing sessions must load the new rules;
older unbounded recurring instructions need a bounded replacement before their
next submission. Retrieval of an already authorized job remains allowed.

## Usage estimates

The CLI prints a structured usage estimate on stderr during submission,
authentication checks, and job inspection or retrieval. Answer text and JSON on
stdout stay unchanged. Personal Pro $200 and Pro $100 subscriptions are detected
from the authenticated account; other plans report an unknown allowance. The
published allowances verified on September 6, 2026 are 200 GPT-6 Pro messages
per week for Pro $200, and 50 per week shared with Sol Pro for Pro $100. See
[OpenAI's model limits](https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt).
These published limits can change.

The estimate counts saved submission attempts, including uncertain or rejected
attempts, not confirmed billed messages. Polling and cached rereads add no
attempts. Manual ChatGPT use, other installations, deleted jobs, and other
models sharing an allowance are not counted. There is no provider-reported
remaining balance or Pro reset date. The **local planning week** starts at the
earliest saved attempt and repeats every seven days; it is not the provider's
quota week.

After the first 24 hours, usage ahead of a linear weekly pace produces a gentle
advisory. For example, 30 local attempts after 24 hours on the 200/week tier
exceed the expected 28.57 and project to 210/week. Reaching the local allowance
also produces an advisory during the first day. Agents should mention a new
advisory once in their next update, avoid repeated reminders in that update, and
suggest spacing optional requests or reusing saved answers. The estimate never
blocks an authorized request and does not replace explicit invocation rules.

Subscription checks use one read-only account request, cached for six hours in
an owner-only, account-isolated file beside the jobs directory. Concurrent
checks share a lock. A recent recorded HTTP 429 suppresses an extra tier lookup.
Existing `--auth-check` can populate or refresh an expired cache without a model
submission; status and cached-result reads use only local data. An empty job
list has no account estimate. Stale or unavailable subscription data is labeled.
HTTP retrieval throttles are separate from model message allowances.

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

For an explicitly authorized batch, submit each question in background mode.
Otherwise combine related questions into one submission. Each command prints its
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

All 42 offline tests pass. Live verification covers the normal CLI, two
concurrent jobs, offline cached rereads, and a GitHub-installed copy running
outside the repository. The installed copy completed a source-backed research
request with verified `gpt-6-pro` metadata, exact message matching, and three
`web.run` calls. The plugin catalog is recognized by Codex; the tested local
installation uses the standalone skill. Six-hour expiry and resumption are
tested with a simulated clock; this is not a six-hour live soak test. See
[diagnostic findings](.agents/skills/gpt-pro/diagnostics/README.md).
