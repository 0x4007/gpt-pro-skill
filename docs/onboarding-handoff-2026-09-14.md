# GPT Pro browser-session onboarding handoff

Prepared 2026-09-14. Role now: planning facilitator. Execution role: direct
implementer, one writer. This is a public skill feature, not repair through the
owner's personal Mac. No implementation or model query was performed for this
handoff.

## Objective and accepted decisions

Provide one user-facing authentication flow for the publicly distributed
gpt-pro skill across macOS, Linux, and Windows. Prefer discovering an existing
signed-in browser and obtaining only its ChatGPT authentication cookies using
normal, authorized OS credential access. The user prefers no browser extension,
no manual token copying, and no OS-specific setup choices in the common flow.

The intended experience is: connect ChatGPT, select a profile only if needed,
approve a normal credential-store prompt if needed, then receive a verified
connected result. Platform-specific adapters are internal implementation details.

Do not equate a uniform interface with universal cookie access. Browser
protections and absent browser sessions are real constraints. If an environment
cannot meet the contract through normal access, identify the exact boundary and
resolve the required alternative with the owner; do not silently weaken the
contract or claim that an unsupported error constitutes successful onboarding.

## Canonical Goal Identity

- Canonical plan path and goal identifier: /home/codex/repos/0x4007/gpt-pro-skill/docs/onboarding-handoff-2026-09-14.md
- Goal slug: onboarding-handoff-2026-09-14
- Hash suffix: g008d95ace3
- Canonical worktree name: onboarding-handoff-2026-09-14-g008d95ace3
- Repository root: /home/codex/repos/0x4007/gpt-pro-skill
- Canonical worktree path: /home/codex/repos/0x4007/gpt-pro-skill/.codex-worktrees/onboarding-handoff-2026-09-14-g008d95ace3
- Exact branch: codex/onboarding-handoff-2026-09-14-g008d95ace3
- Base ref: origin/main
- Exact base SHA: affffde4431226bc96965f521d3b7331036017ab
- Lane state: planned; the next implementer creates it after reconciliation.
- No module lanes or delegation are defined; shared authentication work is serial.
- This path-derived identity is fixed. Do not rename or regenerate it.

Goal: Use canonical worktree name onboarding-handoff-2026-09-14-g008d95ace3 at /home/codex/repos/0x4007/gpt-pro-skill/.codex-worktrees/onboarding-handoff-2026-09-14-g008d95ace3 on branch codex/onboarding-handoff-2026-09-14-g008d95ace3; read /home/codex/.codex/AGENTS.md and /home/codex/repos/0x4007/gpt-pro-skill/docs/onboarding-handoff-2026-09-14.md in full, then act as implementer to deliver and verify platform-agnostic GPT Pro browser-session onboarding without an extension or manual token copying, preserve browser protections and existing jobs, complete the required GitHub delivery loop, and never switch the canonical branch or worktree.

## Current state and evidence

Verified locally on 2026-09-14:

- The repository is on main at the base SHA above, equal to remote main.
  There was one worktree, no open PRs, and no implementation changes.
  Writing this plan adds one untracked documentation artifact.
- The installed copy is /home/codex/.agents/skills/gpt-pro. It is outside Git
  and differs from the current repository. Its long setup reference is absent
  from the newer repository, whose README and SKILL.md are shorter. Implement
  in the repository, not by overwriting it with the installed copy.
- Installed ask-gpt-pro.ts --auth-check failed with:
  "ChatGPT session has expired or was revoked; sign in once, then run authenticate.ts".
  This is evidence for the saved local session, not every browser profile.
  The check submitted no model prompt. Do not retry the same failed session
  until a relevant prerequisite changes.
- Repository scripts/authenticate.ts rejects non-darwin hosts in candidates().
  It scans standard Chromium profile paths, uses node:sqlite read-only,
  /usr/bin/security and macOS v10 cookie decryption. The existing implementation
  accepts database versions 23/24 and rejects other protection formats.
- The existing cookie allowlist is ChatGPT session-token chunks, oai-did,
  and __Secure-oai-is. sessionFromCookies obtains a web session and client
  metadata; verifyAndSave checks /backend-api/models before saving.
- renewWebSession uses the saved cookie, serializes writes, rejects account
  changes, and preserves old state on failure. Preserve these guarantees.
- Private state is ~/.local/share/gpt-pro by default, with existing
  --state-dir support. Job IDs, records, account bindings, and cached answers
  must survive onboarding and installation updates.
- Personal two-hop SSH reached the Pi but m1.local did not resolve; the last
  known Mac IP timed out on port 22. This is not a feature prerequisite and
  must not become a hard-coded public onboarding dependency.
- No fresh unit tests, browser onboarding, cross-platform live checks, or Pro
  submissions were run in this planning task.

Primary code paths relative to the repository:

- .agents/skills/gpt-pro/scripts/authenticate.ts: discovery, credential access,
  session creation, renewal, verification, command entrypoint.
- .agents/skills/gpt-pro/scripts/state.ts: paths, private state permissions.
- .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts: auth-check/import and CLI routing.
- .agents/skills/gpt-pro/scripts/session.ts: web-session transport and persistence.
- .agents/skills/gpt-pro/tests/authenticate_test.ts, setup_test.ts,
  web-session_test.ts, jobs_test.ts: relevant existing regression coverage.
- README.md and .agents/skills/gpt-pro/SKILL.md: public onboarding instructions.
- scripts/verify.sh, deno.json, package.json: existing delivery checks.

## Required references and source boundaries

Before edits, read the current /home/codex/.codex/AGENTS.md, decisions.md,
project-workflow.md, git-coordination.md, deno.md, and research.md under
/home/codex/.codex/agents, plus any newly present repository instructions.
Before tests, read test-evidence.md; before review, read pr-review.md.
Read the actual installed gpt-pro skill for auth and submission boundaries.

Use openai-docs for OpenAI research and the routed browser skill for any
browser interaction. Read any applicable platform guidance before remote work.
Do not use an unavailable browser skill as permission to improvise interception.

Sources inspected during this session:

- https://developers.openai.com/codex/auth documents Codex browser/device-code
  login and remote-host methods. It does not establish that Codex credentials
  can authenticate this skill's ChatGPT web conversation transport.
- https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html
  describes Keychain, Linux system wallets, and Windows application-bound
  encryption introduced in Chrome 127. It explicitly says another application
  fails the application-identity check.

Refresh current platform documentation before choosing adapters. The prior
assistant's suggestion that normal credential access works for all browsers
was too broad. Do not assume Windows application-bound cookies can be decrypted
by an ordinary external process, or that legacy cookie formats cover current
browser releases.

## Scope and implementation contract

Own only the onboarding change and its necessary tests, docs, and packaging.
Keep Deno/TypeScript and reuse the existing authenticate.ts entrypoint and state
interfaces. Do not add a new environment variable, secret, argument, or flag
without the owner's approval. Required existing-command Deno permissions must
remain explicit and as narrow as the verified implementation permits.

Use one coordinator with capability-based platform adapters:

1. Read the saved session and use valid credentials or normal renewal first.
2. When sign-in is needed, discover candidate browser profiles through bounded,
   known paths and metadata; do not decrypt all discovered profiles.
3. If exactly one eligible profile exists, use it. If several exist, show only
   browser/profile labels and require selection; never guess the account.
4. Read only the allowed ChatGPT cookies through supported credential access.
   Do not collect saved passwords, other sites, browsing history, HAR files,
   broad browser databases, or raw browser network traffic.
5. Build and verify the session with the existing first-party auth functions.
6. Atomically save verified state, report credential-free success, and release
   resources. Preserve prior state if any stage fails.
7. Resume existing jobs by their IDs. Never submit a replacement research query
   as part of login, recovery, migration, or validation.

Preserve the proven macOS behavior as an adapter, not a second legacy public
flow. Remove the unconditional macOS-only routing once working capability
routing replaces it. Do not generalize unrelated runtime code.

Candidate internal outcomes should distinguish connected, profile selection
needed, sign-in needed, credential access denied/locked, unsupported protection,
and no local browser. Make each actionable without printing secret values.
Noninteractive execution must fail promptly with a useful next step when it
cannot obtain a required selection or OS consent; do not hang on stdin.

For Windows and Linux, establish exact browser/version/store support before
implementation. Use normal documented credential-store APIs and OS consent.
Locked stores, unavailable desktop sessions, application-bound encryption,
unknown formats, and permission denial must stop safely. Do not disable browser
encryption, request administrator access to defeat it, inject into a browser,
alter security policies, bypass a lock, or copy a whole profile to evade access
controls. Verify Windows private-state ACL behavior rather than assuming POSIX
mode arguments provide Windows user isolation.

## Headless and protected-browser boundary

A headless host without a signed-in browser has no local ChatGPT cookies.
Platform-neutral onboarding must explain this in terms of available capability,
not tell everyone to use a Mac or the owner's SSH route.

The intended remote path is the same helper on a browser-equipped computer,
followed by explicit pairing to a user-selected, trusted remote destination.
Before implementing transfer, present the concrete sender, recipient, transport,
account binding, and credential storage behavior for approval. No hosted relay,
public credential endpoint, background sync service, or automatic cross-host
copy is authorized by this handoff. Reuse an established secure transport where
appropriate; keep cookies out of chat, argv, logs, and pairing links.

If application-bound browser storage prevents direct discovery, investigate a
normal user-controlled sign-in in a dedicated browser context. Do not silently
launch remote debugging against the user's main profile or invent an OAuth
grant. Present the specific alternative if it materially changes setup or
requires new dependencies/interfaces. An extension and API-billed model
replacement are not the accepted default. Keep the requested gpt-6-pro transport
unchanged; login work is not permission to change its Sentinel implementation.

The first execution checkpoint must determine whether these constraints permit
a coherent implementation on the intended hosts. If not, report the concrete
blocker and the smallest decision needed. A feasibility blocker does not
justify insecure extraction or a false platform-support claim.

## Execution order and acceptance

Use one writer throughout. These are serial phases, not delegable modules.

1. Reconcile the recorded repository state, existing worktrees, branches and
   matching PRs. If path and branch are free, create the exact canonical lane
   from the exact base SHA. A mismatch is a collision, not permission to choose
   another lane. The plan remains at its fixed original path; copy it unchanged
   into the canonical checkout for the delivery commit. Preserve the original
   planning artifact.
2. Complete a bounded capability investigation. Record actual browser/version,
   OS credential API, access requirements, and current protection formats.
   Determine available live test hosts without scanning unrelated home files
   or relying on the owner's Mac. Resolve material remote/protected-browser
   choices before their dependent implementation.
3. Deliver the smallest end-to-end local onboarding slice through the real
   authenticate.ts command and read-only auth-check. Keep profile selection,
   errors, preservation, and renewal within that same user flow.
4. Extend the same contract to the remaining viable platform adapters and the
   approved remote path. Record limitations per tested combination.
5. Update the public instructions so an agent starts with capability discovery,
   handles sign-in repair, and never declares Linux unsupported solely by OS.
   Distinguish unsupported browser protection from unsupported operating system.
6. Run the focused checks and real acceptance below. Then perform the existing
   repository delivery checks, commit the focused change, push this branch,
   open/reuse its PR, run the bounded review procedure, wait for required CI,
   and merge when the required gates pass.
7. Update the user's installed standalone copy from the accepted canonical
   artifact, preserving any local edits and all private state. Inspect for
   active helper processes before replacement. Verify the installed command
   outside the repository; do not claim user auth repaired until it succeeds.

Acceptance matrix:

| Surface | Required evidence |
| --- | --- |
| Local onboarding | Real eligible browser profile, normal OS consent if needed, authenticate.ts success, then independent auth-check with authenticated=true and no model submission |
| Profile ambiguity | Two candidate fixtures or profiles require explicit selection; cancellation saves nothing |
| Missing/revoked login | Clear sign-in action; no repeated failed network calls; retry succeeds only after login changes |
| Storage/protection failure | Denied, locked, unknown and application-bound cases preserve browser and prior private state and do not leak fixture secrets |
| Renewal/account identity | Valid saved session avoids discovery; expiry uses normal renewal; changed account is rejected without replacement |
| Jobs/install | Existing job files remain unchanged; a cached result remains readable after install; old jobs are not resubmitted |
| Platform support | Exact OS/browser/version and executed outcome for each claimed combination; fixtures alone are not live support |
| Headless pairing | If approved, verified destination and account, encrypted transport, successful remote auth-check, and no credentials in output; otherwise report this acceptance item blocked |
| Package | Same installed authenticate.ts entrypoint and accurate permissions/docs outside the repository |
| Pro transport | Unchanged; model eligibility and actual submissions are explicitly NOT TESTED by this auth task |

Run targeted regression coverage for real auth risks: profile selection,
cookie scope, locked/unknown store behavior, state preservation, account binding,
expiry, and secret-free errors. Avoid broad new tests unrelated to onboarding.

Use /home/codex/.codex/agents/assets/test-evidence/evidence.ts to register and
capture approved test commands from the canonical checkout. Existing commands:
deno test --allow-read --allow-write .agents/skills/gpt-pro/tests/ and
deno check .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts. Include the auth
entrypoint in relevant type checking. The repository's final gate is
sh scripts/verify.sh; inspect its dependency bootstrap before execution.
Retain complete output and result references; do not rerun to filter logs.
A new run needs changed code, a failure correction, or another explicit reason.

For each potentially long operation, state expected result, bounded runtime,
progress evidence, and next action if progress stops. Bound native credential
prompts and network requests. Stop on denied permissions or backend auth,
Cloudflare, Sentinel, quota, and unusual-activity failures; no automatic retries
or model tests to probe around those conditions.

## Authorization and completion

This handoff authorizes planning only in the current turn. Its goal sentence
requests implementation in the next session under the existing delivery rules.
It does not launch a worker, create a worktree, or start an active goal here.

No live GPT Pro prompt is authorized for auth verification. Earlier mention of
the skill was an auth repair request; it does not supply a spare model-call
budget. Auth checks and local tests need no model query.

An OS prompt, browser login/MFA, or explicit profile selection may require the
user. Ask only for the concrete missing action, after completing independent
work. Do not request manual token copying. Distinguish a protected-browser
limitation or missing test host from a repaired authentication result.

Final execution handback must include changed behavior, exact canonical and
merged SHAs, PR URL, installed-artifact status, evidence result references with
host/revision/executed status, support matrix, remaining concrete blockers, and
final clean/dirty state. No production-ready or universal compatibility claim
without the corresponding evidence.

Planning artifact disposition: this handoff is saved and intentionally
uncommitted on the original checkout; no task branch, worktree, implementation
commit, PR, or model job was created. The next session must preserve it and
include its unchanged repository-relative copy with the focused delivery.
