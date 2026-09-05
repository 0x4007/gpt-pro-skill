---
name: gpt-pro
description: Ask the authenticated ChatGPT web backend for a GPT Pro answer through its browser-free conversation endpoints when a task needs the gpt-6-pro model and the normal API path is unavailable.
---

Use this skill only when the user asks for a GPT Pro answer or explicitly
invokes `$gpt-pro`. It sends the requested prompt to ChatGPT's private web
backend through Deno; it does not open or control a browser.

Current status: a browser-free GPT Pro request completed successfully on
2026-09-05 at 15:32 UTC, using commit `054c3f6`. The Deno helper generated fresh
requirements, submitted once, followed the background handoff, and returned the
exact requested answer. The saved conversation identifies `gpt-6-pro`,
`finished_successfully`, a final channel with `end_turn: true`, and the
submitted user message as its ancestor. No browser runtime was used.

The confirmed corrections derive observation from the integrity cookie, apply
integrity response updates with compare-and-set ordering, preserve an approved
web-session snapshot, and use the SDK public `getEnforcementToken` method
instead of its unframed low-level proof generator. The timezone-offset sign also
matches the browser. Seventeen offline tests pass. See
[sanitized findings](diagnostics/README.md) for the controlled failures and
successful acceptance. This is a working experimental path, not proof of
long-term reliability across SDK changes or session expiry.

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
