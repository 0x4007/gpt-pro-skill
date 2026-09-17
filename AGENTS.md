# Working on this repo

This repository is the source of truth for the `gpt-pro` skill. Runtime
instructions for agents _using_ the skill live in
`.agents/skills/gpt-pro/SKILL.md`; this file is for agents _maintaining_ it.

## Where guidance belongs

Everything about this skill's own use lives in the skill:

- The `description` frontmatter is the routing gate. It is the only text an
  agent sees before loading, so it carries the trigger and the cost warning.
  Writing it loosely is how the skill starts running unasked.
- `SKILL.md` holds authorization, budget, commands, retrieval cadence, and
  failure handling.

Do not restate any of that in a consuming agent's global rules. Globals should
not mention this skill at all, for two reasons: a duplicate drifts from the
original, and a global that describes the skill can make it sound available
without an explicit request, which is the expensive failure we are avoiding.

The only global rules that legitimately reference it are boundary guards owned
by another capability — for example, that this skill is never a fallback for a
blocked worker, and never a silent substitute for a requested tool. Those exist
to stop substitution, not to advertise the skill, and they belong to the
capability enforcing them.

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
