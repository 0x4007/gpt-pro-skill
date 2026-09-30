---
name: gpt-pro
description: Deep research and hard cognition via gpt-6-pro. Never run automatically, it is expensive; use only when the user explicitly requests GPT Pro or invokes $gpt-pro. Retrieves durable jobs rather than resubmitting them, except a job wedged for a full hour.
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
because a wait or process timed out. The sole exception is a job that has
produced nothing for a full hour, which is wedged rather than slow and carries
standing permission to resubmit; see "Resubmitting a wedged job" below.

This is a ChatGPT conversation workflow, not ChatGPT's separate Deep Research
product mode. It has independent authentication and job state. If ordinary
research is blocked, report the exact blocker and stop that work rather than
treating a submission as a fallback.

Set `SKILL_DIR` to this skill's installed folder.

Submit and retrieve as one owned lifecycle. A helper process detached from a finished command (`nohup`, `&`, `disown`; macOS has no `setsid`) is reaped when the turn ends, so a poller left behind by a turn is not running. Three jobs were stranded or killed this way on 2026-09-30. Keep the poller inside a session that is alive until the answer returns.

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --background "<prompt>"   # prints the job ID in seconds
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --result <job-id>         # keep this session; it returns the answer
```

`--result` is a long poll, not a single check. Run it as a session you keep and read; do not pipe it through `tail`, which hides a failed login or a 429 until it returns. It returns when the answer exists, and past a full hour of silence it stops with the wedge verdict instead of holding the turn for six hours.

`--background --keep-polling` is that lifecycle in one command, and is only safe when the caller is a supervisor that keeps the process alive to the end, not when an agent fires it detached and ends its turn. Whenever you did not hold the process yourself, verify the owner before trusting it: `pgrep -fl "ask-gpt-pro.ts --result <job-id>"` and `--status` showing a rising `pollCount`, two checks about a minute apart.

Ending a turn with a pending job is allowed only as an explicit handoff: leave the job ID, the `--status` output, and the exact resume command (`--result <job-id>`) in task state, and say the job is unretrieved. The next owner resumes that job; it never resubmits unless the wedge rule applies. Before starting an owner, check for a live one; the per-job lock serializes pollers, but a second owner is invisible work, so never stack them.

`--jobs` and `--status` name the failure states, and the label is the instruction: `UNRETRIEVED` (never polled) run `--result`; `STALLED` (no poll for 10+ min, owner likely dead) resume with `--result`; `RATE-LIMITED` honor the cooldown and resume, never resubmit; `WEDGED` (silent past a full hour) apply the wedge rule below. Never end a turn leaving `UNRETRIEVED` or `STALLED` unactioned.

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

A job is retrievable for six hours after submission. Generation continues on the server, so hold each waiting command in a live session and keep its handle. Retrieval never submits the prompt again for a job that is still generating. Completed results are cached and can be reread without network access. A job that has produced nothing for a full hour is the one exception, described under "Resubmitting a wedged job" below. Local tests: `deno test --allow-read --allow-write "$SKILL_DIR/tests/"`.

## Retrieval cadence

A job with `pollCount: 0` that is older than a few minutes has no retrieval owner
and is stranded, not dead: generation continues on the server and only a
retrieval is missing. `--jobs` and `--status` label this as `UNRETRIEVED`; never
resubmit such a job, retrieve it.

`--result` and `--watch` are long polls, not single checks. They take the
per-job lock, poll internally (every 5 s for the first six attempts, then every
30 s), and return as soon as the answer exists. Hold them in a session that
stays alive for the whole wait; never detach them, and never end that session
while the job is pending. Their output is the only place a failed login or a 429
surfaces before the wait ends, so read it rather than piping it away. A silent
job that passes the wedge floor stops with the wedge verdict; act on it instead
of restarting the poll. `--watch`
waits on every pending job rather than a chosen one, so prefer
`--result <job-id>` whenever more than one job is outstanding.

Keep one retrieval owner per job, keep one pending job by default, and resume
the same job after an interrupted wait rather than resubmitting it merely
because the wait ended. On HTTP 429, honor the saved cooldown and Retry-After
and check locally with `--status`. Do not probe live repeatedly, or infer a
safe rate from a weekly ChatGPT allowance. The one case that does authorize a
new submission is a job that has produced nothing for a full hour: it is wedged,
not slow, and waiting longer cannot fix it.

Manual timing is a fallback for when no retrieval owner is running. As measured on 2026-09-17, completed jobs ran a median 15.6 min, p90 19.5 min, max 20.2 min, with the spread close to flat, so roughly half are still running at the median. A first check near 12 min catches the fast third; then check every 60 s. Check with `--status`, which is a local file read using no network; never point the check-in schedule at `--result`, which retrieves over the network on each poll. Past about 22 min, suspect an authentication or retrieval fault rather than slowness, because a working long poll and a wedged one look identical. The CLI stops a silent poll at the wedge floor, so treat that verdict as the fault signal rather than waiting again. Those figures describe one account and machine; re-measure locally rather than treating them as universal.

## Resubmitting a wedged job

A job that has produced no node text for a full hour is wedged. You have standing permission to resubmit its prompt as a new job without asking first. The CLI computes this state for you: `--status` prints the `WEDGED` verdict once a pending job passes the floor with no answer, and `--result` stops after a bounded recheck past the floor rather than polling for six hours. The hour is a floor, not a deadline to act at: it exists because a working long poll and a wedged one look identical, so elapsed time is the only signal that separates them, and `--timings` uses that same one-hour threshold to call completed jobs abandoned rather than slow.

Resubmitting requires the job to have produced **nothing**, not merely to be old.
Check both before you act:

1. `--status <job-id>` reads the local record with no network. A job whose
   `status` is still `pending` after an hour with a rising `pollCount` is the
   wedged case: it is polling a conversation that will never yield, because the
   server finished or dropped the turn long ago.
2. Read the job file and confirm there is no answer data. A job that produced
   nodes but no final answer is still generating, and resubmitting it wastes an
   attempt and can duplicate a turn that is about to land.

A job in this state is safe to abandon: nothing is lost, because it has nothing
to lose. Keep its record rather than deleting it, so a later reader can see that
the prompt was submitted twice and why.

Measured on 2026-09-30, which is why this section exists. One job ran to
`pollCount` 451 over 10.6 hours with no answer text; every signal said healthy
except the answer that never came. Quota was not the constraint (four local
attempts against an allowance of 200). That is the shape of a wedged job, and
the reason a caller needs permission to stop waiting.

Resubmitting costs a model turn, so do it once, with the original prompt
unchanged, and treat a second wedge as a fault to report rather than a prompt to
send again.

Run `--timings` to re-measure from saved job records. It reads local state only
and spends no submission or model turn. It reports the sample it used and flags
completed jobs that exceeded an hour, which means retrieval was abandoned rather
than generation was slow. Durations span submission to recorded answer, so they
approximate the wait a caller experiences, not server generation time. Early
records predate the current upload path and should be excluded with
`--since YYYY-MM-DD` before comparing. The six-hour figure noted above is how
long a job stays retrievable, not how long it generates, so a result appearing
hours later is an abandoned retrieval rather than a slow model.
