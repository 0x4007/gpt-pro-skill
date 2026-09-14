# gpt-pro

A Deno skill that sends a question to `gpt-6-pro` on an authenticated ChatGPT
web session and returns the completed answer by durable job ID. No browser runs
at request time.

## Install

```text
$skill-installer install https://github.com/0x4007/gpt-pro-skill/tree/main/.agents/skills/gpt-pro
```

## Use

```sh
SKILL_DIR="$HOME/.agents/skills/gpt-pro"
```

Connect using an existing ChatGPT session. The same command first verifies saved
authentication or renews an expired token, then uses local browser discovery when
no saved session exists:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write \
  --allow-run=/usr/bin/security,/usr/bin/chromium,/usr/bin/google-chrome,/usr/bin/brave-browser,/usr/bin/microsoft-edge,/usr/bin/secret-tool --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/authenticate.ts"
```

Multiple signed-in profiles require an explicit choice in an interactive terminal.
If saved authentication is rejected, sign in again in your browser and rerun
interactively; reconnection requires a changed sign-in for the same account. No
model prompt is sent during authentication. Failed connections preserve credentials
and existing jobs. On Linux, Secret Service may ask for normal desktop consent;
the helper only looks up the selected browser's existing key and never creates one.

Live onboarding is verified on Arch Linux ARM with Chromium 153.0.8010.36,
cookie database 24 and existing v10 storage. macOS Brave was verified previously;
the macOS Keychain adapter remains available. Linux Secret Service v11 storage is
covered by fixtures, not a live credential-store check. Other Linux browser paths
are implemented but unverified. Portal protection, native KWallet, Windows and
headless pairing are not yet supported. Browser protections are never disabled.
The normal request runtime uses the saved session without launching a browser.

Then submit:

```sh
deno run --allow-env=HOME,USERPROFILE --allow-read --allow-write --allow-net=chatgpt.com \
  "$SKILL_DIR/scripts/ask-gpt-pro.ts" "<prompt>"
```

| Command                   | Result                                        |
| ------------------------- | --------------------------------------------- |
| `<prompt>`                | Submit once, wait, print the answer           |
| `--background <prompt>`   | Submit once and return a job summary          |
| `--result <job-id>`       | Wait for one job or print its cached answer   |
| `--watch`                 | Retrieve the pending jobs as JSON lines       |
| `--jobs`                  | List local job summaries as JSON              |
| `--status <job-id>`       | Inspect one job without polling               |
| `--auth-check`            | Read-only authentication check; no model turn |
| `--auth-import <file\|->` | Import a session into private state           |
| `--help`                  | Print CLI usage                               |

Private state defaults to `~/.local/share/gpt-pro/` with owner-only permissions.
Override it with `--state-dir /absolute/path` before any command. Job records
hold prompts and answers, so keep them private.

Retrieval polls for up to six hours after submission and never resubmits the
prompt. Resume an interrupted job with the same ID.

## Verify

```sh
deno test --allow-read --allow-write .agents/skills/gpt-pro/tests/
deno check .agents/skills/gpt-pro/scripts/ask-gpt-pro.ts
```
