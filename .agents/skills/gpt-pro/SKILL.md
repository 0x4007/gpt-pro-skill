---
name: gpt-pro
description: Ask the authenticated ChatGPT web backend for a GPT Pro answer through its browser-free conversation endpoints when a task needs the gpt-6-pro model and the normal API path is unavailable.
---

Use this skill only when the user asks for a GPT Pro answer or explicitly
invokes `$gpt-pro`. It sends the requested prompt to ChatGPT's private web
backend through Deno; it does not open or control a browser.

Current status: experimental and not working end to end. In the approved
four-submission batch on 2026-09-05, a browser baseline completed and Deno
successfully submitted a fresh browser-generated request with its browser
session. A helper-generated request sent through the browser returned HTTP 403.
The corrected helper, run through the original Deno command below with only
existing Codex authentication, also returned HTTP 403, "Unusual activity has
been detected from your device," at 13:02 UTC. It exited with code 1 and no
answer. No rejected submission was retried. Quota consumption was not verified.

The helper now derives its client-observation value from its actual
integrity-state cookie instead of inventing a nonce and claiming state is
present. This confirmed protocol correction is insufficient to fix submission.
The remaining cause is unresolved; cookie rotation limits the controlled
comparison. Browser credentials and interception code remain local diagnostics
and are not part of the shipped runtime. See
[sanitized findings](diagnostics/README.md).

The helper polls the conversation after a background handoff for up to 30
minutes and returns only a completed final answer belonging to the submitted
message. Live test B retrieved its completed answer through Deno; focused tests
also reject answers for a different message ID.

Run the helper with the user's prompt as arguments, or pipe the prompt on stdin:

```sh
deno run --allow-env --allow-read --allow-net=chatgpt.com \
  .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts "<prompt>"
```

The helper reads the existing Codex ChatGPT authentication document from
`$CODEX_HOME/auth.json`, or `~/.codex/auth.json` when `CODEX_HOME` is unset.
Never print that file, access tokens, cookies, Sentinel values, or the HAR. The
HAR is request evidence only and must not be sent or bundled with the skill.

The helper fetches the current Sentinel SDK, runs its proof-of-work and
Turnstile VM in a small Node-compatible VM shim, prepares and finalizes
ChatGPT's chat requirements, then sends a `gpt-6-pro` conversation request and
parses the SSE response. Do not replace the model with another model. Do not
retry a rejected request automatically because a GPT Pro turn can consume quota.

If the backend returns an auth, Cloudflare, Sentinel, quota, or unusual-activity
error, report the bounded error text and stop. Do not expose request headers or
dynamic token values. A live prompt submission can consume GPT Pro quota; obtain
explicit user approval before performing a real live prompt test after local
checks are complete.

For local verification, run:

```sh
deno test --allow-read .agents/skills/gpt-pro/tests/ask-gpt-pro_test.ts
```
