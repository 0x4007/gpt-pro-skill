# Installation and authentication

This skill follows the Agent Skills format: `SKILL.md`, optional
`agents/openai.yaml`, and package-relative scripts/references. It is intended
for a local Codex environment with Deno and filesystem/network tools.

## Install

Ask Codex's built-in installer:

```text
$skill-installer install https://github.com/0x4007/gpt-pro-skill/tree/main/.agents/skills/gpt-pro
```

For a user-wide installation at the currently documented user skill location,
use the bundled official installer with an explicit destination:

```sh
python3 ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo 0x4007/gpt-pro-skill --path .agents/skills/gpt-pro \
  --dest ~/.agents/skills
```

The installer refuses to overwrite an existing folder. Keep private state out of
the installed folder when replacing it during an upgrade. Codex should see the
installed skill on the next turn; restart if it is not discovered.

The repository also includes a plugin manifest and repo marketplace. Add the
catalog and install from the CLI:

```sh
codex plugin marketplace add 0x4007/gpt-pro-skill
codex plugin add gpt-pro-research@gpt-pro-skills
```

You can also use `/plugins` or the desktop plugin browser to install
`GPT Pro Research`. This is GitHub marketplace distribution, not a listing in
OpenAI's universal directory. Choose standalone installation or plugin
installation to avoid duplicate skill entries. Plugin packaging does not provide
an OAuth login or install Deno.

## Upgrade safely

The standalone installer refuses to overwrite an existing skill. Before an
upgrade, finish active local processes or stop retrieval and retain their job
IDs. Preserve local edits if you made any, move the old installed skill folder
to a backup outside the skill-discovery directory, and rerun the installer.
Check the new copy with `--help`, `--auth-check`, and a cached `--result`. The
private state directory remains in place; do not copy credentials into the new
code folder or submit prompts again to migrate jobs.

For plugin installs, refresh the marketplace and use the plugin manager's
update/reinstall workflow. Do not install the standalone and plugin versions
simultaneously unless you deliberately want duplicate skill entries.

## Sign in and import a session

There is no supported OAuth/device-code login built into this helper. A Codex
login or an OpenAI API key is not a substitute for the ChatGPT web-session
snapshot this private-endpoint integration uses. Each developer must use their
own ChatGPT account with access to `gpt-6-pro`.

1. Install Deno and sign in at `https://chatgpt.com` in your normal browser.
2. Open browser developer tools, select Network, and reload ChatGPT.
3. Find a successful request to `https://chatgpt.com/backend-api/models`. Copy
   its **request headers** (not response headers, a HAR, cURL, or JavaScript).
   The capture must include Authorization, Cookie, User-Agent, device/session
   IDs, client build/version, and language headers from the same request.
4. Save the copied headers in an owner-only local text file, or pipe them from
   the clipboard to stdin. Never paste them into a chat, issue, shell argument,
   PR, or shared log. If the browser omits sensitive headers from the copy,
   inspect the request locally and include them; do not combine different
   sessions or invent missing values.
5. Import and check the session using the installed helper:

```sh
# Set this to the actual installed skill directory. Plugin paths differ.
SKILL_DIR="$HOME/.agents/skills/gpt-pro"

deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --auth-import /absolute/private/headers.txt

deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --auth-check
```

`--auth-import -` accepts stdin. The importer also accepts a JSON object with
`accessToken`, `cookie`, and `headers`, or an existing `CHATGPT_WEB_SESSION`
`.env` entry. It validates token expiry, matching device state, integrity state,
and header values; captured challenge/target headers are excluded. It does not
execute copied commands. Invalid imports leave the previous session intact.

The check makes a read-only request and consumes no model turn. HTTP 200 proves
that this request can authenticate, not that a model submission will succeed. Do
one explicitly requested small prompt to verify end-to-end access.

Default private state is `~/.local/share/gpt-pro/`: `.env` holds the snapshot;
`.gpt-pro-jobs/` holds job records. Directories use mode 0700 and files 0600.
This state is independent of the skill installation and survives replacement of
the installed code. On another account or machine, sign in and import its own
session; do not distribute your snapshot. Delete a temporary capture after
confirming the import if you no longer need it.

The snapshot does not refresh automatically. On expiry or authentication
failure, repeat the import from a fresh successful browser request, then resume
existing jobs with `--result`, rather than submitting those prompts again.

## State migration and overrides

For an earlier repository-based setup, import the repository `.env` with
`--auth-import /absolute/repository/.env`. Completed job JSON files can be
copied from the old `.gpt-pro-jobs/` into the private state directory. Do not
move or copy active jobs while another writer is running. Keep job IDs intact
and never resubmit to migrate a job.

Prefix any command with `--state-dir /absolute/private/directory` to use a
separate state location. This directory contains `.env` and `.gpt-pro-jobs/`.
The path must be absolute. With an explicit state directory, HOME access is not
needed. There is no automatic search for old repository credentials.

## Limits

The request runtime is browser-free; initial sign-in/session capture is not. The
helper depends on private ChatGPT endpoints and a changing Sentinel SDK. It has
live evidence for short queries, concurrent jobs, and installed use;
long-duration reliability and setup on every OS/browser are not established.
This is usable by developers comfortable with DevTools, not turnkey consumer
login. Never promise an API-supported authentication flow or automatic refresh.

Official references:

- https://developers.openai.com/codex/skills
- https://developers.openai.com/plugins/build/plugins

## Subscription usage advice

`--auth-check` also reports subscription-aware local usage advice on stderr. It
needs local write permission to inspect or initialize the job store and maintain
the usage cache. Without it, authentication can still succeed but usage advice
is unavailable. It uses a read-only account lookup with a six-hour private
cache; it does not submit a model prompt. Supported personal tiers are Pro $200
(200/week) and Pro $100 (50/week shared with Sol Pro), based on published limits
verified on 2026-09-06. Other plans remain unknown. The actual Pro quota reset
and remaining balance are unavailable: this is a local planning estimate, not a
billing meter. See the repository README's usage estimates section for counting
limitations.
