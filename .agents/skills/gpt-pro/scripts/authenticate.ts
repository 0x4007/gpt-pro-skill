import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { join } from "node:path";
import {
  ChatSession,
  importWebSession,
  parseWebSession,
  type WebSession,
} from "./ask-gpt-pro.ts";
import { ensurePrivateState, stateDirectory } from "./state.ts";

class AuthenticationError extends Error {}

const ORIGIN = "https://chatgpt.com";
const SESSION_COOKIE = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;
const NATIVE_COOKIES =
  /^(?:__Secure-next-auth\.session-token(?:\.\d+)?|oai-did|__Secure-oai-is)$/;

export function tokenExpiry(token: string): number {
  try {
    const claims = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (!Number.isFinite(claims.exp)) throw new AuthenticationError();
    return claims.exp * 1000;
  } catch {
    throw new AuthenticationError("Invalid web-session token expiry");
  }
}

function subject(token: string): string {
  try {
    const value = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ).sub;
    if (typeof value !== "string" || !value) throw new AuthenticationError();
    return value;
  } catch {
    throw new AuthenticationError("Invalid web-session account identity");
  }
}

export function updateCookies(header: string, response: Response): string {
  let entries = header.split(";").map((part) => part.trim()).filter(Boolean);
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(";");
    const index = pair.indexOf("=");
    if (index < 1) continue;
    const name = pair.slice(0, index);
    entries = entries.filter((entry) =>
      entry.slice(0, entry.indexOf("=")) !== name
    );
    const expired = attributes.some((value) =>
      /^\s*max-age\s*=\s*0\s*$/i.test(value) ||
      (/^\s*expires=/i.test(value) &&
        Date.parse(value.slice(value.indexOf("=") + 1)) <= Date.now())
    );
    if (!expired && pair.slice(index + 1)) entries.push(pair);
  }
  return entries.join("; ");
}

export function clientMetadata(
  html: string,
): { build: string; version: string } {
  const root = html.match(/<html\s[^>]*>/i)?.[0] ?? "";
  const build = root.match(/\bdata-seq="(\d+)"/)?.[1];
  const version = root.match(/\bdata-build="(prod-[a-f0-9]+)"/)?.[1];
  if (!build || !version) {
    throw new AuthenticationError(
      "ChatGPT client metadata changed; authentication was not saved",
    );
  }
  return { build, version };
}

async function authFetch(
  path: string,
  cookie: string,
  userAgent: string,
  fetcher: typeof fetch,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(ORIGIN + path, {
      headers: { cookie, "user-agent": userAgent },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new AuthenticationError(
      "ChatGPT authentication request failed or timed out; no credentials were changed",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AuthenticationError(
      `ChatGPT authentication returned HTTP ${response.status}; no automatic retry`,
    );
  }
  return response;
}

// No model requests. The existing server-issued session cookie is the root of
// authentication; client metadata and a new client session UUID are not secrets.
export async function sessionFromCookies(
  cookie: string,
  userAgent: string,
  previous?: WebSession,
  fetcher: typeof fetch = fetch,
): Promise<WebSession> {
  if (
    !cookie.split(";").some((entry) =>
      SESSION_COOKIE.test(entry.trim().split("=", 1)[0])
    )
  ) {
    throw new AuthenticationError(
      "No ChatGPT sign-in cookie; sign in to ChatGPT once, then run authenticate.ts",
    );
  }
  const response = await authFetch(
    "/api/auth/session",
    cookie,
    userAgent,
    fetcher,
  );
  let accessToken: string;
  try {
    const body = await response.json();
    if (
      typeof body?.accessToken !== "string" ||
      tokenExpiry(body.accessToken) <= Date.now()
    ) throw new AuthenticationError();
    accessToken = body.accessToken;
  } catch {
    throw new AuthenticationError(
      "ChatGPT session has expired or was revoked; sign in once, then run authenticate.ts",
    );
  }
  if (previous && subject(previous.accessToken) !== subject(accessToken)) {
    throw new AuthenticationError(
      "ChatGPT renewal changed the account; existing authentication was preserved",
    );
  }
  cookie = updateCookies(cookie, response);
  const page = await authFetch("/", cookie, userAgent, fetcher);
  const metadata = clientMetadata(await page.text());
  cookie = updateCookies(cookie, page);
  const device = cookie.split(";").map((part) => part.trim()).find((part) =>
    part.startsWith("oai-did=")
  )?.slice(8);
  let deviceId: string;
  try {
    deviceId = decodeURIComponent(device ?? "");
  } catch {
    throw new AuthenticationError("Invalid ChatGPT device cookie");
  }
  const session = {
    accessToken,
    cookie,
    headers: {
      ...previous?.headers,
      "oai-device-id": deviceId,
      "oai-session-id": previous?.headers["oai-session-id"] ??
        crypto.randomUUID(),
      "oai-client-build-number": metadata.build,
      "oai-client-version": metadata.version,
      "user-agent": userAgent,
      "oai-language": previous?.headers["oai-language"] ?? "en-US",
      "accept-language": previous?.headers["accept-language"] ??
        "en-US,en;q=0.9",
    },
  };
  return parseWebSession("CHATGPT_WEB_SESSION=" + JSON.stringify(session));
}

async function withAuthLock<T>(
  directory: URL,
  action: () => Promise<T>,
): Promise<T> {
  await ensurePrivateState(directory);
  const path = new URL(".auth.lock", directory);
  try {
    const stat = await Deno.lstat(path);
    if (
      !stat.isFile || stat.isSymlink ||
      (stat.mode !== null && (stat.mode & 0o077))
    ) {
      throw new AuthenticationError(
        "Authentication lock must be an owner-only regular file",
      );
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const file = await Deno.open(path, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    file.close();
  }, 30000);
  try {
    await file.lock(true);
    clearTimeout(timer);
    if (timedOut) {
      throw new AuthenticationError(
        "Authentication lock timed out; no renewal was attempted",
      );
    }
    return await action();
  } finally {
    clearTimeout(timer);
    try {
      file.close();
    } catch { /* Lock timeout already closed it. */ }
  }
}

export async function renewWebSession(directory: URL): Promise<WebSession> {
  return await withAuthLock(directory, async () => {
    const previous = parseWebSession(
      await Deno.readTextFile(new URL(".env", directory)),
      true,
    );
    if (tokenExpiry(previous.accessToken) > Date.now() + 300000) {
      return previous;
    }
    const renewed = await sessionFromCookies(
      previous.cookie,
      previous.headers["user-agent"],
      previous,
    );
    await verifyAndSave(renewed, directory);
    return renewed;
  });
}

async function verifyAndSave(
  session: WebSession,
  directory: URL,
): Promise<void> {
  const client = new ChatSession(session);
  const response = await client.fetch(ORIGIN + "/backend-api/models", {
    signal: AbortSignal.timeout(20000),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new AuthenticationError(
      `ChatGPT authentication check returned HTTP ${response.status}; existing authentication was preserved`,
    );
  }
  session.cookie = client.cookies.header();
  await importWebSession(JSON.stringify(session), directory);
}

interface BrowserProfile {
  browser: string;
  profile: string;
  database: string;
  service: string;
  application: string;
}

export function decryptCookie(
  encrypted: Uint8Array,
  host: string,
  key: Uint8Array,
  version: number,
): string {
  if (version !== 23 && version !== 24) {
    throw new AuthenticationError(
      "Unsupported Chromium cookie database version",
    );
  }
  if (new TextDecoder().decode(encrypted.subarray(0, 3)) !== "v10") {
    throw new AuthenticationError(
      "Unsupported cookie protection; no protection bypass is attempted",
    );
  }
  try {
    const decipher = createDecipheriv(
      "aes-128-cbc",
      key,
      new Uint8Array(16).fill(32),
    );
    const plain = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ]);
    try {
      if (
        version === 24 &&
        !plain.subarray(0, 32).equals(
          createHash("sha256").update(host).digest(),
        )
      ) throw new AuthenticationError();
      return plain.subarray(version === 24 ? 32 : 0).toString();
    } finally {
      plain.fill(0);
    }
  } catch {
    throw new AuthenticationError(
      "Could not decrypt the ChatGPT cookie or verify its domain binding",
    );
  }
}

async function candidates(): Promise<BrowserProfile[]> {
  if (Deno.build.os !== "darwin") {
    throw new AuthenticationError(
      "Automatic browser sign-in currently supports macOS Brave, Chrome, Chromium, and Edge; no browser credentials were read",
    );
  }
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new AuthenticationError("HOME is required for local browser sign-in");
  }
  const { DatabaseSync } = await import("node:sqlite");
  const found: BrowserProfile[] = [];
  for (
    const [browser, folder, service, application] of [
      [
        "Brave",
        "BraveSoftware/Brave-Browser",
        "Brave Safe Storage",
        "Brave Browser.app",
      ],
      ["Chrome", "Google/Chrome", "Chrome Safe Storage", "Google Chrome.app"],
      ["Chromium", "Chromium", "Chromium Safe Storage", "Chromium.app"],
      [
        "Edge",
        "Microsoft Edge",
        "Microsoft Edge Safe Storage",
        "Microsoft Edge.app",
      ],
    ]
  ) {
    const root = join(home, "Library/Application Support", folder);
    try {
      for await (const entry of Deno.readDir(root)) {
        if (!entry.isDirectory || !/^(Default|Profile \d+)$/.test(entry.name)) {
          continue;
        }
        for (const suffix of ["Cookies", "Network/Cookies"]) {
          const database = join(root, entry.name, suffix);
          try {
            const db = new DatabaseSync(database, { readOnly: true });
            let present: boolean;
            try {
              present = !!db.prepare(
                "SELECT 1 FROM cookies WHERE host_key IN ('chatgpt.com','.chatgpt.com') AND (name='__Secure-next-auth.session-token' OR name='__Secure-next-auth.session-token.0') AND path='/' AND top_frame_site_key='' AND (is_persistent=0 OR expires_utc > ?) LIMIT 1",
              ).get(BigInt(Date.now()) * 1000n + 11644473600000000n);
            } finally {
              db.close();
            }
            if (present) {
              found.push({
                browser,
                profile: entry.name,
                database,
                service,
                application,
              });
            }
            break;
          } catch (error) {
            if (error instanceof Deno.errors.PermissionDenied) throw error;
            // Missing/locked/unsupported profiles are not modified or copied.
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return found;
}

async function nativeSession(profile: BrowserProfile): Promise<WebSession> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(profile.database, { readOnly: true });
  let rows;
  let version: number;
  try {
    version = Number(
      db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value,
    );
    rows = db.prepare(
      "SELECT name, host_key, encrypted_value FROM cookies WHERE host_key IN ('chatgpt.com','.chatgpt.com') AND (name='oai-did' OR name='__Secure-oai-is' OR name='__Secure-next-auth.session-token' OR name GLOB '__Secure-next-auth.session-token.[0-9]*') AND path='/' AND top_frame_site_key='' AND (is_persistent=0 OR expires_utc > ?) ORDER BY creation_utc",
    ).all(BigInt(Date.now()) * 1000n + 11644473600000000n);
  } finally {
    db.close();
  }
  const plist = await Deno.readTextFile(
    join("/Applications", profile.application, "Contents/Info.plist"),
  );
  const major = plist.match(
    /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./,
  )?.[1];
  if (!major) {
    throw new AuthenticationError(
      "Could not read the installed browser version",
    );
  }
  console.error(
    `Authenticating from ${profile.browser} / ${profile.profile}. macOS may ask for Keychain access.`,
  );
  const child = new Deno.Command("/usr/bin/security", {
    args: ["find-generic-password", "-s", profile.service, "-w"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch { /* Already exited. */ }
  }, 60000);
  const output = await child.output().finally(() => clearTimeout(timer));
  if (!output.success) {
    throw new AuthenticationError(
      "Keychain access was denied or timed out; no browser protections were changed",
    );
  }
  const key = pbkdf2Sync(
    new TextDecoder().decode(output.stdout).replace(/\r?\n$/, ""),
    "saltysalt",
    1003,
    16,
    "sha1",
  );
  output.stdout.fill(0);
  let cookie: string;
  try {
    cookie = rows.filter((row) => NATIVE_COOKIES.test(String(row.name))).map((
      row,
    ) =>
      String(row.name) + "=" +
      decryptCookie(
        row.encrypted_value as Uint8Array,
        String(row.host_key),
        key,
        version,
      )
    ).join("; ");
  } finally {
    key.fill(0);
  }
  const userAgent =
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return await sessionFromCookies(cookie, userAgent);
}

export async function authenticate(directory: URL): Promise<void> {
  const profiles = await candidates();
  if (!profiles.length) {
    throw new AuthenticationError(
      "No supported signed-in ChatGPT profile found. Sign in to ChatGPT once in Brave, Chrome, Chromium, or Edge, then run this command again",
    );
  }
  let selected = profiles[0];
  if (profiles.length > 1) {
    profiles.forEach((profile, index) =>
      console.error(`${index + 1}. ${profile.browser} / ${profile.profile}`)
    );
    const choice = prompt("Choose the browser profile to authorize (number)");
    const index = Number(choice) - 1;
    if (!choice || !Number.isInteger(index) || !profiles[index]) {
      throw new AuthenticationError(
        "Select one profile explicitly; no credentials were read",
      );
    }
    selected = profiles[index];
  }
  // Obtain OS consent before the short state lock; never change browser state.
  const session = await nativeSession(selected);
  await withAuthLock(
    directory,
    async () => await verifyAndSave(session, directory),
  );
  console.log(
    JSON.stringify({
      authenticated: true,
      source: "local_browser_keychain",
      browser: selected.browser,
      profile: selected.profile,
      modelSubmission: false,
      submissionEligibility: "not_tested",
    }),
  );
}

if (import.meta.main) {
  try {
    const args = [...Deno.args];
    if (args[0] === "--state-dir" && !args[1]) {
      throw new AuthenticationError("--state-dir requires an absolute path");
    }
    const directory = stateDirectory(
      args[0] === "--state-dir" ? args.splice(0, 2)[1] : undefined,
    );
    if (args.length) {
      throw new AuthenticationError(
        "Usage: authenticate.ts [--state-dir /absolute/path]",
      );
    }
    await authenticate(directory);
  } catch (error) {
    // Native SQLite, Keychain, JSON and HTTP exceptions can include private data.
    console.error(
      error instanceof Error && error.message.startsWith("Requires")
        ? "Authentication needs local read, Keychain execution, and chatgpt.com network permissions"
        : "Authentication failed: " +
          (error instanceof AuthenticationError
            ? error.message
            : "local setup failed; existing authentication was preserved"),
    );
    Deno.exitCode = 1;
  }
}
