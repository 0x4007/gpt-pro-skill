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

## Sign in

On macOS, use an existing ChatGPT sign-in in Brave, Chrome, Chromium, or Edge.
Ask the coding agent to authenticate the skill, or run:

```sh
# Use the actual installed directory; plugin paths differ.
SKILL_DIR="$HOME/.agents/skills/gpt-pro"

deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write \
  --allow-run=/usr/bin/security --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/authenticate.ts"
```

The command discovers profiles with ChatGPT sign-in cookies. With one matching
profile it proceeds automatically; with several it asks for a profile number. It
uses the normal macOS Keychain access path, which may show an OS permission
prompt. If access is denied, it stops. It does not unlock the Keychain, alter
browser permissions, launch a browser, copy a browser database, or capture
network traffic. No HAR, DevTools, copied headers, API key, or Codex token is
needed. If no readable signed-in profile exists, sign in to ChatGPT once and run
the command again. MFA and login challenges remain with the user.

Only ChatGPT session-token chunks, device ID, and integrity cookies are read
from the selected profile. The browser encryption key stays in process memory
and is never saved. Credentials go only to `https://chatgpt.com`, with redirects
rejected. The helper gets a web access token from the first-party session
endpoint and client build metadata from the page, then verifies a read-only
models request before saving. It prints a credential-free result.

Default private state is `~/.local/share/gpt-pro/`: `.env` holds the session;
`.gpt-pro-jobs/` holds job records. Directories use mode 0700 and files 0600.
Installation updates preserve this state. Both scripts accept the existing
`--state-dir /absolute/private/directory` prefix. Local browser discovery still
needs HOME even with an explicit state directory.

Subsequent requests renew tokens automatically when expired or within five
minutes of expiry. Renewal uses the saved sign-in cookie over HTTPS, updates
rotated cookies and client metadata, rejects subject changes, and saves only
after a read-only authentication check succeeds. Concurrent renewals share a
private file lock. No browser or Keychain access is needed for renewal. Failed
renewal preserves the existing file and does not retry a model submission. If
the underlying sign-in expires or is revoked, sign in again and rerun
`authenticate.ts`; resume jobs with `--result` instead of resubmitting them.

Check an existing installation without a model turn:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" --auth-check
```

A successful check proves authentication for that read-only request. It does not
prove model availability or conversation-submission eligibility. A live model
test requires a separately authorized submission.

### Explicit session imports

`--auth-import <file>` and `--auth-import -` remain available for intentional
private-state migration. They accept an existing `CHATGPT_WEB_SESSION` entry, a
JSON object with `accessToken`, `cookie`, and `headers`, or raw request headers.
Do not paste these into chat, issues, command arguments, or logs. Imports
validate expiry and device/integrity bindings, filter captured challenge
headers, execute no copied commands, and preserve the old session on invalid
input. Normal Mac onboarding does not use this interface.

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

Live verification covers macOS Brave bootstrap into fresh state and a separate
CLI authentication check, with no browser launch or network capture. Chrome,
Chromium, and Edge paths are implemented but unverified. Browser applications
must be under `/Applications`, with standard per-user profiles. The native
reader supports Chromium cookie database versions 23/24 and macOS v10
protection. Unknown protection formats fail without bypass attempts. Native
Windows/Linux bootstrap, Firefox, Safari, and custom profile paths are not
implemented. Direct renewal works from an existing imported session without
using native browser APIs, but cross-platform live acceptance is not claimed.

The helper uses private ChatGPT endpoints and a changing Sentinel SDK. There is
no documented OAuth/device-code grant for this exact integration. OpenAI API
keys and Codex sign-in are not automatically exchanged for web credentials. A
new user still needs their own account and model access. Fresh bootstrap has not
yet been used for a separately authorized live model submission; read-only
authentication does not prove Sentinel acceptance. Actual near-expiry renewal is
covered by focused tests; the live session endpoint returned a valid token but
did not need to rotate that unexpired token.

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
