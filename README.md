# gpt-pro

A Deno skill that sends a question to `gpt-6-pro` on an authenticated ChatGPT
web session and returns the completed answer by durable job ID. No browser runs
at request time.

## Install

```text
$skill-installer install https://github.com/0x4007/gpt-pro-skill/tree/main/.agents/skills/gpt-pro
```

## Use

```sh
SKILL_DIR="$HOME/.agents/skills/gpt-pro"
```

Sign in on macOS first, using an existing ChatGPT session in your browser:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write \
  --allow-run=/usr/bin/security --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/authenticate.ts"
```

Then submit:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" "<prompt>"
```

| Command                   | Result                                        |
| ------------------------- | --------------------------------------------- |
| `<prompt>`                | Submit once, wait, print the answer           |
| `--background <prompt>`   | Submit once and return a job summary          |
| `--result <job-id>`       | Wait for one job or print its cached answer   |
| `--watch`                 | Retrieve the pending jobs as JSON lines       |
| `--jobs`                  | List local job summaries as JSON              |
| `--status <job-id>`       | Inspect one job without polling               |
| `--auth-check`            | Read-only authentication check; no model turn |
| `--auth-import <file\|->` | Import a session into private state           |
| `--help`                  | Print CLI usage                               |

Private state defaults to `~/.local/share/gpt-pro/` with owner-only permissions.
Override it with `--state-dir /absolute/path` before any command. Job records
hold prompts and answers, so keep them private.

Retrieval polls for up to six hours after submission and never resubmits the
prompt. Resume an interrupted job with the same ID.

## Verify

```sh
deno test --allow-read --allow-write .agents/skills/gpt-pro/tests/
deno check .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts
```
