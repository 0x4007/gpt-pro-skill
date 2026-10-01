---
name: gpt-pro
description: Deep research and hard cognition via gpt-6-pro. Never run automatically, it is expensive; use only when the user explicitly requests GPT Pro or invokes $gpt-pro. Durable jobs are resumed, never resubmitted; a wedge does not authorize a replacement.
---

Reach for this skill for deep research and hard cognition: questions needing
sustained reasoning, synthesis across many sources, or a second opinion on a
decision that is expensive to get wrong. Ordinary lookups, routine legwork, and
answers that local code or primary documentation already settle are not worth a
submission; do that work directly.

Submission is expensive, so it never happens on the agent's own initiative. Use
this skill only when the user explicitly asks for GPT Pro or types `$gpt-pro`.
Research, planning, reviews, and blocked work do not authorize a submission. One
explicit request authorizes one submission unless the user states a larger
budget. Combine related questions into one prompt. A follow-up needs a fresh
request or unused batch allowance. Recurring use needs an explicit maximum call
count and end time; clarify old unbounded instructions before another
submission. Do not submit a new review while a previous one is pending or before
using its advice. Honor an explicit tool choice, and never invoke Perplexity or
another provider under these rules.

When no request names this skill, do not silently substitute a cheaper answer
for work that genuinely needs it. Say what the deeper option would add and let
the user decide.

Record the authorizing request, the budget it spent, and the job ID in existing
task state. Plans, handoffs, children, and continuations cannot create or expand
authority, and debugging or mentioning the skill does not authorize a live model
test. Never include secrets or unrelated private context in a prompt. Check
saved jobs and reuse completed answers first, and never resubmit a prompt
because a wait or process timed out. A job that has produced nothing for a full
hour is wedged rather than slow: stop waiting and report it. A wedge never
authorizes a replacement submission by itself; see "A wedged job" below.

This is a ChatGPT conversation workflow, not ChatGPT's separate Deep Research
product mode. It has independent authentication and job state. If ordinary
research is blocked, report the exact blocker and stop that work rather than
treating a submission as a fallback.

Set `SKILL_DIR` to this skill's installed folder.

Submit and retrieve with one foreground process in a managed session you keep:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" "<prompt>"
```

The command prints the job ID before it waits (the job line goes to stderr; stdout carries only the final answer, so a machine caller must read both streams); record it as soon as it appears. Service that session while the job is pending, and read `--status <job-id>`, a local file read with no network. Other work may run between checks; do not end the turn merely because the command yielded. A session is supervised only while it is being serviced: this is not background delivery, and this host reaps detached processes (`nohup`, `&`, `disown`) at turn end. The `--background` and `--keep-polling` switches were removed for that reason and are rejected before submission.

Keep one retrieval process per job. A second retriever exits 10 with `ALREADY_OWNED` instead of waiting: treat that as existing ownership, supervise the live owner, and only after it exits resume once with:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --result <job-id>
```

`--result` is a long poll, not a single check, and the same managed-session rule applies. Do not pipe it through `tail`, which hides a failed login or a 429 until it returns. A job with an answer finishes immediately, a silent job stops at the wedge floor (see "A wedged job"), and the retrieval window closes six hours after submission; restarts, takeovers, and handoffs never extend it. `--watch` is a batch utility for several pending jobs; it skips contended ones.

`--jobs` and `--status` name the failure state, and the label is the instruction: `UNRETRIEVED` (never polled) run `--result`; `STALLED` (no poll for 10+ min, the owner likely died) resume with `--result`; `RATE-LIMITED` honor the cooldown and resume, never resubmit; `WEDGED` (silent past a full hour) stop and report, no automatic replacement. Never end a turn leaving `UNRETRIEVED` or `STALLED` unactioned.

Ending a turn with a pending job is allowed only as an explicit handoff: name a durable successor (a task or the user accepting manual resumption), record its acknowledgment, and leave the job ID, state directory, exact resume command (`--result <job-id>`), current `--status` output, and the retrieval deadline in task state. Say that retrieval is paused; do not claim background monitoring. A successor resumes by ID; it never resubmits, resets deadlines, switches accounts, or deletes locks. Without an acknowledged successor, keep servicing the session instead of ending the turn.

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
unfinished. Windows development and verification are explicitly deferred.
Do not claim universal compatibility or reject Linux solely by OS. On the
Windows-deferred Guacamole/XFCE desktop, Chromium is the Web Browser and
HTTP/HTTPS default using `/home/codex/.local/share/gpt-pro-browser-login`; keep
the locked original profile intact. This is a maintainer environment note and
does not authorize cross-host credential or session transfer.

A job is retrievable for six hours after submission. Generation continues on the server, so hold each waiting command in a live session and keep its handle. Retrieval never submits the prompt again for a job that is still generating. Completed results are cached and can be reread without network access. A job that has produced nothing for a full hour is wedged; see "A wedged job" below. Local tests: `deno test --allow-read --allow-write "$SKILL_DIR/tests/"`.

## Cadence and faults

A job with `pollCount: 0` that is older than a few minutes has no retrieval owner and is stranded, not dead: generation continues on the server and only a retrieval is missing. Never resubmit it; retrieve it.

The CLI owns HTTP polling while you own supervision. It polls immediately, then every 5 s for the first six attempts, then every 30 s, and returns as soon as the answer exists. Keep the process in a session you service, in place; a restart preserves `nextPollAt` and does not restart the initial burst. Output is the only place a failed login or a 429 surfaces before the wait ends, so read it rather than piping it away.

On HTTP 429, honor the saved cooldown and `Retry-After`; check locally with `--status` during the cooldown and do not probe early. Never change accounts to retrieve a job; an identity mismatch is a fault to report, not a workaround. Do not infer a safe rate from a weekly ChatGPT allowance. With more than one job outstanding, keep one retrieval owner each and prefer `--result <job-id>` over `--watch`.

Completed jobs on this account have run a median of roughly 12-15 minutes; `--timings` re-measures from saved records and spends nothing. Durations are submission-to-collection, so a late collection is a retrieval delay, not evidence about generation time.

## A wedged job

A job that has produced no answer for a full hour is wedged. `--status` prints the `WEDGED` verdict past that floor, and `--result` stops after a bounded recheck instead of polling for six hours. `WEDGED` means retrieval stopped; it does not prove that server generation is dead.

Stop and report it. A replacement submission requires unused explicit authorization from the user, either a spare slot in the original request or a fresh one, and it happens once, with the original prompt unchanged. Never submit a replacement on your own initiative. Keep the original record: while its window lasts, a late answer can still be collected with `--result <original-id>`, and a second wedge is a fault to report, not another prompt to send.

Measured on 2026-09-30: one job polled 453 times over 10.6 hours with no answer text; quota was not the constraint. That is the shape of a wedged job and the reason waiting is bounded. Maintainer detail lives in the repository history; it is not an execution rule.

Run `--timings` to re-measure from saved job records. It reads local state only and spends no submission or model turn, and it reports the sample it used. Records that exceed an hour indicate an abandoned or late collection rather than slow generation, so label them as such. Early records predate the current upload path and should be excluded with `--since YYYY-MM-DD` before comparing.
