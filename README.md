# Browser-free GPT Pro skill

Ask `gpt-6-pro` through an authenticated ChatGPT web session using Deno. Submit
complex questions, continue other work, and retrieve each completed answer by
its durable job ID. No browser runtime is used.

This is an experimental integration with private ChatGPT endpoints. You need
your own account with access to the model and a valid web-session snapshot. The
session does not refresh automatically, and SDK changes can break it.

## Setup

Install Deno, clone this repository, and follow the credential schema in
[SKILL.md](.agents/skills/gpt-pro/SKILL.md). Store your own consistent
web-session snapshot in repository-root `.env`, with mode `0600`. Never share
this file. The repository includes no account credentials.

The helper resolves `.env` and `.gpt-pro-jobs/` relative to its own location,
not the caller's working directory. Keep the repository layout intact.

## Agent workflow

Submit a question and wait for the answer:

```sh
deno run --allow-read --allow-write --allow-net=chatgpt.com \
  .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts "<complex question>"
```

For several questions, submit each in background mode. Each command prints its
job ID on stderr immediately, then a JSON job summary on stdout after the server
hands off generation. Save those IDs before proceeding.

```sh
deno run --allow-read --allow-write --allow-net=chatgpt.com \
  .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts --background "<question A>"

deno run --allow-read --allow-write --allow-net=chatgpt.com \
  .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts --background "<question B>"
```

The remote jobs continue after those commands exit. Retrieve one job, or collect
the pending jobs together:

```sh
deno run --allow-read --allow-write --allow-net=chatgpt.com \
  .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts --result <job-id>

deno run --allow-read --allow-write --allow-net=chatgpt.com \
  .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts --watch
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
`Retry-After` is honored. Authentication errors stop retrieval so the session
can be repaired. Resume with the same job ID after a process interruption, auth
repair, or six-hour timeout. Retrieval never submits the prompt again. Completed
results are cached and can be read without network access or unexpired
credentials.

Use one active retrieval process per job. A second `--result` or overlapping
`--watch` waits for the first process to release its lock; this lock wait is
outside the six-hour polling window. If the first process times out, the second
can begin another window. Use `--status` to inspect a job that already has an
active retrieval process. Different jobs do not share a lock.

Inspect local state without making a model request:

```sh
deno run --allow-read --allow-write \
  .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts --jobs

deno run --allow-read --allow-write \
  .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts --status <job-id>
```

Prompts can also come from stdin. Use `--` before a prompt beginning with `--`.
Submission consumes quota; do not treat a process timeout as permission to
submit again.

## Recovery and privacy

Job records use an owner-only `.gpt-pro-jobs/` directory, atomic snapshots, and
per-job OS locks. Each record includes its own message ID, conversation ID,
account fingerprint, prompt, status, and cached answer. It contains no bearer
token, cookie, or Sentinel proof. Prompts and answers can still be sensitive:
keep this directory private and Git-ignored.

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

Two concurrent live jobs have been submitted and collected successfully, and
cached results have been reread without network access. Six-hour expiry and
resumption are tested with a simulated clock; this is not a six-hour live soak
test. See [diagnostic findings](.agents/skills/gpt-pro/diagnostics/README.md).
