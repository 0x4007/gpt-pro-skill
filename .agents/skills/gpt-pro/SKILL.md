---
name: gpt-pro
description: Use only when the user explicitly requests GPT Pro or invokes $gpt-pro; retrieve durable gpt-6-pro research jobs without resubmitting.
---

Use this skill only when the user explicitly asks to use GPT Pro or invokes
`$gpt-pro`. A request for research, deep research, planning, a review, or help
with a difficult task does not authorize a Pro submission by itself. Use local
evidence, official documentation, manual web search, or another authorized
research tool for those requests. Never invoke Pro because a task is slow,
blocked, or has reached a timer. Follow topic-specific documentation routing.

One explicit request authorizes one new submission unless the user specifies a
larger call budget. Combine related questions into that prompt. Retain the
authorizing request, budget used, and job ID in the task's continuation state.
An agent-written plan, handoff, subagent request, or goal continuation cannot
create or expand permission. A follow-up submission needs a fresh explicit
request or an unused call in the user's stated budget. Retrieving an existing
authorized job does not use another submission allowance.

Recurring research requires an explicit user request with a maximum call count
and an end time. Do not treat an old hourly instruction as unlimited permission;
clarify an unbounded schedule before its next submission. Do not start a new
review while the previous review is pending or before its advice has been used.
Check saved jobs and reuse relevant completed answers before submitting. By
default, keep one pending Pro job across sessions sharing the private state;
multiple concurrent submissions require the user's explicit batch budget.

Read the `GPT Pro usage estimate` on stderr. If its `nudge` is non-null, gently
mention the local pace estimate in your next user update, once per update;
suggest spacing optional requests and reusing results. Never present this as
OpenAI's remaining quota or actual reset date. The planning week is local,
starts at the earliest saved attempt, and excludes manual ChatGPT use, other
installations, deleted jobs, and other models sharing the allowance. Attempts
can include rejected submissions. Polling does not consume a new local attempt.
Unknown plans have no guessed allowance. Subscription data can be stale;
`--auth-check` refreshes an expired six-hour cache without a model submission.
Advice is not permission for extra calls or a reason to deny an already
authorized request. An HTTP 429 can be a separate retrieval throttle.

This sends a `gpt-6-pro` conversation through Deno, not ChatGPT's separate Deep
Research product mode. Request primary sources, dates, citations, and
uncertainties, then verify important cited claims with source retrieval. Do not
assume a model answer proves live web research. The request runtime is
browser-free; initial authentication can reuse a local signed-in browser profile
without launching the browser or capturing traffic.

For installation and login, read [setup](references/setup.md). Run the script
relative to this SKILL.md's actual installed folder, not a hard-coded repository
path. Reuse the explicit authorization for its one query or stated batch; do not
ask again within that allowance. Merely asking to inspect or debug this skill
does not authorize a live model test.

During an authorized installation or sign-in request, handle authentication for
the user. Check existing state with `--auth-check`; if it is missing, run:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write \
  --allow-run=/usr/bin/security --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/authenticate.ts"
```

Set `SKILL_DIR` to this installed skill folder first. This command performs only
authentication, with no model turn. macOS Brave is live-verified; Chrome,
Chromium, and Edge support is implemented but unverified. It reads only ChatGPT
session, device, and integrity cookies via normal Keychain access and saves the
verified session locally. Keep its credential-free result; never read tokens or
cookies into agent context. Do not ask the user to open DevTools, capture a HAR,
or copy headers. If multiple profiles appear, choose only the user-specified
profile or ask which to use. Let the user handle any OS access prompt or initial
ChatGPT sign-in. Do not bypass a denied permission or a login challenge. Native
Windows/Linux bootstrap is not implemented; report that boundary directly.

Stored access tokens renew automatically before expiry over HTTPS without
browser access. If the sign-in cookie expires or is revoked, ask the user to
sign in again, then rerun the authentication command. Do not repeatedly retry
authentication errors or automatically submit a model test.

Current status: working experimental integration, verified on 2026-09-05. The
normal CLI and two concurrent jobs completed successfully. An official
GitHub-installed copy ran outside the repository and completed research with
verified `gpt-6-pro` metadata, exact message matching, and three `web.run`
calls. All 42 offline tests pass. See
[sanitized findings](diagnostics/README.md) for the earlier failures,
corrections, and acceptance evidence. Six-hour waits are covered by
simulated-clock tests, not a six-hour live soak test. Authentication bootstrap
was verified on macOS Brave on 2026-09-06 with fresh state and a read-only CLI
check. Tests cover automatic renewal and account-change rejection; real
token-expiry rotation and a model submission using the new bootstrap are not
live-verified. Private SDK changes can break the integration.

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
authentication failures stop and preserve the resumable job. Repeated retrieval
HTTP 429 responses use backoff of 1, 2, 4, 8, then 15 minutes, or longer when
`Retry-After` requires it. The job saves `nextPollAt` and `rateLimitCount`;
`--status` exposes both. Restarting retrieval retains the cooldown. Do not
launch extra probes or resubmit a prompt to work around 429. Successful
retrieval resets the backoff. Separate jobs do not share a limiter; avoid
starting more work while retrieval is throttled.

See the [agent workflow](https://github.com/0x4007/gpt-pro-skill#agent-workflow)
for complete commands and recovery semantics. Job records include prompts and
answers: keep `.gpt-pro-jobs/` owner-only and Git-ignored. They never contain
authentication or challenge data.

Set `SKILL_DIR` to this skill's actual installed directory. Run the helper with
the user's prompt as arguments, or pipe the prompt on stdin:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" "<prompt>"
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
HAR reader, or interception code. HOME/USERPROFILE locate private state; the
separate macOS sign-in command also uses HOME to locate browser profiles. The
helper renews near-expiry and expired tokens using the saved session cookie,
preserves existing state on failed renewal, and stops on backend rejection. It
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
deno test --allow-read --allow-write "$SKILL_DIR/tests/"
```
