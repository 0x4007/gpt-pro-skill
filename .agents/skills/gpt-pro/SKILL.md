---
name: gpt-pro
description: Ask the authenticated ChatGPT web backend for a GPT Pro answer through its browser-free conversation endpoints when a task needs the gpt-6-pro model and the normal API path is unavailable.
---

Use this skill only when the user asks for a GPT Pro answer or explicitly
invokes `$gpt-pro`. It sends the requested prompt to ChatGPT's private web
backend through Deno; it does not open or control a browser.

Current status: experimental; the previous browser-free acceptance failed. A
subsequent enforcement-token correction awaits fresh acceptance. The approved
four-submission diagnostic batch established that Deno can complete a fresh
browser-generated request, while the original helper using Codex credentials
returned HTTP 403. Two confirmed protocol defects were corrected: client
observation now derives from the integrity cookie, and response integrity
updates follow the browser's compare-and-set rule.

The user then approved a separate web-session credential source. The helper now
uses the repository-root .env snapshot described below, with no Codex auth
fallback. A fresh Deno preparation check on 2026-09-05 completed all five
requests with HTTP 200, received four integrity updates, and produced an
observation that matched its current cookie. A diagnostic transport guard
stopped before model submission. This is preparation evidence, not a completed
GPT Pro answer. See [sanitized findings](diagnostics/README.md).

The user approved one further acceptance submission after the credential
cutover. At 14:08 UTC on 2026-09-05, the original Deno CLI at commit `79d4873`
generated fresh requirements and a message ID, then received HTTP 403: "Unusual
activity has been detected from your device." It exited with code 1 and returned
no answer. No browser runtime was used, and no retry was made. Successful
preparation and matching integrity state are therefore insufficient for
acceptance. The remaining request-generation or Sentinel behavior is unresolved;
this does not establish that a browser-free solution is impossible. Do not spend
another submission without a new evidence-backed correction and explicit
approval.

A later comparison with successful test B confirmed that the helper submitted an
unwrapped proof-of-work answer: it called the SDK's low-level generator, which
omits the enforcement-token prefix. The helper now uses the SDK's public
`getEnforcementToken(requirements)` method, matching the browser call path. It
also preserves the browser's timezone-offset sign. Seventeen tests pass. A
guarded preflight at 15:09 UTC completed all five requests with HTTP 200 and
confirmed correctly framed proof shared by finalization and the unsent request.
No model submission was made. These are confirmed corrections, not evidence of a
completed answer; a fresh acceptance submission still requires approval.

The helper polls the conversation after a background handoff for up to 30
minutes and returns only a completed final answer belonging to the submitted
message. Live test B retrieved its completed answer through Deno; focused tests
also reject answers for a different message ID.

Run the helper with the user's prompt as arguments, or pipe the prompt on stdin:

```sh
deno run --allow-read --allow-net=chatgpt.com \
  .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts "<prompt>"
```

The helper reads exactly one `CHATGPT_WEB_SESSION` entry from the
repository-root `.env`, resolved relative to the helper file, independent of the
working directory. It contains single-quoted JSON with `accessToken`, `cookie`,
and `headers`: the approved, consistent ChatGPT web-session snapshot. Required
headers are `oai-device-id`, `oai-session-id`, `oai-client-build-number`,
`oai-client-version`, `user-agent`, `oai-language`, and `accept-language`.
Optional captured headers are `chatgpt-account-id`, `sec-gpc`, and the
`sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-model`, `sec-ch-ua-platform`, and
`sec-ch-ua-platform-version` client hints. Other headers are rejected. The
device cookie must match the device header; a valid integrity cookie is
required. Preserve ordinary duplicate cookies in capture order. Do not include
captured Sentinel challenges or conversation bodies.

Keep `.env` Git-ignored and owner-readable only (mode 0600). Never print tokens,
cookies, Sentinel values, or raw evidence. The runtime uses no browser, HAR,
interception code, new environment lookup, or automatic session refresh. The
snapshot can expire or become invalid; the helper rejects expired tokens and
stops on backend rejection. It restricts authenticated requests to
`https://chatgpt.com` and rejects redirects.

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
deno test --allow-read --allow-write .agents/skills/gpt-pro/tests/
```
