---
name: gpt-pro
description: Use for explicit GPT Pro requests, deep research, and substantial source-backed research through gpt-6-pro with durable background jobs.
---

Use this skill when the user asks for GPT Pro, invokes `$gpt-pro`, requests deep
research, or needs substantial source-backed external research. Prefer it as the
research engine; keep Perplexity as a fallback when unavailable or when the user
requests that fallback. Follow topic-specific official-documentation routing
first, and honor explicit user choices of other tools.

This sends a `gpt-6-pro` conversation through Deno, not ChatGPT's separate Deep
Research product mode. Request primary sources, dates, citations, and
uncertainties, then verify important cited claims with source retrieval. Do not
assume a model answer proves live web research. The request runtime is
browser-free; one-time authentication setup uses the user's browser session.

For installation and login, read [setup](references/setup.md). Run the script
relative to this SKILL.md's actual installed folder, not a hard-coded repository
path. Explicit Pro/research requests authorize the relevant query within their
scope; reuse existing approvals and call budgets instead of asking again.

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
matches the browser. Twenty-eight offline tests pass. See
[sanitized findings](diagnostics/README.md) for the controlled failures and
successful acceptance. This is a working experimental path, not proof of
long-term reliability across SDK changes or session expiry.

The helper persists a private job record before submission and saves the
conversation ID as soon as it arrives. Retrieval polls for up to six hours after
acquiring the per-job lock and returns only an unambiguous completed final
answer belonging to the submitted message. Each job has a unique ID, account
binding, OS lock, and atomic saved state. A later conversation turn does not
hide its result.

For complex questions, use `--background <prompt>`, retain the returned job ID,
and continue independent work. Use `--result <job-id>` to wait for one job or
`--watch` to retrieve the current pending set concurrently with JSON-line
results. Run these waiting commands through the agent's background process tool
and keep its handle. The server generates remotely; no local daemon is
installed. Use `--jobs` and `--status <job-id>` to inspect local state.
Completed results are cached and need no network or credentials to reread.

If the process stops, resume retrieval using the same job ID. Never resubmit
because a wait or process timed out. A job without a saved conversation ID
cannot be safely recovered automatically; report its `uncertain`, `submitting`,
or `preparing` state and inspect conversation history before any new submission.
Transient GET errors and HTTP 404/429/5xx retry within the six-hour window;
authentication failures stop and preserve the resumable job.

See the [agent workflow](https://github.com/0x4007/gpt-pro-skill#agent-workflow)
for complete commands and recovery semantics. Job records include prompts and
answers: keep `.gpt-pro-jobs/` owner-only and Git-ignored. They never contain
authentication or challenge data.

Run the helper with the user's prompt as arguments, or pipe the prompt on stdin:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  <installed-skill-directory>/scripts/ask-gpt-pro.ts "<prompt>"
```

The helper reads exactly one `CHATGPT_WEB_SESSION` entry from the private
state-directory `.env` (default `~/.local/share/gpt-pro/.env`), independent of
the installed helper location and working directory. Prefix the command with
`--state-dir /absolute/private/directory` to override it. It contains
single-quoted JSON with `accessToken`, `cookie`, and `headers`: the approved,
consistent ChatGPT web-session snapshot. Required headers are `oai-device-id`,
`oai-session-id`, `oai-client-build-number`, `oai-client-version`, `user-agent`,
`oai-language`, and `accept-language`. Optional captured headers are
`chatgpt-account-id`, `sec-gpc`, and the `sec-ch-ua`, `sec-ch-ua-mobile`,
`sec-ch-ua-model`, `sec-ch-ua-platform`, and `sec-ch-ua-platform-version` client
hints. Other headers are rejected. The device cookie must match the device
header; a valid integrity cookie is required. Preserve ordinary duplicate
cookies in capture order. Do not include captured Sentinel challenges or
conversation bodies.

Keep `.env` outside Git and owner-readable only (mode 0600). Never print tokens,
cookies, Sentinel values, or raw evidence. The request runtime uses no browser,
HAR reader, interception code, or automatic session refresh. HOME/USERPROFILE
are used only to locate private state. The snapshot can expire or become
invalid; the helper rejects expired tokens and stops on backend rejection. It
restricts authenticated requests to `https://chatgpt.com` and rejects redirects.

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
deno test --allow-read --allow-write <installed-skill-directory>/tests/
```
