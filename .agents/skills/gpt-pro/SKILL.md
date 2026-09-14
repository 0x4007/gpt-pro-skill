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

Connect through the same entrypoint on supported local browser setups:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write \
  --allow-run=/usr/bin/security,/usr/bin/chromium,/usr/bin/google-chrome,/usr/bin/brave-browser,/usr/bin/microsoft-edge,/usr/bin/secret-tool --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/authenticate.ts"
```

It verifies saved authentication or performs normal renewal before browser
discovery. With no saved session it reads only allowed ChatGPT cookies from one
selected browser profile and saves verified state. macOS Keychain or Linux
Secret Service may show a normal permission prompt. Multiple profiles require
an interactive choice. Noninteractive execution never waits for a choice.

On rejection, stop and report the result. After the user signs in again, an
interactive reconnect can use a changed browser sign-in for the same account.
An unchanged login or changed account is rejected without replacing credentials.
Preserve existing jobs and resume by ID; login never authorizes a model submission.
Never read tokens or cookies into agent context or disable browser protections.

Live support: Arch Linux ARM, Chromium 153.0.8010.36, database 24, existing v10
cookies; macOS Brave was verified previously. Linux v11 through Secret Service
has fixture coverage only. Other Chromium-family browser paths are unverified.
Windows, portal-protected storage, native KWallet, and headless pairing remain
unfinished. Do not claim universal compatibility or reject Linux solely by OS.

A job is retrievable for six hours after submission. Generation continues on the
server, so run waiting commands in the background and keep their handle.
Retrieval never submits the prompt again. Completed results are cached and can
be reread without network access. Local tests:
`deno test --allow-read --allow-write "$SKILL_DIR/tests/"`.
