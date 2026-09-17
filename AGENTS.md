# Working on this repo

This repository is the source of truth for the `gpt-pro` skill. Runtime
instructions for agents _using_ the skill live in
`.agents/skills/gpt-pro/SKILL.md`; this file is for agents _maintaining_ it.

## Where guidance belongs

- `SKILL.md` holds how to operate the skill: commands, retrieval cadence,
  failure handling. It loads only once an agent invokes the skill.
- Authorization rules — use only on an explicit request, one request authorizes
  one submission, never resubmit after a timeout — stay in the consuming
  agent's global rules, because they must be visible _before_ the skill loads
  and cannot gate their own invocation.
- Do not restate authorization here to "keep it together". Duplicating a rule
  across both places is how they drift apart.

## The install must stay a symlink

`~/.agents/skills/gpt-pro` is symlinked to this directory. It was previously a
copy, which silently shipped a pre-refactor `ask-gpt-pro.ts` for days after the
module split landed. If an install is ever recreated as a copy, repo edits stop
reaching the agent that runs the skill. Prefer a symlink, as `jev-browser-use`
does.

## Verify before claiming a change works

```sh
deno check .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts
deno test --allow-read --allow-write .agents/skills/gpt-pro/tests/
```

These are local and need no ChatGPT session. They do not prove a live
submission works, because authentication, the conversation API and polling are
all network paths. A change touching submission or retrieval needs a live
submission to be called verified; ask for that authorization rather than
assuming it, since a submission spends real Pro allowance.

## Never leak credentials into context

Authentication reads an existing browser session. `--auth-check` is the
read-only way to confirm sign-in and costs no model turn. Never read tokens or
cookies into agent context, and never print private state.

## Measurements, not folklore

Timing figures describe one account and one machine on one date. Do not commit
numbers as universal advice; measure them with `--timings`, which reads local
job records with no network use. Two traps when interpreting that output:

- Durations span submission to recorded answer, so an abandoned retrieval looks
  like a slow model. `--timings` reports a `stale` count for anything past an
  hour for this reason.
- Early records used an older upload path. Pass `--since YYYY-MM-DD` to exclude
  them before comparing eras.
