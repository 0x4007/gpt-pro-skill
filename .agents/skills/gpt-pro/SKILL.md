---
name: gpt-pro
description: Use only when the user explicitly requests GPT Pro or invokes $gpt-pro; retrieve durable gpt-6-pro research jobs without resubmitting.
---

Use this skill only when the user explicitly asks for GPT Pro or types
`$gpt-pro`. Research, planning, reviews, and blocked work do not authorize a
submission. One explicit request authorizes one submission unless the user
states a larger budget. Check saved jobs and reuse completed answers first.
Never resubmit a prompt because a wait or process timed out.

Set `SKILL_DIR` to this skill's installed folder.

Submit and wait for the answer:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" "<prompt>"
```

For a complex question, submit in the background, keep the job ID, and continue
independent work:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --background "<prompt>"
```

Then retrieve that job, or all pending jobs, through the agent's background
process tool:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --result <job-id>

deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --watch
```

`--jobs` lists local jobs and `--status <job-id>` inspects one without polling.
Prompts may be piped on stdin. Place `--state-dir /absolute/path` before the
command to override private state, which defaults to `~/.local/share/gpt-pro/`.

Sign in on macOS when `--auth-check` fails:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write \
  --allow-run=/usr/bin/security --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/authenticate.ts"
```

It reads the existing ChatGPT sign-in from a local browser profile and saves it
to owner-only private state; macOS may show a permission prompt. If no valid
session is found, ask the user to sign in to ChatGPT in their browser and rerun
the command. Never read tokens or cookies into agent context.

A job is retrievable for six hours after submission. Generation continues on the
server, so run waiting commands in the background and keep their handle.
Retrieval never submits the prompt again. Completed results are cached and can
be reread without network access. Local tests:
`deno test --allow-read --allow-write "$SKILL_DIR/tests/"`.
