import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { join } from "node:path";
import { ChatSession, importWebSession, parseWebSession, type WebSession } from "./ask-gpt-pro.ts";
import { ensurePrivateState, stateDirectory } from "./state.ts";

class AuthenticationError extends Error {}

const ORIGIN = "https://chatgpt.com";
const SESSION_COOKIE = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;
const NATIVE_COOKIES = /^(?:__Secure-next-auth\.session-token(?:\.\d+)?|oai-did|__Secure-oai-is)$/;

export function tokenExpiry(token: string): number {
  try {
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!Number.isFinite(claims.exp)) throw new AuthenticationError();
    return claims.exp * 1000;
  } catch {
    throw new AuthenticationError("Invalid web-session token expiry");
  }
}

function subject(token: string): string {
  try {
    const value = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub;
    if (typeof value !== "string" || !value) throw new AuthenticationError();
    return value;
  } catch {
    throw new AuthenticationError("Invalid web-session account identity");
  }
}

export function updateCookies(header: string, response: Response): string {
  let entries = header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(";");
    const index = pair.indexOf("=");
    if (index < 1) continue;
    const name = pair.slice(0, index);
    entries = entries.filter((entry) => entry.slice(0, entry.indexOf("=")) !== name);
    const expired = attributes.some(
      (value) => /^\s*max-age\s*=\s*0\s*$/i.test(value) || (/^\s*expires=/i.test(value) && Date.parse(value.slice(value.indexOf("=") + 1)) <= Date.now())
    );
    if (!expired && pair.slice(index + 1)) entries.push(pair);
  }
  return entries.join("; ");
}

export function clientMetadata(html: string): { build: string; version: string } {
  const root = /<html\s[^>]*>/i.exec(html)?.[0] ?? "";
  const build = /\bdata-seq="(\d+)"/.exec(root)?.[1];
  const version = /\bdata-build="(prod-[a-f0-9]+)"/.exec(root)?.[1];
  if (!build || !version) {
    throw new AuthenticationError("ChatGPT client metadata changed; authentication was not saved");
  }
  return { build, version };
}

async function authFetch(path: string, cookie: string, userAgent: string, fetcher: typeof fetch): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(ORIGIN + path, {
      headers: { cookie, "user-agent": userAgent },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new AuthenticationError("ChatGPT authentication request failed or timed out; no credentials were changed");
  }
  if (!response.ok) {
    const isChallenge = response.headers.get("cf-mitigated") === "challenge";
    const isHtml = response.headers.get("content-type")?.startsWith("text/html") === true;
    await response.body?.cancel();
    let detail = isHtml ? " (HTML response before session JSON)" : "";
    if (isChallenge) detail = " (browser verification required)";
    throw new AuthenticationError(`ChatGPT authentication at ${path} returned HTTP ${String(response.status)}${detail}; no automatic retry`);
  }
  return response;
}

export async function sessionFromCookies(cookie: string, userAgent: string, previous?: WebSession, fetcher: typeof fetch = fetch): Promise<WebSession> {
  if (!cookie.split(";").some((entry) => SESSION_COOKIE.test(entry.trim().split("=", 1)[0]))) {
    throw new AuthenticationError("No ChatGPT sign-in cookie; sign in to ChatGPT once, then run authenticate.ts");
  }
  const response = await authFetch("/api/auth/session", cookie, userAgent, fetcher);
  let accessToken: string;
  try {
    const body = await response.json();
    if (typeof body?.accessToken !== "string" || tokenExpiry(body.accessToken) <= Date.now()) throw new AuthenticationError();
    accessToken = body.accessToken;
  } catch {
    throw new AuthenticationError("ChatGPT session has expired or was revoked; sign in once, then run authenticate.ts");
  }
  if (previous && subject(previous.accessToken) !== subject(accessToken)) {
    throw new AuthenticationError("ChatGPT renewal changed the account; existing authentication was preserved");
  }
  cookie = updateCookies(cookie, response);
  const page = await authFetch("/", cookie, userAgent, fetcher);
  const metadata = clientMetadata(await page.text());
  cookie = updateCookies(cookie, page);
  const device = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("oai-did="))
    ?.slice(8);
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
      "oai-session-id": previous?.headers["oai-session-id"] ?? crypto.randomUUID(),
      "oai-client-build-number": metadata.build,
      "oai-client-version": metadata.version,
      "user-agent": userAgent,
      "oai-language": previous?.headers["oai-language"] ?? "en-US",
      "accept-language": previous?.headers["accept-language"] ?? "en-US,en;q=0.9",
    },
  };
  return parseWebSession("CHATGPT_WEB_SESSION=" + JSON.stringify(session));
}

async function withAuthLock<T>(directory: URL, action: () => Promise<T>): Promise<T> {
  await ensurePrivateState(directory);
  const path = new URL(".auth.lock", directory);
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isFile || stat.isSymlink || (stat.mode !== null && stat.mode & 0o077)) {
      throw new AuthenticationError("Authentication lock must be an owner-only regular file");
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
  // The deadline flag lives on an object because a plain `let` would be narrowed to
  // `false` by control flow analysis, which cannot see the timer callback write to it.
  const deadline = { expired: false };
  const timer = setTimeout(() => {
    deadline.expired = true;
    file.close();
  }, 30000);
  try {
    await file.lock(true);
    clearTimeout(timer);
    if (deadline.expired) {
      throw new AuthenticationError("Authentication lock timed out; no renewal was attempted");
    }
    return await action();
  } finally {
    clearTimeout(timer);
    try {
      file.close();
    } catch {}
  }
}

export async function renewWebSession(directory: URL): Promise<WebSession> {
  return await withAuthLock(directory, async () => {
    const previous = parseWebSession(await Deno.readTextFile(new URL(".env", directory)), true);
    if (tokenExpiry(previous.accessToken) > Date.now() + 300000) {
      return previous;
    }
    const renewed = await sessionFromCookies(previous.cookie, previous.headers["user-agent"], previous);
    await verifyAndSave(renewed, directory);
    return renewed;
  });
}

async function verifyAndSave(session: WebSession, directory: URL): Promise<void> {
  await verifySession(session);
  await importWebSession(JSON.stringify(session), directory);
}

async function verifySession(session: WebSession): Promise<void> {
  const client = new ChatSession(session);
  const response = await client.fetch(ORIGIN + "/backend-api/models", {
    signal: AbortSignal.timeout(20000),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new AuthenticationError(`ChatGPT authentication check returned HTTP ${String(response.status)}; existing authentication was preserved`);
  }
  session.cookie = client.cookies.header();
}

interface BrowserProfile {
  browser: string;
  profile: string;
  database: string;
  service: string;
  application: string;
  platform: "darwin" | "linux";
}

export function decryptCookie(encrypted: Uint8Array, host: string, key: Uint8Array, version: number, protection = "v10"): string {
  if (version !== 23 && version !== 24) {
    throw new AuthenticationError("Unsupported Chromium cookie database version");
  }
  if (new TextDecoder().decode(encrypted.subarray(0, 3)) !== protection) {
    throw new AuthenticationError("Unsupported cookie protection; no protection bypass is attempted");
  }
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, new Uint8Array(16).fill(32));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    try {
      if (version === 24 && !plain.subarray(0, 32).equals(createHash("sha256").update(host).digest())) throw new AuthenticationError();
      return plain.subarray(version === 24 ? 32 : 0).toString();
    } finally {
      plain.fill(0);
    }
  } catch {
    throw new AuthenticationError("Could not decrypt the ChatGPT cookie or verify its domain binding");
  }
}

type BrowserProduct = readonly [browser: string, folder: string, service: string, application: string];

const BROWSER_PRODUCTS: readonly BrowserProduct[] = [
  ["Brave", "BraveSoftware/Brave-Browser", "Brave Safe Storage", "Brave Browser.app"],
  ["Chrome", "Google/Chrome", "Chrome Safe Storage", "Google Chrome.app"],
  ["Chromium", "Chromium", "Chromium Safe Storage", "Chromium.app"],
  ["Edge", "Microsoft Edge", "Microsoft Edge Safe Storage", "Microsoft Edge.app"],
];

const LINUX_BROWSER_PRODUCTS: readonly BrowserProduct[] = [
  ["Brave", "BraveSoftware/Brave-Browser", "brave", "/usr/bin/brave-browser"],
  ["Chrome", "google-chrome", "chrome", "/usr/bin/google-chrome"],
  ["Chromium", "chromium", "chromium", "/usr/bin/chromium"],
  ["Edge", "microsoft-edge", "microsoft-edge", "/usr/bin/microsoft-edge"],
];

const SESSION_COOKIE_QUERY =
  "SELECT 1 FROM cookies WHERE host_key IN ('chatgpt.com','.chatgpt.com') AND (name='__Secure-next-auth.session-token' OR name='__Secure-next-auth.session-token.0') AND path='/' AND top_frame_site_key='' AND (is_persistent=0 OR expires_utc > ?) LIMIT 1";

/** Chromium stores cookie expiries as microseconds since 1601-01-01. */
function chromiumNow(): bigint {
  return BigInt(Date.now()) * 1000n + 11644473600000000n;
}

async function databaseHasSession(database: string): Promise<boolean> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return !!db.prepare(SESSION_COOKIE_QUERY).get(chromiumNow());
  } finally {
    db.close();
  }
}

interface ProfileCookieStore {
  database: string;
  signedIn: boolean;
}

/** Chromium moved the cookie database into Network/ in version 96; the first layout that opens wins. */
async function profileCookieStore(root: string, profile: string): Promise<ProfileCookieStore | undefined> {
  for (const suffix of ["Cookies", "Network/Cookies"]) {
    const database = join(root, profile, suffix);
    try {
      const info = await Deno.lstat(database);
      if (!info.isFile || info.isSymlink) throw new AuthenticationError("Browser cookie storage must be a regular file");
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    try {
      return { database, signedIn: await databaseHasSession(database) };
    } catch {
      throw new AuthenticationError("Browser cookie storage is locked, unreadable, or unsupported; close the browser and try again");
    }
  }
  return undefined;
}

async function browserProfiles(root: string, product: BrowserProduct, platform: "darwin" | "linux"): Promise<BrowserProfile[]> {
  const [browser, folder, service, application] = product;
  root = join(root, folder);
  const found: BrowserProfile[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory || !/^(Default|Profile \d+)$/.test(entry.name)) {
        continue;
      }
      const store = await profileCookieStore(root, entry.name);
      if (!store?.signedIn) {
        continue;
      }
      found.push({ browser, profile: entry.name, database: store.database, service, application, platform });
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return found;
}

async function candidates(): Promise<BrowserProfile[]> {
  const platform = Deno.build.os;
  if (platform !== "darwin" && platform !== "linux") {
    throw new AuthenticationError("No verified local credential adapter for this browser platform; no browser protections were changed");
  }
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new AuthenticationError("HOME is required for local browser sign-in");
  }
  const found: BrowserProfile[] = [];
  const products = platform === "darwin" ? BROWSER_PRODUCTS : LINUX_BROWSER_PRODUCTS;
  const root = join(home, platform === "darwin" ? "Library/Application Support" : ".config");
  for (const product of products) {
    found.push(...(await browserProfiles(root, product, platform)));
  }
  if (platform === "linux") {
    found.push(
      ...(await browserProfiles(join(home, ".local/share"), ["Chromium sign-in", "gpt-pro-browser-login", "chromium", "/usr/bin/chromium"], platform))
    );
  }
  return found;
}

/** Read existing Linux v10/v11 storage; never request a browser protection change. */
export function decryptLinuxCookie(encrypted: Uint8Array, host: string, version: number, secret?: Uint8Array): string {
  const protection = new TextDecoder().decode(encrypted.subarray(0, 3));
  if (protection !== "v10" && protection !== "v11") {
    throw new AuthenticationError("This browser cookie needs an OS credential-store adapter; no protection bypass or downgrade was attempted");
  }
  if (protection === "v11" && !secret?.length) {
    throw new AuthenticationError("Browser credential store is unavailable or locked; unlock it through the desktop and run authenticate.ts again");
  }
  const key = pbkdf2Sync(protection === "v10" ? "peanuts" : (secret ?? new Uint8Array()), "saltysalt", 1, 16, "sha1");
  try {
    return decryptCookie(encrypted, host, key, version, protection);
  } finally {
    key.fill(0);
  }
}

interface NativeCookie {
  name: string;
  host: string;
  encrypted: Uint8Array;
}

export async function linuxCookieHeader(rows: NativeCookie[], version: number, readSecret: () => Promise<Uint8Array>): Promise<string> {
  const allowed = rows.filter((row) => NATIVE_COOKIES.test(row.name) && (row.host === "chatgpt.com" || row.host === ".chatgpt.com"));
  if (version !== 23 && version !== 24) throw new AuthenticationError("Unsupported Chromium cookie database version");
  const protections = allowed.map((row) => new TextDecoder().decode(row.encrypted.subarray(0, 3)));
  if (protections.some((value) => value !== "v10" && value !== "v11")) {
    throw new AuthenticationError("Unsupported cookie protection; no credential store was accessed");
  }
  let secret: Uint8Array | undefined;
  try {
    if (protections.includes("v11")) {
      try {
        secret = await readSecret();
      } catch {
        throw new AuthenticationError("Browser credential access was denied, unavailable, or timed out; no credentials were saved");
      }
      if (!secret.length) throw new AuthenticationError("No browser secret was returned; unlock the desktop credential store and try again");
    }
    return allowed.map((row) => row.name + "=" + decryptLinuxCookie(row.encrypted, row.host, version, secret)).join("; ");
  } finally {
    secret?.fill(0);
  }
}

async function linuxSecret(application: string): Promise<Uint8Array> {
  const output = await new Deno.Command("/usr/bin/secret-tool", {
    args: ["lookup", "application", application],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
    signal: AbortSignal.timeout(60000),
  }).output();
  try {
    if (!output.success) throw new AuthenticationError("Browser credential access was denied or unavailable");
    let end = output.stdout.length;
    if (output.stdout[end - 1] === 10) end--;
    if (output.stdout[end - 1] === 13) end--;
    return output.stdout.slice(0, end);
  } finally {
    output.stdout.fill(0);
  }
}

async function sessionFromBrowser(cookie: string, userAgent: string, previous?: WebSession): Promise<WebSession> {
  function signIn(header: string): string {
    return header
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => SESSION_COOKIE.test(entry.split("=", 1)[0]))
      .sort((a, b) => a.localeCompare(b))
      .join("; ");
  }
  if (previous && signIn(previous.cookie) === signIn(cookie)) {
    throw new AuthenticationError("The browser sign-in has not changed; sign in again before reconnecting. No authentication request was repeated");
  }
  return await sessionFromCookies(cookie, userAgent, previous);
}

async function nativeSession(profile: BrowserProfile, previous?: WebSession): Promise<WebSession> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(profile.database, { readOnly: true });
  let rows;
  let version: number;
  try {
    version = Number(db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value);
    rows = db
      .prepare(
        "SELECT name, host_key, encrypted_value FROM cookies WHERE host_key IN ('chatgpt.com','.chatgpt.com') AND (name='oai-did' OR name='__Secure-oai-is' OR name='__Secure-next-auth.session-token' OR name GLOB '__Secure-next-auth.session-token.[0-9]*') AND path='/' AND top_frame_site_key='' AND (is_persistent=0 OR expires_utc > ?) ORDER BY creation_utc"
      )
      .all(chromiumNow());
  } finally {
    db.close();
  }
  if (profile.platform === "linux") {
    const output = await new Deno.Command(profile.application, {
      args: ["--version"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(10000),
    }).output();
    const major = /\b(\d+)\.\d+\.\d+/.exec(new TextDecoder().decode(output.stdout))?.[1];
    if (!output.success || !major) throw new AuthenticationError("Could not read the installed browser version");
    const cookie = await linuxCookieHeader(
      rows.map((row) => ({
        name: String(row.name),
        host: String(row.host_key),
        encrypted: row.encrypted_value as Uint8Array,
      })),
      version,
      () => linuxSecret(profile.service)
    );
    const machine = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
    return await sessionFromBrowser(
      cookie,
      `Mozilla/5.0 (X11; Linux ${machine}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      previous
    );
  }
  const plist = await Deno.readTextFile(join("/Applications", profile.application, "Contents/Info.plist"));
  const major = /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./.exec(plist)?.[1];
  if (!major) {
    throw new AuthenticationError("Could not read the installed browser version");
  }
  console.error(`Authenticating from ${profile.browser} / ${profile.profile}. macOS may ask for Keychain access.`);
  const child = new Deno.Command("/usr/bin/security", {
    args: ["find-generic-password", "-s", profile.service, "-w"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {}
  }, 60000);
  const output = await child.output().finally(() => {
    clearTimeout(timer);
  });
  if (!output.success) {
    throw new AuthenticationError("Keychain access was denied or timed out; no browser protections were changed");
  }
  const key = pbkdf2Sync(new TextDecoder().decode(output.stdout).replace(/\r?\n$/, ""), "saltysalt", 1003, 16, "sha1");
  output.stdout.fill(0);
  let cookie: string;
  try {
    cookie = rows
      .filter((row) => NATIVE_COOKIES.test(String(row.name)))
      .map((row) => String(row.name) + "=" + decryptCookie(row.encrypted_value as Uint8Array, String(row.host_key), key, version))
      .join("; ");
  } finally {
    key.fill(0);
  }
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return await sessionFromBrowser(cookie, userAgent, previous);
}

async function readSavedSession(directory: URL): Promise<WebSession | undefined> {
  const path = new URL(".env", directory);
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isFile || stat.isSymlink || (stat.mode !== null && (stat.mode & 0o077) !== 0)) {
      throw new AuthenticationError("Saved authentication must be an owner-only regular file");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return undefined;
  }
  return parseWebSession(await Deno.readTextFile(path), true);
}

async function connectSavedSession(previous: WebSession, directory: URL): Promise<boolean> {
  try {
    if (tokenExpiry(previous.accessToken) <= Date.now() + 300000) {
      await renewWebSession(directory);
    } else {
      await verifySession(previous);
    }
    console.log(JSON.stringify({ authenticated: true, source: "saved_session", modelSubmission: false, submissionEligibility: "not_tested" }));
    return true;
  } catch (error) {
    if (!Deno.stdin.isTerminal()) throw error;
    console.error(failureMessage(error));
    if (prompt("Have you signed in again? Reconnect the same account from a changed browser login (yes/no)") !== "yes") throw error;
    return false;
  }
}

export async function authenticate(directory: URL): Promise<void> {
  const previous = await readSavedSession(directory);
  if (previous && (await connectSavedSession(previous, directory))) return;
  const profiles = await candidates();
  if (!profiles.length) {
    throw new AuthenticationError(
      "No supported signed-in ChatGPT profile found. Sign in to ChatGPT once in Brave, Chrome, Chromium, or Edge, then run this command again"
    );
  }
  let selected = profiles[0];
  if (profiles.length > 1) {
    profiles.forEach((profile, index) => {
      console.error(`${String(index + 1)}. ${profile.browser} / ${profile.profile}`);
    });
    if (!Deno.stdin.isTerminal()) {
      throw new AuthenticationError("Profile selection is needed; run authenticate.ts in an interactive terminal and select your browser profile");
    }
    const choice = prompt("Choose the browser profile to authorize (number)");
    const index = Number(choice) - 1;
    if (!choice || !Number.isInteger(index) || !profiles[index]) {
      throw new AuthenticationError("Select one profile explicitly; no credentials were read");
    }
    selected = profiles[index];
  }
  const session = await nativeSession(selected, previous);
  await withAuthLock(directory, async () => {
    try {
      const current = parseWebSession(await Deno.readTextFile(new URL(".env", directory)), true);
      if (subject(current.accessToken) !== subject(session.accessToken)) {
        throw new AuthenticationError("The selected browser account differs from saved authentication; existing credentials and jobs were preserved");
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await verifyAndSave(session, directory);
  });
  console.log(
    JSON.stringify({
      authenticated: true,
      source: selected.platform === "darwin" ? "local_browser_keychain" : "local_browser",
      browser: selected.browser,
      profile: selected.profile,
      modelSubmission: false,
      submissionEligibility: "not_tested",
    })
  );
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("Requires")) {
    return "Authentication needs local read/write, the selected browser or credential helper execution, and chatgpt.com network permissions";
  }
  const reason = error instanceof AuthenticationError ? error.message : "local setup failed; existing authentication was preserved";
  return "Authentication failed: " + reason;
}

if (import.meta.main) {
  try {
    const args = [...Deno.args];
    if (args[0] === "--state-dir" && !args[1]) {
      throw new AuthenticationError("--state-dir requires an absolute path");
    }
    const directory = stateDirectory(args[0] === "--state-dir" ? args.splice(0, 2)[1] : undefined);
    if (args.length) {
      throw new AuthenticationError("Usage: authenticate.ts [--state-dir /absolute/path]");
    }
    await authenticate(directory);
  } catch (error) {
    console.error(failureMessage(error));
    Deno.exitCode = 1;
  }
}
