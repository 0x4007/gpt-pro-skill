import { ensurePrivateState, stateDirectory } from "./state.ts";
import { renewWebSession, tokenExpiry } from "./authenticate.ts";
import { assertRecord, CHATGPT_ORIGIN, clientObservation, isIntegrityState, requiredString } from "./shared.ts";

class CookieJar {
  #values: [string, string][] = [];
  #httpOnly = new Set<string>();

  private _isHttpOnly(name: string): boolean {
    return this.#httpOnly.has(name) || /^(?:__Secure-next-auth\.session-token(?:\.\d+)?|__Host-next-auth\.csrf-token|__cf_bm|cf_clearance|_cfuvid)$/.test(name);
  }

  scriptHeader(): string {
    return this.#values
      .filter(([name]) => !this._isHttpOnly(name))
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  setFromScript(name: string, value: string): void {
    if (!this._isHttpOnly(name)) this.set(name, value);
  }

  seed(header: string): void {
    this.#values = header.split(";").map((part) => {
      const item = part.trim();
      const separator = item.indexOf("=");
      return [item.slice(0, separator), item.slice(separator + 1)];
    });
  }

  set(name: string, value: string): void {
    this.#values = this.#values.filter(([key]) => key !== name);
    this.#values.push([name, value]);
  }

  integrityState(): string | null {
    try {
      const value = decodeURIComponent(this.#values.find(([name]) => name === "__Secure-oai-is")?.[1] ?? "");
      return isIntegrityState(value) ? value : null;
    } catch {
      return null;
    }
  }

  ingest(response: Response, expectedIntegrityState: string | null): void {
    // Deno types declare getSetCookie() unconditionally, but older runtimes do not
    // implement it, so the optional view keeps the runtime guard honest.
    const headers: { getSetCookie?: () => string[] } = response.headers;
    const lines = headers.getSetCookie?.() ?? [];
    for (const line of lines) {
      const first = line.split(";", 1)[0];
      const separator = first.indexOf("=");
      if (separator > 0) {
        const name = first.slice(0, separator);
        if (/;\s*httponly(?:;|$)/i.test(line)) this.#httpOnly.add(name);
        this.set(name, first.slice(separator + 1));
      }
    }
    const update = response.headers.get("x-oai-is-update");
    if (update !== null && isIntegrityState(update) && this.integrityState() === expectedIntegrityState) {
      this.set("__Secure-oai-is", update);
    }
  }

  header(): string {
    return [...this.#values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export interface WebSession {
  accessToken: string;
  cookie: string;
  headers: Record<string, string>;
}

const WEB_HEADERS = new Set([
  "accept-language",
  "oai-client-build-number",
  "oai-client-version",
  "oai-device-id",
  "oai-language",
  "oai-session-id",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-model",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  "sec-gpc",
  "user-agent",
  "chatgpt-account-id",
]);

const REQUIRED_SESSION_HEADERS = [
  "oai-device-id",
  "oai-session-id",
  "oai-client-build-number",
  "oai-client-version",
  "user-agent",
  "oai-language",
  "accept-language",
];

/** Keeps only allow-listed request headers and rejects anything the fetch layer would refuse. */
function parseSessionHeaders(value: unknown): Record<string, string> {
  const headers = assertRecord(value, "Web session headers");
  const clean: Record<string, string> = {};
  for (const [name, field] of Object.entries(headers)) {
    if (!WEB_HEADERS.has(name) || typeof field !== "string" || /[\r\n]/.test(field)) throw new Error();
    clean[name] = field;
  }
  // Constructing Headers is the check that every kept field is valid HTTP syntax; the same
  // normalized view then confirms each required header is present and non-blank.
  const validated = new Headers(clean);
  for (const name of REQUIRED_SESSION_HEADERS) {
    if (!validated.get(name)?.trim()) throw new Error();
  }
  return clean;
}

/** Rejects duplicated identity cookies and any cookie that does not bind to the declared device. */
function assertCookieBinding(cookie: string, deviceId: string): void {
  const cookies = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const item = part.trim();
    const split = item.indexOf("=");
    const name = item.slice(0, split);
    if (split <= 0 || (cookies.has(name) && (name === "oai-did" || name === "__Secure-oai-is"))) throw new Error();
    cookies.set(name, item.slice(split + 1));
  }
  if (decodeURIComponent(cookies.get("oai-did") ?? "") !== deviceId || !clientObservation(cookie).startsWith("v1.s.p.")) throw new Error();
}

/** Reads the numeric expiry from a three-part web-session token. */
function sessionExpiry(accessToken: string): number {
  let expiry: unknown;
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) throw new Error();
    expiry = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).exp;
    if (typeof expiry !== "number" || !Number.isFinite(expiry)) {
      throw new Error();
    }
  } catch {
    throw new Error("Invalid web-session token expiry");
  }
  return expiry;
}

function readSessionEnv(envText: string): string {
  const lines = envText.split(/\r?\n/).filter((line) => line.startsWith("CHATGPT_WEB_SESSION="));
  if (lines.length !== 1) {
    throw new Error("Expected one CHATGPT_WEB_SESSION entry in state-directory .env");
  }
  let encoded = lines[0].slice("CHATGPT_WEB_SESSION=".length).trim();
  if (encoded.startsWith("'") && encoded.endsWith("'")) {
    encoded = encoded.slice(1, -1);
  }
  return encoded;
}

export function parseWebSession(envText: string, allowExpired = false): WebSession {
  const encoded = readSessionEnv(envText);
  let session: WebSession;
  try {
    const value = assertRecord(JSON.parse(encoded), "Web session");
    const headers = parseSessionHeaders(value.headers);
    const accessToken = requiredString(value.accessToken, "Token");
    const cookie = requiredString(value.cookie, "Cookie");
    if (/\s/.test(accessToken) || /[\r\n]/.test(cookie)) {
      throw new Error();
    }
    new Headers({ authorization: "Bearer " + accessToken, cookie });
    assertCookieBinding(cookie, headers["oai-device-id"]);
    session = { accessToken, cookie, headers };
  } catch {
    throw new Error("Invalid CHATGPT_WEB_SESSION structure, headers, or cookie binding");
  }
  const expiry = sessionExpiry(session.accessToken);
  if (!allowExpired && expiry * 1000 <= Date.now()) {
    throw new Error("ChatGPT web session expired; run scripts/authenticate.ts to sign in again");
  }
  return session;
}

export async function loadWebSession(directory = stateDirectory()): Promise<WebSession> {
  const path = new URL(".env", directory);
  let text: string;
  try {
    const stat = await Deno.stat(path);
    if (stat.mode !== null && (stat.mode & 0o077) !== 0) {
      throw new Error();
    }
    text = await Deno.readTextFile(path);
  } catch {
    throw new Error("Could not read owner-only ChatGPT session; run scripts/authenticate.ts (state .env requires mode 0600)");
  }
  const session = parseWebSession(text, true);
  return tokenExpiry(session.accessToken) <= Date.now() + 300000 ? await renewWebSession(directory) : session;
}

/** Accumulator for a pasted request dump, in the shape the .env entry expects. */
interface ImportedSession {
  accessToken: string;
  cookie: string;
  headers: Record<string, string>;
}

/** Stores one credential-bearing header, rejecting duplicates and foreign origins. */
function consumeImportHeader(name: string, value: string, imported: ImportedSession): void {
  if (name === "authorization") {
    if (imported.accessToken || !value.startsWith("Bearer ")) {
      throw new Error("Invalid imported authorization header");
    }
    imported.accessToken = value.slice(7);
    return;
  }
  if (name === "cookie") {
    if (imported.cookie) throw new Error("Duplicate imported Cookie header");
    imported.cookie = value;
    return;
  }
  if (WEB_HEADERS.has(name)) {
    imported.headers[name] = value;
    return;
  }
  if ((name === "host" && value !== "chatgpt.com") || (name === "origin" && value !== CHATGPT_ORIGIN)) {
    throw new Error("Import must come from chatgpt.com");
  }
}

/** Consumes one line of a copied request: blanks, request lines, and pseudo-headers are skipped. */
function consumeImportLine(line: string, imported: ImportedSession): void {
  if (!line.trim() || /^(GET|POST) \S+ HTTP\/[\d.]+$/.test(line)) return;
  const separator = line.indexOf(":");
  if (separator <= 0) {
    if (!/^:(authority|method|path|scheme):/.test(line)) {
      throw new Error("Expected copied request headers or a web-session JSON object");
    }
    if (line.startsWith(":authority:") && line.slice(11).trim() !== "chatgpt.com") throw new Error("Import must come from chatgpt.com");
    return;
  }
  consumeImportHeader(line.slice(0, separator).toLowerCase().trim(), line.slice(separator + 1).trimStart(), imported);
}

export function parseSessionImport(text: string): WebSession {
  if (/^CHATGPT_WEB_SESSION=/m.test(text)) return parseWebSession(text);
  if (text.trimStart().startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("Invalid web-session JSON import");
    }
    return parseWebSession("CHATGPT_WEB_SESSION=" + JSON.stringify(value));
  }
  const imported: ImportedSession = { accessToken: "", cookie: "", headers: {} };
  for (const line of text.split(/\r?\n/)) {
    consumeImportLine(line, imported);
  }
  return parseWebSession("CHATGPT_WEB_SESSION=" + JSON.stringify(imported));
}

export async function importWebSession(text: string, directory: URL): Promise<void> {
  const session = parseSessionImport(text);
  await ensurePrivateState(directory);
  const temporary = new URL(".auth-" + crypto.randomUUID() + ".tmp", directory);
  const encoded = JSON.stringify(session).replaceAll("'", "\\u0027");
  await Deno.writeTextFile(temporary, "CHATGPT_WEB_SESSION='" + encoded + "'\n", { mode: 0o600, createNew: true });
  try {
    await Deno.rename(temporary, new URL(".env", directory));
  } catch (error) {
    await Deno.remove(temporary);
    throw error;
  }
}

export class ChatSession {
  readonly deviceId: string;
  readonly sessionId: string;
  readonly cookies = new CookieJar();
  readonly browserHeaders: Record<string, string>;
  private readonly _accessToken: string;

  constructor(session: WebSession) {
    this._accessToken = session.accessToken;
    this.deviceId = session.headers["oai-device-id"];
    this.sessionId = session.headers["oai-session-id"];
    this.cookies.seed(session.cookie);
    this.browserHeaders = {
      ...session.headers,
      "cache-control": "no-cache",
      origin: CHATGPT_ORIGIN,
      pragma: "no-cache",
      referer: CHATGPT_ORIGIN + "/",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    };
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    if (new URL(input).origin !== CHATGPT_ORIGIN) {
      throw new Error("Web-session requests must stay on the ChatGPT origin");
    }
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(this.browserHeaders)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${this._accessToken}`);
    const cookie = this.cookies.header();
    if (cookie) headers.set("cookie", cookie);

    const expectedIntegrityState = this.cookies.integrityState();
    const response = await fetch(input, {
      ...init,
      headers,
      redirect: "error",
    });
    this.cookies.ingest(response, expectedIntegrityState);
    return response;
  }
}
