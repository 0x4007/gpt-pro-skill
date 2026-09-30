# Retrieval-lifecycle review: agent orchestration failures, 2026-09-30

Source: GPT Pro design answer, job `14b00b34-7ec3-4abc-84a6-070277763923` (submitted 2026-09-30T21:57:57Z, completed 22:06:31Z), requested by the owner with "ask $gpt-pro-research:gpt-pro to help improve the design and instruction of this tool so there are no more agent orchestration failures". The prompt included the skill text, the CLI surface, and the failure audit.

## Implemented the same day

- One foreground managed-session lifecycle. `--background` and `--keep-polling` are removed and rejected before submission.
- Fail-fast ownership: a second retriever exits 10 with `ALREADY_OWNED`; `--watch` skips contended jobs.
- Bounded silent-wedge stop at a 60-minute floor plus a 2-minute recheck; the job record is preserved for a late answer.
- Immutable six-hour retrieval window computed once from the submission time; restarts, takeovers, and handoffs never extend it.
- `--status`/`--jobs` verdicts: UNRETRIEVED, STALLED, RATE-LIMITED, WEDGED.
- Budget-correct wedge doctrine: a wedge never authorizes a replacement; replacements need unused explicit authorization, happen once, prompt unchanged.

## Not yet implemented (backlog from the design answer)

- Request slots and custodian metadata: `--request <slot>`, `--custodian <task-ref>`, slot deduplication, SUBMISSION_UNKNOWN reconciliation.
- Owner tokens, heartbeats, and owner/phase fields in job records; `owner=`/`heartbeat=`/`next_action=` status footer.
- Full verdict model (COMPLETED/REPLACED/SUBMISSION_UNKNOWN/EXPIRED/ACCOUNT_MISMATCH/AUTH_REQUIRED/BLOCKED/COOLDOWN/SUBMITTING/RETRIEVING/HANDOFF) with `--json`.
- `--handoff <job-id> --to --resume-by --ack` local operation with acknowledgment validation.
- `--retry-wedged <original> --request <slot>` paid replacement path with lineage limits.
- Qualifying wedge evidence (three valid empty snapshots within 180 seconds), `--result --once`, account-level cooldowns, transport retry cap, stderr state transitions.

## GPT Pro design answer (verbatim)

## Decision

**Use one foreground CLI process inside a managed exec session. Never detach it. Keep the agent turn alive by servicing that session; when that is impossible, explicitly pause retrieval and hand the durable job to an acknowledged successor.**

Two distinctions must be explicit:

- **Execution owner:** the one process holding the retrieval lock.
- **Custodian:** the durable task responsible for retrieving and using the answer, including after that process dies.

A PID is not a durable custodian. A saved job ID is not a running retriever.

There is also a hard limit to the requested guarantee: **with no surviving process, service, or scheduled successor, nothing can notice a death or resume retrieval while every agent is stopped.** The enforceable contract is therefore: one active retriever at most; a durable custodian from before submission; bounded detection during an active turn; explicit handoff at a planned turn end; mandatory reconciliation on the next task entry after an unexpected interruption.

Finally, the existing standing permission to resubmit contradicts “one explicit request authorizes exactly one submission.” **The numerical authorization wins.** Wedge detection stops retrieval; it does not manufacture another paid submission. Preserve the one-replacement limit, but require an unused authorization that covers that replacement.

The commands and fields below are the **proposed replacement contract**, not claims about switches already implemented.

## A. Exact replacement text for SKILL.md

Replace the retrieval instructions with this block. `<task-ref>` means a durable task or handoff record, not the current turn or PID. `<request-slot>` identifies one submission explicitly authorized by the user.

````markdown
## Submission and retrieval

One explicit request authorizes one paid submission unless the user specifies
more. Retrieval, process restarts, handoffs, timeouts, and WEDGED verdicts grant
no additional submission budget. Record the authorizing request and budget in
existing task state. Give each authorized submission a stable request-slot ID;
never invent another slot to bypass a failed or interrupted attempt.

Before submitting or resuming this task, run --jobs. Reuse its existing job and
completed answer. Repeating a request slot must recover its existing job, not
submit again.

Use one foreground process inside a managed exec session:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" \
  --request "<request-slot>" --custodian "<task-ref>" "<prompt>"
```

Use a short exec output-yield interval and retain the managed session handle.
Do not use shell backgrounding, nohup, disown, --background, or --keep-polling.
A managed session is supervised only while an agent continues servicing it;
it does not promise execution after the turn ends.

Immediately record the printed job ID, request slot, owner token, state directory,
and managed session handle in task state. The CLI must print the durable job ID
before waiting for the answer.

## Ownership and liveness

Keep one retrieval process per job. While the job is pending, service its managed
session at least every 60 seconds and inspect --status <job-id>. Other work may
run between these checks. Do not end the turn merely because the command yielded.

--status and --jobs are local-only observations, not retrieval requests.
RETRIEVING requires a held lock, fresh owner heartbeat, and an unexpired next
action deadline. A PID, old pollCount, or process launch message is insufficient.

If the process exits or status says UNRETRIEVED or STALLED/UNOWNED, resume the
same job once in a managed session:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --result "<job-id>"
```

ALREADY_OWNED means the second command exited without polling. Supervise the
existing owner; do not launch another waiter. For STALLED/LOCKED, stop the
identified managed session, verify that the lock is free, then resume once.
If the owner cannot be safely identified or stopped, report the blocker.
Never delete a lock file or signal a process using an unverified saved PID.

## Ending a turn

End with the answer, a disclosed terminal fault, or a completed handoff.
A pending job is not completed work.

For a handoff, obtain a named successor's acknowledgment and record its resume
deadline. Persist that acknowledgment before stopping the current managed
session. Once the process has exited, run:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --handoff "<job-id>" \
  --to "<successor-task-ref>" --resume-by "<UTC-time>" --ack "<acknowledgment-ref>"
```

Verify HANDOFF, a free lock, and the exact resume command in the saved handoff.
Tell the user that retrieval is paused; do not claim background monitoring.

The successor must resume within five minutes of handoff and before the saved
retrieval deadline. A future invocation must actually be arranged or the user
must explicitly accept manual resumption. A note saying "next agent" is not an
acknowledgment. If no successor is available and this turn cannot supervise the
wait, do not submit. A job already submitted remains this task's responsibility;
disclose any inability to complete its handoff.

## Cadence and stopping rules

The CLI owns HTTP polling: first poll immediately, then 5-second intervals for
the initial six attempts, then 30 seconds. Restarts preserve nextPollAt and do
not restart the initial burst. Service the exec session independently of this
network cadence.

Honor saved account cooldowns and Retry-After. During cooldown use local status;
do not probe early. Resolve account/authentication faults before resuming the
same job. Never change accounts to retrieve a job.

At age 60 minutes with no observed output for this submission, the CLI performs
a bounded verification: three successful, valid, empty snapshots, at least
30 seconds apart, within 180 seconds. An already completed answer wins on the
first snapshot. Errors, missing permissions, and unrecognized response formats
are not empty snapshots. Any observed output excludes the silent-wedge rule.

WEDGED means this bounded retrieval policy stopped without finding output; it
does not prove that server generation is dead. Stop and report it. A replacement
requires unused explicit authorization, uses --retry-wedged <job-id>, preserves
the prompt unchanged, and is allowed once per original job. Never submit a
replacement using the ordinary prompt command.

Automatic retrieval ends at the immutable submission time plus six hours.
Restarting, taking over, or handing off never extends that deadline. Preserve
partial output and all job records. Cached completed answers remain readable.
````

### What to cut, retain, and relocate

| Current text | Treatment |
|---|---|
| Explicit invocation, budget, secrecy, provider choice, and recording the authorizing request | **Retain.** These are load-bearing. |
| Frontmatter’s “except a job wedged for a full hour” and the authorization paragraph’s “sole exception … standing permission” | **Delete.** Replace with the budget-controlled wedge rule above. |
| “For a complex question, prefer one command…” plus `--background --keep-polling` example | **Delete.** The ordinary submit-and-wait command already owns the lifecycle. |
| Bare-background exception; “through the agent’s background process tool”; “run waiting commands in the background”; “completion event instead of blocking a turn” | **Delete completely.** These are contradictory operational instructions, not harmless wording. |
| Current “Retrieval cadence” and “Resubmitting a wedged job” sections | **Replace completely**, including manual timing advice and claims that an old empty job “will never yield.” |
| September timing distributions, the 451-poll story, quota observations, and abandoned-retrieval history | **Move to maintainer documentation/tests.** They justify the policy but are not execution instructions. |
| Authentication and same-account safeguards | **Retain.** Move machine/browser history elsewhere, while keeping a short pointer to supported-platform documentation. |
| `--timings` explanation | Keep in CLI/reference documentation, but correct its interpretation as described below. |

Also remove background examples from CLI help and any bundled examples. Updating only SKILL.md leaves a second source of conflicting instructions.

## B. Verdict model and exact output

### Separate the facts from the verdict

Do not store one overloaded `status` string as the entire state machine. Derive the verdict from:

**Submission/result state**, **execution-owner health**, **retrieval evidence**, **account/authentication state**, **cooldown**, **handoff**, and **immutable deadlines**.

Every `--status` response should include this footer, even when a higher-priority verdict masks a retrieval problem:

```text
owner=<token|none> pid=<pid|none> lock=<held|free>
heartbeat=<UTC|none> next_action=<UTC|none> custodian=<task-ref>
polls=<attempt-count> successful_polls=<count> last_success=<UTC|none>
output_observed=<yes|no|unknown> retrieval_deadline=<UTC>
```

`output_observed=unknown` is important for old records. Missing fields must not become proof of no output.

Use these constants:

| Setting | Value |
|---|---:|
| Owner heartbeat | Every 10 seconds, including cooldown |
| Stale heartbeat | More than 60 seconds old |
| HTTP request timeout | 30 seconds |
| Overdue next action | More than 15 seconds past its saved deadline |
| Agent supervision check | At least every 60 seconds |
| Silent-job verification threshold | 60 minutes from submission |
| Silent-job verification budget | Three qualifying snapshots within 180 seconds |
| Absolute retrieval deadline | Submission timestamp + 6 hours |

During a request, `next_action` is the request timeout. During ordinary sleep, it is `nextPollAt`; during cooldown, it is the cooldown expiry. Thus a healthy cooldown does not look like a stalled HTTP poll.

### Exact priority order

Evaluate top to bottom. Print the first matching verdict. Braced values below are substitutions, not literal text.

| Priority | Condition | Exact wording and single action |
|---:|---|---|
| 1 | Valid completed answer cached | `COMPLETED {id}: answer cached. ACTION: read --result {id}.` |
| 2 | Replacement job already reserved or created | `REPLACED {id}: replacement={child-id}. ACTION: inspect --status {child-id}; do not create another replacement.` |
| 3 | Submission dispatch may have occurred, acceptance is unresolved, and no healthy submitter remains | `SUBMISSION_UNKNOWN {id}: request acceptance is unknown. ACTION: reconcile the original submission; do not submit again.` |
| 4 | Retrieval deadline reached without a cached final answer | `EXPIRED {id}: automatic retrieval deadline {UTC} reached; server outcome unknown. ACTION: report the retrieval-window fault.` |
| 5 | Known active-account identity differs from the job’s identity | `ACCOUNT_MISMATCH {id}: expected={account-id}, active={account-id}. ACTION: restore the submitting account; do not poll or resubmit.` |
| 6 | Authentication rejected or unavailable | `AUTH_REQUIRED {id}: authentication must be repaired for account={account-id}. ACTION: reconnect that account, then resume this job.` |
| 7 | Retrieval blocked by schema, access, identity, or exhausted transport retries | `BLOCKED {id}: {specific-error}. ACTION: repair this retrieval fault before resuming the same job.` |
| 8 | Persisted qualifying silent-wedge evidence | `WEDGED {id}: three valid empty snapshots after 60 minutes; polling stopped, server outcome unknown. ACTION: report the fault; replacement requires explicit unused authorization.` |
| 9 | Lock held but owner metadata, heartbeat, or next action is unhealthy | `STALLED/LOCKED {id}: owner={token}, reason={reason}. ACTION: stop that identified owner, verify lock release, then resume this job.` |
| 10 | Account cooldown is still in force | `COOLDOWN {id}: no HTTP requests before {UTC}; owner={token|none}. ACTION: wait locally until {UTC}, then reevaluate --status {id}.` |
| 11 | Healthy owner is dispatching the submission | `SUBMITTING {id}: acceptance not yet known. ACTION: supervise the existing managed session.` |
| 12 | Healthy owner is retrieving or verifying a possible wedge | `RETRIEVING {id}: owner={token}, phase={polling|verifying}, next_action={UTC}. ACTION: supervise the existing owner; do not start another.` |
| 13 | No owner; acknowledged handoff has not passed its resume deadline | `HANDOFF {id}: retrieval paused; custodian={task-ref}, resume_by={UTC}. ACTION: the named successor resumes this job by that deadline.` |
| 14 | Legacy job has neither a recorded retrieval attempt nor an owner/handoff | `UNRETRIEVED {id}: no retrieval owner or attempt recorded. ACTION: run --result {id} in one managed session.` |
| 15 | Remaining accepted pending jobs have no owner, including overdue handoffs | `STALLED/UNOWNED {id}: no active retriever; reason={owner-exited|handoff-overdue|legacy-owner-unverified}. ACTION: run --result {id} in one managed session.` |

An overdue handoff is therefore not indefinitely labeled `HANDOFF`. An old job is not automatically `WEDGED`. A high `pollCount` is not evidence of successful access.

`--jobs` uses the same reducer and prints the same verdict/action, one job per entry. Add `--json` containing the verdict, reason, action code, and underlying facts for headless callers; do not make them parse prose.

A second retrieval invocation has a distinct command outcome:

```text
ALREADY_OWNED {id}: owner={token}, pid={pid}, heartbeat={UTC}, custodian={task-ref}.
No polling started; this command is not waiting for the lock.
ACTION: inspect --status {id} and supervise or recover the existing owner.
```

Return a dedicated nonzero exit code, for example `10`. A supervisor must treat that code as **existing ownership**, not as a generic failure to retry.

## C. CLI changes worth building

### 1. Fail-fast locks and observable ownership

Replace blocking lock acquisition with a nonblocking exclusive acquisition. Deno’s current filesystem documentation exposes `FsFile.tryLock(exclusive)`, which returns a boolean rather than waiting; verify that the installed runtime supports it before accepting a paid submission. Do not assume an unverified minimum version. citeturn482417view0

On contention, print `ALREADY_OWNED` and exit immediately. **Do not print a notice and then wait anyway.**

Keep the existing `.lock` file as the stable lock object. Never unlink or replace it during takeover. Require every retrieval path—including `--watch`, wedge verification, and replacement preflight—to participate in the same locking protocol. Advisory locks only coordinate cooperating callers; Apple documents both their advisory nature and the nonblocking `LOCK_NB` behavior. citeturn903263view1

Under the lock, record:

```text
owner.token             random UUID for this ownership instance
owner.pid
owner.startedAt
owner.heartbeatAt
owner.phase
owner.nextActionAt
custodianRef
```

Use atomic state-file replacement and serialized writes. Heartbeats must not overwrite a newer answer, cooldown, or handoff written by another callback in the same process.

`--status` remains network-free, but may briefly probe the lock nonblockingly. It must not rely on the existence of the `.lock` pathname or an old PID to infer ownership.

**Do not build automatic PID killing or stale-lock deletion into the CLI.** Use the exec tool’s identified-session termination for takeover. This also avoids expanding the CLI’s subprocess privileges merely to diagnose owners: Deno documents `Deno.kill`, including signal-zero existence checks, as requiring `allow-run`. citeturn482417view2

A healthy orphan that is genuinely still retrieving should be observed, not duplicated. An unhealthy owner that cannot safely be stopped is an explicit blocker—not permission to launch more processes.

### 2. Journal before dispatch; deduplicate by authorization slot

Require `--request <request-slot>` and `--custodian <task-ref>` for new submissions.

Before any paid request is dispatched, durably reserve the request slot and create the job record, including its UUID, prompt, submitting-account identity, custodian, and timestamps. Then print the local job ID. Once acceptance is known, persist the conversation/submission identifiers and print `SUBMITTED`.

Repeating the same slot must recover the existing job. Reusing it with different prompt content must fail before network submission. For an explicitly authorized batch, each permitted submission receives its own stable slot in task state.

If the process dies after dispatch but before acceptance is recorded, surface `SUBMISSION_UNKNOWN`; do not automatically repeat the paid request. This follows the same distinction HTTP makes between repeatable retrieval and retrying a non-idempotent request whose outcome is unknown. A client should not automatically retry the latter without evidence that repetition is safe or that the original was not applied. citeturn296037view4

This does **not** promise exactly-once remote execution without server-side support. It prevents this CLI from treating an uncertain submission as a free retry.

### 3. Implement the bounded wedge policy in the retrieval loop

Persist the evidence, not merely the label:

```text
successfulPollCount
lastSuccessfulPollAt
outputObservedAt
verification.startedAt
verification.qualifyingEmptySnapshots[]
retrievalDeadlineAt
```

A qualifying snapshot must successfully fetch and parse the correct conversation and identify the specific submitted turn under the submitting account. Prompt text and older assistant turns are not output for this job. Relevant assistant text, artifacts, or other supported output evidence excludes the **silent** wedge rule.

At or after 60 minutes:

1. Fetch normally, respecting the saved cadence and cooldown.
2. If the answer is complete, save it and finish.
3. If relevant output is present, preserve it and continue ordinary bounded retrieval.
4. Otherwise collect three qualifying empty snapshots, at least 30 seconds apart.
5. Persist `WEDGED`, release ownership, and exit when the third qualifies.

The verification batch has a persisted 180-second deadline. Restarting its process does not reset that batch’s timer. A parse failure, inaccessible conversation, or failed request is **not** a qualifying empty snapshot. An inconclusive batch stops with the actual fault instead of continuing silently for hours.

For transport failures, allow at most three consecutive attempts in a retrieval run, with the normal saved spacing, then return `BLOCKED`. Authentication and schema faults stop immediately.

Add `--result <id> --once` for an explicitly requested, single retrieval check, including a late check of a `WEDGED` job. It obeys locks, cooldowns, account checks, and the retrieval deadline. Ordinary `--result` must not silently restart an already-stopped wedge loop.

**Persist the six-hour deadline once.** Check it before every request and sleep, and cap request/sleep duration at the remaining time. Neither another `--result` nor a new owner starts another six-hour window. At expiry, retain partial output without presenting it as a completed answer.

### 4. Make cooldown and authentication visible immediately

Emit state transitions to stderr as they happen, while retaining stdout for the final answer or requested status output. The managed exec session can therefore show a 429 or authentication rejection without waiting for command completion.

Persist cooldown at the **account level**, not only the job level. Other jobs and retrieval restarts must honor it. HTTP 429 does not define one universal scope for rate limiting, and `Retry-After` is optional; it can express either a date or a delay. citeturn296037view5turn903263view2

Use the later of any existing account cooldown and the newly computed cooldown. Preserve the current fallback when a usable header is absent, provided it is bounded and persisted. Do not introduce another independently tuned fallback merely for this redesign.

Keep heartbeats running during cooldown. Do not convert a cooldown, 401, generic 403, 404, or unknown response schema into a wedge or an inferred account mismatch.

### 5. Add a local handoff operation

`--handoff` performs no HTTP requests and launches no process.

After the current managed process has stopped, it nonblockingly acquires the job lock, rereads the latest state, and records:

```text
handoff.to
handoff.ackRef
handoff.createdAt
handoff.resumeBy
custodianRef
```

It rejects missing acknowledgments, invalid deadlines, and live-owner contention. If completion won the race, it reports `COMPLETED` instead.

The acknowledgment belongs in existing task/orchestrator state. The CLI records its reference; it must not fabricate an acknowledgment from the existence of a file or from a caller typing a successor’s name.

### 6. Make replacement a separate, explicitly paid operation

Implement:

```text
--retry-wedged <original-id> --request <authorized-slot> --custodian <task-ref>
```

It must:

- Require the separately recorded, unused authorization.
- Hold the original job’s lock and perform one fresh retrieval check before replacing it.
- Return the original answer if complete, or abandon replacement if output has appeared.
- Copy the original prompt unchanged.
- Reserve the replacement link and new job before dispatch.
- Permit **one replacement per original lineage**, not one replacement per process invocation.

Concurrent or repeated replacement commands must resolve to the same reserved child, including when that child’s submission outcome is unknown. A replacement that itself wedges is a reported fault, not another automatic retry opportunity.

### Explicit decisions on the candidates

| Candidate | Decision |
|---|---|
| **(a) Bounded one-hour wedge check** | **Build**, using successful fresh evidence and an absolute deadline—not local emptiness alone. |
| **(b) Lock-contention notice while waiting** | **Do not build that behavior.** Replace it with a notice **and immediate exit**. |
| **(c) Warning in `--keep-polling` about detached parents** | **Do not build.** Remove both background switches from the supported agent interface; reject them before submission with a migration message. Another warning preserves the trap. |
| More launch recipes, parent-PID heuristics, detach experiments, or a daemon | **Do not build.** They do not satisfy the stated host contract. |

Keep `--watch` only as an explicit batch utility. It must use the same ownership rules per job and skip contended jobs immediately. Do not recommend it for a single-job agent workflow.

Finally, rename timing interpretations to **submission-to-collection duration**. Label suspiciously late collections as such, with generation duration unknown. The records in the prompt demonstrate retrieval delays, but a duration over an hour alone does not establish when server generation ended.

## D. Handoff contract

### Minimum durable record

The local job remains authoritative for the prompt, account binding, conversation ID, polling evidence, and answer. The task handoff needs only:

```yaml
kind: gpt-pro-retrieval-handoff
job_id: "<uuid>"
state_dir: "/absolute/private/state/directory"
skill_dir: "/absolute/installed/skill/directory"

authorization:
  request_ref: "<original authorizing message/task reference>"
  request_slot: "<stable submission slot>"
  spent: 1
  remaining: 0

custody:
  successor: "<durable task or explicitly accepting user>"
  acknowledgment_ref: "<actual acknowledgment>"
  resume_by: "<UTC timestamp>"

execution:
  retrieval_paused: true
  previous_owner_token: "<uuid>"
  previous_exec_session: "<handle>"
  previous_process_exited: true

retrieval_deadline: "<immutable UTC timestamp>"
continuation: "<what to do with the retrieved answer>"
```

Do not copy credentials, cookies, or the whole prompt into the handoff. Do not treat a session handle as transferable across hosts or orchestration contexts.

The exact resume command is:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "/absolute/installed/skill/directory/scripts/ask-gpt-pro.ts" \
  --state-dir "/absolute/private/state/directory" \
  --result "<uuid>"
```

The successor first runs local `--status`, follows its verdict, and runs that command in one managed session when retrieval is permitted.

**The successor must never substitute a fresh prompt submission for this resume command**, reset deadlines, recreate the initial polling burst, switch accounts, delete locks, expand the budget, or assume the previous process survived.

### Starting now when this turn cannot wait for the answer

Use the same managed submit command. Wait only until the durable submission receipt exists—not until the final answer. Then complete the acknowledged pause-and-handoff procedure.

This requires an actual successor arrangement before ending the turn. For a headless orchestrator, that means an existing continuation mechanism with a concrete task and acknowledgment. For a human-managed workflow, it means the user explicitly accepting manual resumption.

**Without either, do not spend the submission merely to return a handle and call it background work.** The stated environment cannot provide that delivery guarantee.

At task reentry, inspect its outstanding jobs before unrelated work. After an unexpected crash, this mandatory entry check is the recovery mechanism; the old turn’s nonexistent final message cannot be part of the contract.

## E. Acceptance checklist

These checks spend no model submission. Use an already-authorized live job for observation/retrieval checks and injected clocks/transports in a separate temporary state directory for failure cases. Never modify live job timestamps to simulate age.

1. **Admission and journaling:** With a fake submission transport, reject missing request/custodian metadata and both background flags before dispatch. Confirm the durable job and slot reservation exist before the fake POST is invoked.

2. **Live ownership:** Run `--status <id> --json` twice during a managed session. Verify one owner token, a held lock, advancing heartbeat, and advancing successful polls when not in cooldown—or a transition to completion.

3. **Contention:** Start a second `--result <id>`. It must return `ALREADY_OWNED` promptly, perform no HTTP request, and leave the original owner unchanged. Inspect the process list to confirm no waiting duplicate remains.

4. **Death and takeover:** Stop only the managed retriever, not server generation. Verify `STALLED/UNOWNED`, then resume the same ID. Confirm unchanged submission time, request slot, budget usage, and retrieval deadline.

5. **Handoff:** Record a real acknowledgment, stop retrieval, and execute `--handoff`. Verify a free lock, no spawned poller, and `HANDOFF`. With a fake clock beyond `resume_by`, verify `STALLED/UNOWNED`.

6. **Cooldown and identity:** Inject 429, rejected authentication, and account mismatch separately. Verify immediate visible verdicts, cooldown survival across restart, no early requests, and zero wedge evidence from these responses.

7. **Late collection versus wedge:** Seed an hour-old unpolled fixture. A completed first snapshot must finish immediately. Three valid empty snapshots must stop as `WEDGED`; partial output, malformed JSON, and inaccessible conversations must not satisfy that rule.

8. **Absolute limits:** Resume the same fixture repeatedly across the six-hour boundary. Verify no deadline extension and no HTTP request after expiry. A cached completed answer must still be readable without network permission.

9. **Submission and replacement deduplication:** Simulate dispatch followed by lost acknowledgment. Repeating the request slot must not POST again. Concurrent authorized replacement attempts must reserve at most one child; an exhausted authorization or second replacement must dispatch nothing.

10. **End-of-turn audit:** For every job started by the reviewed task, require a cached answer, an explicitly disclosed fault with retained custody, or an acknowledged handoff. Reject “poller PID started,” “running in background,” and a bare job ID as completion evidence.

**The central change is not a better background command. It is making ownership, loss of ownership, and deliberate absence of an owner explicit—and ensuring none of those states can silently authorize another paid submission.**
