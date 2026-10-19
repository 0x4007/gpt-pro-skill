import { pathToFileURL } from "node:url";
import { importWebSession, parseWebSession } from "../scripts/session.ts";
import { remoteSessionCommand, transferSession, type TransferResult } from "../scripts/transfer-session.ts";

function token(sub: string, exp = 4102444800): string {
  return `e30.${btoa(JSON.stringify({ sub, exp }))}.fixture`;
}

function sessionText(sub: string, exp = 4102444800): string {
  return (
    "CHATGPT_WEB_SESSION=" +
    JSON.stringify({
      accessToken: token(sub, exp),
      cookie: "oai-did=fixture-device; __Secure-oai-is=ois1.fixture.AAAAAAAAAAAAAAAA.signature",
      headers: {
        "oai-device-id": "fixture-device",
        "oai-session-id": "fixture-session",
        "oai-client-build-number": "fixture-build",
        "oai-client-version": "fixture-version",
        "user-agent": "fixture-agent",
        "oai-language": "en-US",
        "accept-language": "en-US",
      },
    })
  );
}

async function state(): Promise<URL> {
  const root = await Deno.makeTempDir();
  await Deno.chmod(root, 0o700);
  return pathToFileURL(root + "/");
}

async function backupNames(directory: URL): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name.startsWith(".env.backup-")) names.push(entry.name);
  }
  return names.sort((left, right) => left.localeCompare(right));
}

Deno.test("transfer installs a verified session with owner-only permissions", async () => {
  const directory = await state();
  try {
    let verified = 0;
    const result = await transferSession(sessionText("account-a"), directory, {
      verifySession: () => {
        verified++;
        return Promise.resolve(200);
      },
    });
    if (!result.transferred || result.accountChanged || result.dryRun || result.verificationHttpStatus !== 200 || verified !== 1) {
      throw new Error("Transfer result was wrong");
    }
    const path = new URL(".env", directory);
    if (((await Deno.stat(path)).mode ?? 0o600) & 0o077) throw new Error("Installed session was not private");
    if (parseWebSession(await Deno.readTextFile(path)).accessToken !== token("account-a")) {
      throw new Error("Installed session differed");
    }
    if ((await backupNames(directory)).length !== 0) throw new Error("Unexpected backup");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("same-account replacement keeps one session and creates no backup", async () => {
  const directory = await state();
  try {
    await importWebSession(sessionText("account-a"), directory);
    const result = await transferSession(sessionText("account-a"), directory, { verifySession: () => Promise.resolve(200) });
    if (!result.transferred || result.accountChanged || result.backupPath) throw new Error("Same account was treated as a change");
    if ((await backupNames(directory)).length !== 0) throw new Error("Same-account transfer created a backup");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("different account is refused before verification and state is byte-identical", async () => {
  const directory = await state();
  try {
    await importWebSession(sessionText("account-a"), directory);
    const before = await Deno.readFile(new URL(".env", directory));
    let verified = 0;
    let message = "";
    try {
      await transferSession(sessionText("account-b"), directory, {
        verifySession: () => {
          verified++;
          return Promise.resolve(200);
        },
      });
    } catch (error) {
      message = String(error);
    }
    if (!message.includes("different account") || verified !== 0) throw new Error("Account mismatch was not rejected early");
    if (!Buffer.from(before).equals(await Deno.readFile(new URL(".env", directory)))) throw new Error("Rejected transfer changed state");
    if (message.includes("fixture-session") || message.includes("fixture-device") || message.includes(token("account-b"))) {
      throw new Error("Account mismatch leaked credentials");
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("explicit account replacement backs up the previous private session atomically", async () => {
  const directory = await state();
  try {
    await importWebSession(sessionText("account-a"), directory);
    const previous = await Deno.readFile(new URL(".env", directory));
    const result = await transferSession(sessionText("account-b"), directory, {
      replaceAccount: true,
      verifySession: () => Promise.resolve(200),
    });
    const names = await backupNames(directory);
    if (!result.transferred || !result.accountChanged || !result.backupPath || names.length !== 1) {
      throw new Error("Replacement did not create exactly one backup");
    }
    if (!/^\.env\.backup-[0-9a-f-]{36}$/.test(names[0])) throw new Error("Backup name is not a UUID");
    const backup = new URL(names[0], directory);
    if (((await Deno.stat(backup)).mode ?? 0o600) & 0o077) throw new Error("Backup was not private");
    if (!Buffer.from(previous).equals(await Deno.readFile(backup))) throw new Error("Backup did not preserve the old session");
    if (parseWebSession(await Deno.readTextFile(new URL(".env", directory))).accessToken !== token("account-b")) {
      throw new Error("Replacement did not install the incoming session");
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("failed verification, expired input, and dry run preserve state", async () => {
  const directory = await state();
  try {
    await importWebSession(sessionText("account-a"), directory);
    const before = await Deno.readFile(new URL(".env", directory));
    const failures: [string, () => Promise<TransferResult>][] = [
      ["verification", () => transferSession(sessionText("account-a"), directory, { verifySession: () => Promise.resolve(401) })],
      ["expiry", () => transferSession(sessionText("account-a", 1), directory, { verifySession: () => Promise.resolve(200) })],
    ];
    for (const [label, run] of failures) {
      let rejected = false;
      try {
        await run();
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error(label + " failure was accepted");
      if (!Buffer.from(before).equals(await Deno.readFile(new URL(".env", directory)))) {
        throw new Error(label + " failure changed state");
      }
    }
    const dryRun = await transferSession(sessionText("account-a"), directory, {
      dryRun: true,
      verifySession: () => Promise.resolve(200),
    });
    if (!dryRun.dryRun || dryRun.transferred) throw new Error("Dry run wrote state");
    if (!Buffer.from(before).equals(await Deno.readFile(new URL(".env", directory)))) {
      throw new Error("Dry run changed state");
    }
    if ((await backupNames(directory)).length !== 0) throw new Error("Failed transfer created a backup");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("remote command uses the default state or safely quotes an absolute path", () => {
  if (remoteSessionCommand(undefined) !== 'base64 < "$HOME/.local/share/gpt-pro/.env"') {
    throw new Error("Default remote path changed");
  }
  const command = remoteSessionCommand("/var/lib/gpt-pro/a'b");
  if (command !== "base64 < '/var/lib/gpt-pro/a'\\''b/.env'") throw new Error("Custom remote path was not shell-quoted");
  let rejected = false;
  try {
    remoteSessionCommand("relative/path");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Relative remote path accepted");
});
