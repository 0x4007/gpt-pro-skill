---
name: gpt-pro
description: Ask the authenticated ChatGPT web backend for a GPT Pro answer through its browser-free conversation endpoints when a task needs the gpt-6-pro model and the normal API path is unavailable.
---

Use this skill only when the user asks for a GPT Pro answer or explicitly invokes `$gpt-pro`. It sends the requested prompt to ChatGPT's private web backend through Deno; it does not open or control a browser.

Current status: experimental and not working end to end. The captured HAR ends in a background stream handoff. The helper now polls the conversation after a handoff for up to 30 minutes and returns only a completed final answer belonging to the submitted message. Read-only live validation on 2026-09-05 retrieved a completed answer from an existing conversation and rejected it for a different message ID. One user-approved fresh prompt test on 2026-09-05 at 04:17 UTC reached conversation submission but returned HTTP 403, "Unusual activity has been detected from your device." The helper exited with code 1 and no answer. No retry was made. Quota consumption was not verified.

Run the helper with the user's prompt as arguments, or pipe the prompt on stdin:

```sh
deno run --allow-env --allow-read --allow-net=chatgpt.com \
  .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts "<prompt>"
```

The helper reads the existing Codex ChatGPT authentication document from `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` when `CODEX_HOME` is unset. Never print that file, access tokens, cookies, Sentinel values, or the HAR. The HAR is request evidence only and must not be sent or bundled with the skill.

The helper fetches the current Sentinel SDK, runs its proof-of-work and Turnstile VM in a small Node-compatible VM shim, prepares and finalizes ChatGPT's chat requirements, then sends a `gpt-6-pro` conversation request and parses the SSE response. Do not replace the model with another model. Do not retry a rejected request automatically because a GPT Pro turn can consume quota.

If the backend returns an auth, Cloudflare, Sentinel, quota, or unusual-activity error, report the bounded error text and stop. Do not expose request headers or dynamic token values. A live prompt submission can consume GPT Pro quota; obtain explicit user approval before performing a real live prompt test after local checks are complete.

For local verification, run:

```sh
deno test --allow-read .agents/skills/gpt-pro/tests/ask-gpt-pro_test.ts
```
