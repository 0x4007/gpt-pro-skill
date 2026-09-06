import { createContext, runInContext } from "node:vm";
import { ensurePrivateState, stateDirectory } from "./state.ts";
import { JobStore, POLL_WINDOW_MS, type ProJob } from "./jobs.ts";
import { reportUsage, usageForAccount } from "./usage.ts";
import { renewWebSession, tokenExpiry } from "./authenticate.ts";

type JsonObject = Record<string, any>;

const CHATGPT_ORIGIN = "https://chatgpt.com";
const MODEL = "gpt-6-pro";
const MODEL_RESPONSE_CONTRACTS = [
  {
    id: "photo_upload_action.v1",
    protocol_version: 1,
    presets: ["cap:image", "cap:file", "placement:end"],
  },
];

function randomUuid(): string {
  return crypto.randomUUID();
}

function isIntegrityState(value: string): boolean {
  return value.length <= 2048 && value.trim() === value &&
    /^ois1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export function clientObservation(cookieHeader: string): string {
  const values = cookieHeader.split(";").map((part) => part.trim())
    .filter((part) => part.startsWith("__Secure-oai-is="))
    .map((part) => part.slice("__Secure-oai-is=".length));
  if (values.length === 0) return "v1.s.m";
  let state: string;
  try {
    state = decodeURIComponent(values[0]);
  } catch {
    return "v1.s.i";
  }
  if (
    !isIntegrityState(state) || !/^[A-Za-z0-9_-]{16}$/.test(state.split(".")[2])
  ) return "v1.s.i";
  // The nonce describes observed integrity state; it is not a random trace ID.
  return `v1.s.${values.length > 1 ? "d" : "p"}.${state.split(".")[2]}`;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/(openai-sentinel-[\w-]+\s*:\s*)[^\s,;]+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/[A-Za-z0-9_-]{180,}/g, "<redacted>");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeResponseSummary(body: string): string {
  try {
    const parsed = JSON.parse(body) as JsonObject;
    const detail = typeof parsed.detail === "string" ? parsed.detail : null;
    if (detail) return redactSensitiveText(detail).slice(0, 500);
  } catch {
    // Fall through to a bounded, redacted text response.
  }
  return redactSensitiveText(body.replace(/\s+/g, " ").trim()).slice(0, 500);
}

function assertRecord(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was missing`);
  }
  return value;
}

function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms = 90_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

class CookieJar {
  #values: Array<[string, string]> = [];
  #httpOnly = new Set<string>();

  private isHttpOnly(name: string): boolean {
    return this.#httpOnly.has(name) ||
      /^(?:__Secure-next-auth\.session-token(?:\.\d+)?|__Host-next-auth\.csrf-token|__cf_bm|cf_clearance|_cfuvid)$/
        .test(name);
  }

  scriptHeader(): string {
    return this.#values.filter(([name]) => !this.isHttpOnly(name))
      .map(([name, value]) => `${name}=${value}`).join("; ");
  }

  setFromScript(name: string, value: string): void {
    if (!this.isHttpOnly(name)) this.set(name, value);
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
      const value = decodeURIComponent(
        this.#values.find(([name]) => name === "__Secure-oai-is")?.[1] ?? "",
      );
      return isIntegrityState(value) ? value : null;
    } catch {
      return null;
    }
  }

  ingest(response: Response, expectedIntegrityState: string | null): void {
    const getSetCookie = (
      response.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie;
    const lines = getSetCookie ? getSetCookie.call(response.headers) : [];
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
    // Match the browser's compare-and-set rule: a late response must not
    // overwrite state already rotated by another response or Set-Cookie.
    if (
      update !== null && isIntegrityState(update) &&
      this.integrityState() === expectedIntegrityState
    ) {
      this.set("__Secure-oai-is", update);
    }
  }

  header(): string {
    return [...this.#values]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
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

export function parseWebSession(
  envText: string,
  allowExpired = false,
): WebSession {
  // This is one approved JSON credential field, not a general dotenv loader.
  const lines = envText.split(/\r?\n/).filter((line) =>
    /^CHATGPT_WEB_SESSION=/.test(line)
  );
  if (lines.length !== 1) {
    throw new Error(
      "Expected one CHATGPT_WEB_SESSION entry in state-directory .env",
    );
  }
  let encoded = lines[0].slice("CHATGPT_WEB_SESSION=".length).trim();
  if (encoded.startsWith("'") && encoded.endsWith("'")) {
    encoded = encoded.slice(1, -1);
  }
  let session: WebSession;
  try {
    const value = assertRecord(JSON.parse(encoded), "Web session");
    const headers = assertRecord(value.headers, "Web session headers");
    const clean: Record<string, string> = {};
    for (const [name, field] of Object.entries(headers)) {
      if (
        !WEB_HEADERS.has(name) || typeof field !== "string" ||
        /[\r\n]/.test(field)
      ) throw new Error();
      new Headers({ [name]: field });
      clean[name] = field;
    }
    for (
      const name of [
        "oai-device-id",
        "oai-session-id",
        "oai-client-build-number",
        "oai-client-version",
        "user-agent",
        "oai-language",
        "accept-language",
      ]
    ) {
      if (!clean[name]?.trim()) throw new Error();
    }
    const accessToken = requiredString(value.accessToken, "Token");
    const cookie = requiredString(value.cookie, "Cookie");
    if (/[\r\n\s]/.test(accessToken) || /[\r\n]/.test(cookie)) {
      throw new Error();
    }
    new Headers({ authorization: "Bearer " + accessToken, cookie });
    const cookies = new Map<string, string>();
    for (const part of cookie.split(";")) {
      const item = part.trim();
      const split = item.indexOf("=");
      const name = item.slice(0, split);
      if (
        split <= 0 ||
        (cookies.has(name) &&
          (name === "oai-did" || name === "__Secure-oai-is"))
      ) throw new Error();
      cookies.set(name, item.slice(split + 1));
    }
    if (
      decodeURIComponent(cookies.get("oai-did") ?? "") !==
        clean["oai-device-id"] ||
      !clientObservation(cookie).startsWith("v1.s.p.")
    ) throw new Error();
    session = { accessToken, cookie, headers: clean };
  } catch {
    // Parser and Headers errors can contain the credential value.
    throw new Error(
      "Invalid CHATGPT_WEB_SESSION structure, headers, or cookie binding",
    );
  }
  let expiry: unknown;
  try {
    const parts = session.accessToken.split(".");
    if (parts.length !== 3) throw new Error();
    expiry =
      JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).exp;
    if (typeof expiry !== "number" || !Number.isFinite(expiry)) {
      throw new Error();
    }
  } catch {
    throw new Error("Invalid web-session token expiry");
  }
  if (!allowExpired && (expiry as number) * 1000 <= Date.now()) {
    throw new Error(
      "ChatGPT web session expired; run scripts/authenticate.ts to sign in again",
    );
  }
  return session;
}

export async function loadWebSession(
  directory = stateDirectory(),
): Promise<WebSession> {
  const path = new URL(".env", directory);
  let text: string;
  try {
    const stat = await Deno.stat(path);
    if (stat.mode !== null && (stat.mode & 0o077) !== 0) {
      throw new Error();
    }
    text = await Deno.readTextFile(path);
  } catch {
    throw new Error(
      "Could not read owner-only ChatGPT session; run scripts/authenticate.ts (state .env requires mode 0600)",
    );
  }
  const session = parseWebSession(text, true);
  return tokenExpiry(session.accessToken) <= Date.now() + 300000
    ? await renewWebSession(directory)
    : session;
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
  // Accept DevTools Copy request headers, never execute copied cURL or JS.
  const headers: Record<string, string> = {};
  let accessToken = "", cookie = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^(GET|POST) \S+ HTTP\/[\d.]+$/.test(line)) continue;
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) {
      if (/^:(authority|method|path|scheme):/.test(line)) {
        if (
          line.startsWith(":authority:") &&
          line.slice(11).trim() !== "chatgpt.com"
        ) throw new Error("Import must come from chatgpt.com");
        continue;
      }
      throw new Error(
        "Expected copied request headers or a web-session JSON object",
      );
    }
    const name = match[1].toLowerCase().trim(), value = match[2];
    if (name === "authorization") {
      if (accessToken || !value.startsWith("Bearer ")) {
        throw new Error("Invalid imported authorization header");
      }
      accessToken = value.slice(7);
    } else if (name === "cookie") {
      if (cookie) throw new Error("Duplicate imported Cookie header");
      cookie = value;
    } else if (WEB_HEADERS.has(name)) headers[name] = value;
    else if (
      (name === "host" && value !== "chatgpt.com") ||
      (name === "origin" && value !== CHATGPT_ORIGIN)
    ) throw new Error("Import must come from chatgpt.com");
  }
  return parseWebSession(
    "CHATGPT_WEB_SESSION=" + JSON.stringify({ accessToken, cookie, headers }),
  );
}

export async function importWebSession(
  text: string,
  directory: URL,
): Promise<void> {
  const session = parseSessionImport(text);
  await ensurePrivateState(directory);
  const temporary = new URL(".auth-" + crypto.randomUUID() + ".tmp", directory);
  const encoded = JSON.stringify(session).replaceAll("'", "\\u0027");
  await Deno.writeTextFile(
    temporary,
    "CHATGPT_WEB_SESSION='" + encoded + "'\n",
    { mode: 0o600, createNew: true },
  );
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
  private readonly accessToken: string;

  constructor(session: WebSession) {
    this.accessToken = session.accessToken;
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
    headers.set("authorization", `Bearer ${this.accessToken}`);
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

type Listener = (event: any) => void;

function makeEventTarget(window: JsonObject): void {
  const listeners = new Map<string, Listener[]>();
  window.addEventListener = (type: string, listener: Listener) => {
    const current = listeners.get(type) ?? [];
    current.push(listener);
    listeners.set(type, current);
  };
  window.removeEventListener = (type: string, listener: Listener) => {
    const current = listeners.get(type) ?? [];
    const index = current.indexOf(listener);
    if (index >= 0) current.splice(index, 1);
  };
  window.dispatchEvent = (event: { type: string }) => {
    for (const listener of (listeners.get(event.type) ?? []).slice()) {
      listener.call(window, event);
    }
    return true;
  };
  window.__receiveMessage = (event: any) => {
    for (const listener of (listeners.get("message") ?? []).slice()) {
      listener.call(window, event);
    }
  };
}

function elementShim(extra: JsonObject = {}): JsonObject {
  const attributes = new Map<string, string>();
  const element: JsonObject = {
    style: {},
    children: [],
    ariaHidden: false,
    innerText: "",
    textContent: "",
    setAttribute(name: string, value: unknown) {
      attributes.set(name, String(value));
      element[name] = String(value);
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    appendChild(child: JsonObject) {
      element.children.push(child);
      return child;
    },
    removeChild(child: JsonObject) {
      const index = element.children.indexOf(child);
      if (index >= 0) element.children.splice(index, 1);
      return child;
    },
    getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      };
    },
    querySelector() {
      return null;
    },
    remove() {},
    ...extra,
  };
  return element;
}

function canvasShim(): JsonObject {
  const webgl = {
    getExtension(name: string) {
      if (name === "WEBGL_debug_renderer_info") {
        return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
      }
      return {};
    },
    getParameter(name: number) {
      if (name === 37445) return "WebGL Vendor";
      if (name === 37446) return "WebGL Renderer";
      return 0;
    },
    getSupportedExtensions() {
      return [];
    },
    getShaderPrecisionFormat() {
      return { precision: 23, rangeMin: 127, rangeMax: 127 };
    },
    getContextAttributes() {
      return {};
    },
  };
  return elementShim({
    width: 300,
    height: 150,
    getContext() {
      return webgl;
    },
    toDataURL() {
      return "data:image/png;base64,";
    },
    getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        width: 300,
        height: 150,
        top: 0,
        left: 0,
        right: 300,
        bottom: 150,
      };
    },
  });
}

function makeWindow(
  session: ChatSession,
  sdkUrl: string,
  frameUrl: string,
  kind: "outer" | "child",
  parent: JsonObject | null,
  onCreateChild?: () => JsonObject,
): JsonObject {
  const window: JsonObject = {};
  makeEventTarget(window);

  const location = new URL(kind === "child" ? frameUrl : `${CHATGPT_ORIGIN}/`);
  const performanceShim = {
    now: () => performance.now(),
    timeOrigin: performance.timeOrigin,
    memory: { jsHeapSizeLimit: 4_294_967_296 },
    getEntries: () => [],
    getEntriesByType: () => [],
  };
  const storage = new Map<string, string>();
  const localStorage = {
    get length() {
      return storage.size;
    },
    key(index: number) {
      return [...storage.keys()][index] ?? null;
    },
    getItem(key: string) {
      return storage.get(String(key)) ?? null;
    },
    setItem(key: string, value: unknown) {
      storage.set(String(key), String(value));
    },
    removeItem(key: string) {
      storage.delete(String(key));
    },
    clear() {
      storage.clear();
    },
  };

  window.window = window;
  window.self = window;
  window.globalThis = window;
  window.parent = parent ?? window;
  window.top = kind === "child" ? {} : window;
  window.location = location;
  window.screen = {
    width: 3840,
    height: 2160,
    availWidth: 3840,
    availHeight: 2160,
    colorDepth: 24,
    pixelDepth: 24,
  };
  window.innerWidth = 1505;
  window.innerHeight = 1581;
  window.devicePixelRatio = 2;
  window.performance = performanceShim;
  window.crypto = crypto;
  window.navigator = {
    userAgent: session.browserHeaders["user-agent"],
    language: "en-US",
    languages: ["en-US", "en"],
    hardwareConcurrency: 8,
    platform: "MacIntel",
    vendor: "Google Inc.",
    deviceMemory: 16,
    maxTouchPoints: 0,
    cookieEnabled: true,
    plugins: [],
    mimeTypes: [],
  };
  window.history = {
    length: 1,
    state: null,
    pushState() {},
    replaceState() {},
    go() {},
    back() {},
    forward() {},
  };
  window.localStorage = localStorage;
  window.Reflect = Reflect;
  window.__reactRouterContext = {
    state: {
      loaderData: {
        root: {
          clientBootstrap: {
            cfConnectingIp: "",
            cfIpCity: "",
            userRegion: "",
            cfIpLatitude: "",
            cfIpLongitude: "",
          },
        },
      },
    },
  };
  window.console = console;
  window.fetch = (input: string | URL, init?: RequestInit) =>
    session.fetch(input, init);
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.setInterval = setInterval;
  window.clearInterval = clearInterval;
  window.queueMicrotask = queueMicrotask;
  window.requestIdleCallback = (callback: (deadline: JsonObject) => void) => {
    return setTimeout(
      () => callback({ timeRemaining: () => 1, didTimeout: false }),
      0,
    );
  };
  window.cancelIdleCallback = clearTimeout;
  window.matchMedia = () => ({
    matches: false,
    media: "",
    addListener() {},
    removeListener() {},
  });
  window.getComputedStyle = () => ({ getPropertyValue: () => "" });
  window.Event = class {
    constructor(public readonly type: string) {}
  };

  window.crypto = crypto;
  window.atob = atob;
  window.btoa = btoa;
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  window.URL = URL;
  window.URLSearchParams = URLSearchParams;
  window.AbortController = AbortController;
  window.Headers = Headers;
  window.Request = Request;
  window.Response = Response;
  window.Promise = Promise;
  window.Map = Map;
  window.Set = Set;
  window.WeakMap = WeakMap;
  window.Uint8Array = Uint8Array;
  window.ArrayBuffer = ArrayBuffer;
  window.DataView = DataView;
  window.Date = Date;
  window.Math = Math;
  window.JSON = JSON;
  window.Object = Object;
  window.Array = Array;
  window.Number = Number;
  window.String = String;
  window.Boolean = Boolean;
  window.RegExp = RegExp;
  window.Error = Error;
  window.TypeError = TypeError;
  window.Function = Function;
  window.parseInt = parseInt;
  window.parseFloat = parseFloat;
  window.isNaN = isNaN;
  window.isFinite = isFinite;
  window.encodeURIComponent = encodeURIComponent;
  window.decodeURIComponent = decodeURIComponent;
  window.escape = escape;
  window.unescape = unescape;
  window.document = null;

  const currentScript = elementShim({ src: sdkUrl });
  const document: JsonObject = {
    currentScript,
    scripts: [currentScript],
    documentElement: elementShim(),
    body: null,
    head: null,
    defaultView: window,
    createElement(tag: string) {
      const normalized = tag.toLowerCase();
      if (normalized === "iframe") {
        const iframe = elementShim({
          src: "",
          contentWindow: null,
          contentDocument: null,
        });
        const iframeListeners = new Map<string, Listener[]>();
        iframe.addEventListener = (type: string, listener: Listener) => {
          const current = iframeListeners.get(type) ?? [];
          current.push(listener);
          iframeListeners.set(type, current);
        };
        iframe.dispatchEvent = (event: { type: string }) => {
          for (
            const listener of (iframeListeners.get(event.type) ?? []).slice()
          ) {
            listener.call(iframe, event);
          }
        };
        return iframe;
      }
      if (normalized === "canvas") return canvasShim();
      return elementShim();
    },
    getElementsByTagName(tag: string) {
      if (tag === "head") return [document.head];
      if (tag === "body") return [document.body];
      if (tag === "script") return document.scripts;
      return [];
    },
    get cookie() {
      return session.cookies.scriptHeader();
    },
    set cookie(value: string) {
      const first = value.split(";", 1)[0];
      const separator = first.indexOf("=");
      if (separator > 0) {
        session.cookies.setFromScript(
          first.slice(0, separator).trim(),
          first.slice(separator + 1),
        );
      }
    },
  };
  document.head = elementShim({
    appendChild(element: JsonObject) {
      if (typeof element.onload === "function") {
        queueMicrotask(() => element.onload());
      }
      return element;
    },
  });
  document.body = elementShim({
    appendChild(element: JsonObject) {
      if (element?.contentWindow === null && onCreateChild) {
        const child = onCreateChild();
        element.contentWindow = child;
        element.contentDocument = child.document;
        window.__childWindow = child;
        element.contentWindow.postMessage = (data: unknown, origin: string) => {
          child.__receiveMessage({ data, origin, source: window });
        };
        queueMicrotask(() => element.dispatchEvent({ type: "load" }));
      }
      return element;
    },
  });
  window.document = document;
  window.document.location = location;

  window.postMessage = (data: unknown, origin: string) => {
    if (kind === "child" && parent) {
      parent.__receiveMessage({ data, origin, source: window });
    } else {
      window.__receiveMessage({ data, origin, source: window.__childWindow });
    }
  };

  return window;
}

function patchSentinelSdk(source: string): string {
  const withEngine = source.replace(
    "var E=new O;",
    "var E=new O;window.__uosSentinelEngine=E;",
  );
  const withVm = withEngine.replace(
    'var _n="undefined"!=typeof globalThis?',
    'window.__uosSentinelRunTurnstile=Rn;window.__uosSentinelBindProof=D;var _n="undefined"!=typeof globalThis?',
  );
  if (withVm === source) {
    throw new Error(
      "The fetched Sentinel SDK did not match the known interface",
    );
  }
  return withVm;
}

export class SentinelHarness {
  private constructor(
    private readonly session: ChatSession,
    private readonly sdkSource: string,
    private readonly sdkUrl: string,
  ) {}

  static async create(session: ChatSession): Promise<SentinelHarness> {
    const bootstrapResponse = await session.fetch(
      `${CHATGPT_ORIGIN}/backend-api/sentinel/sdk.js`,
    );
    if (!bootstrapResponse.ok) {
      throw new Error(
        `Sentinel bootstrap returned ${bootstrapResponse.status}: ${
          safeResponseSummary(await bootstrapResponse.text())
        }`,
      );
    }
    const bootstrap = await bootstrapResponse.text();
    const sdkUrl = bootstrap.match(
      /https:\/\/chatgpt\.com\/sentinel\/[^'" ]+\/sdk\.js/,
    )?.[0];
    if (!sdkUrl) {
      throw new Error("Sentinel bootstrap did not provide an SDK URL");
    }

    const sdkResponse = await session.fetch(sdkUrl);
    if (!sdkResponse.ok) {
      throw new Error(
        `Sentinel SDK returned ${sdkResponse.status}: ${
          safeResponseSummary(await sdkResponse.text())
        }`,
      );
    }
    return new SentinelHarness(
      session,
      patchSentinelSdk(await sdkResponse.text()),
      sdkUrl,
    );
  }

  async chatRequirements(): Promise<{
    proof: string;
    turnstile: string;
    chatRequirementsToken: string;
  }> {
    const version = this.sdkUrl.match(/\/sentinel\/([^/]+)\//)?.[1];
    if (!version) {
      throw new Error("Could not identify the Sentinel SDK version");
    }
    const frameUrl = `${CHATGPT_ORIGIN}/backend-api/sentinel/frame.html?sv=${
      encodeURIComponent(version)
    }`;

    let child: JsonObject | null = null;
    const outer = makeWindow(
      this.session,
      this.sdkUrl,
      frameUrl,
      "outer",
      null,
      () => {
        child = makeWindow(this.session, this.sdkUrl, frameUrl, "child", outer);
        createContext(child);
        runInContext(this.sdkSource, child, { filename: "sentinel-child.js" });
        return child;
      },
    );
    createContext(outer);
    runInContext(this.sdkSource, outer, { filename: "sentinel-outer.js" });
    if (!child) throw new Error("Sentinel iframe context was not created");

    const engine = outer.__uosSentinelEngine;
    const bindProof = outer.__uosSentinelBindProof;
    const runTurnstile = outer.__uosSentinelRunTurnstile;
    if (!engine || typeof engine.getRequirementsToken !== "function") {
      throw new Error("Sentinel proof engine was not exposed by the SDK");
    }
    if (typeof bindProof !== "function" || typeof runTurnstile !== "function") {
      throw new Error("Sentinel Turnstile VM was not exposed by the SDK");
    }

    const proof = requiredString(
      await withTimeout(
        Promise.resolve(engine.getRequirementsToken()),
        "Sentinel proof generation",
      ),
      "Sentinel proof",
    );
    const prepareResponse = await this.session.fetch(
      `${CHATGPT_ORIGIN}/backend-api/sentinel/chat-requirements/prepare`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ p: proof }),
      },
    );
    const prepareBody = await prepareResponse.text();
    if (!prepareResponse.ok) {
      throw new Error(
        `Chat requirements prepare returned ${prepareResponse.status}: ${
          safeResponseSummary(prepareBody)
        }`,
      );
    }
    const requirements = assertRecord(
      JSON.parse(prepareBody),
      "Chat requirements prepare response",
    );
    const turnstile = assertRecord(
      requirements.turnstile,
      "Chat requirements Turnstile",
    );
    const prepareToken = requiredString(
      requirements.prepare_token,
      "Chat requirements prepare token",
    );

    bindProof(requirements, proof);
    // Use the public SDK method: the low-level generator omits protocol framing.
    const finalProof = requiredString(
      await withTimeout(
        Promise.resolve(engine.getEnforcementToken(requirements)),
        "Chat requirements proof-of-work",
      ),
      "Chat requirements proof-of-work answer",
    );
    const turnstileValue = turnstile.required
      ? requiredString(
        await withTimeout(
          Promise.resolve(
            runTurnstile(
              requirements,
              requiredString(turnstile.dx, "Turnstile VM"),
            ),
          ),
          "Turnstile VM",
        ),
        "Turnstile answer",
      )
      : "";
    if (/^\d+:\s+(?:TypeError|Error):/.test(atobSafe(turnstileValue))) {
      throw new Error("The Sentinel Turnstile VM returned an execution error");
    }

    const finalizeResponse = await this.session.fetch(
      `${CHATGPT_ORIGIN}/backend-api/sentinel/chat-requirements/finalize`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          prepare_token: prepareToken,
          proofofwork: finalProof,
          turnstile: turnstileValue,
        }),
      },
    );
    const finalizeBody = await finalizeResponse.text();
    if (!finalizeResponse.ok) {
      throw new Error(
        `Chat requirements finalize returned ${finalizeResponse.status}: ${
          safeResponseSummary(finalizeBody)
        }`,
      );
    }
    const final = assertRecord(
      JSON.parse(finalizeBody),
      "Chat requirements finalize response",
    );
    return {
      proof: finalProof,
      turnstile: turnstileValue,
      chatRequirementsToken: requiredString(
        final.token,
        "Chat requirements token",
      ),
    };
  }
}

function atobSafe(value: string): string {
  try {
    return atob(value);
  } catch {
    return "";
  }
}

export interface ParsedSse {
  text: string;
  terminal: boolean;
  eventTypes: string[];
  conversationId?: string;
}

export function completedAnswer(parsed: ParsedSse): string {
  if (parsed.eventTypes.includes("stream_handoff")) {
    throw new Error(
      "Conversation handed off to a background stream; retrieve the answer from the conversation instead of resubmitting the prompt.",
    );
  }
  if (!parsed.terminal) {
    throw new Error(
      "Conversation stream ended before completion; do not resubmit the prompt automatically.",
    );
  }
  if (!parsed.text.trim()) {
    throw new Error("Conversation stream ended without assistant text");
  }
  return parsed.text;
}

export function answerForMessage(
  conversation: JsonObject,
  messageId: string,
): string | undefined {
  const mapping = assertRecord(conversation.mapping, "Conversation mapping");
  // Other turns can advance current_node while this job is pending. Search all
  // completed finals, but accept only an unambiguous answer for this user turn.
  const answers = new Set<string>();
  for (const node of Object.values(mapping)) {
    const message = node?.message;
    if (
      message?.author?.role !== "assistant" || message.channel !== "final" ||
      message.status !== "finished_successfully" || message.end_turn !== true ||
      message.content?.content_type !== "text" ||
      !Array.isArray(message.content.parts) ||
      (message.metadata?.model_slug && message.metadata.model_slug !== MODEL)
    ) continue;
    let parent = node.parent;
    const visited = new Set<string>();
    while (typeof parent === "string" && !visited.has(parent)) {
      visited.add(parent);
      const ancestor = mapping[parent];
      if (!ancestor) break;
      if (ancestor.message?.author?.role === "user") {
        if (ancestor.message.id === messageId) {
          const text = message.content.parts.filter((part: unknown) =>
            typeof part === "string"
          ).join("");
          if (text.trim()) answers.add(text);
        }
        break;
      }
      parent = ancestor.parent;
    }
  }
  return answers.size === 1 ? [...answers][0] : undefined;
}

export interface PollOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function pollJob(
  session: Pick<ChatSession, "fetch">,
  job: ProJob,
  save: (job: ProJob) => Promise<void>,
  options: PollOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + POLL_WINDOW_MS;
  const conversationId = requiredString(
    job.conversationId,
    "Job conversation ID",
  );
  job.status = "pending";
  await save(job);
  while (now() < deadline) {
    // Keep server and local backoff across process interruption and --result.
    const nextPollAt = Date.parse(job.nextPollAt ?? "");
    if (nextPollAt > now()) {
      await sleep(Math.min(nextPollAt - now(), deadline - now()));
      continue;
    }
    let retryable = false;
    let completed: string | undefined;
    let delay = job.pollCount < 6 ? 5000 : 30_000;
    try {
      const response = await session.fetch(
        CHATGPT_ORIGIN + "/backend-api/conversation/" +
          encodeURIComponent(conversationId),
        {
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(60_000, deadline - now())),
          ),
          headers: { accept: "application/json" },
        },
      );
      job.pollCount++;
      job.lastPollAt = new Date(now()).toISOString();
      if (
        response.status === 429 || response.status >= 500 ||
        response.status === 404
      ) {
        if (response.status === 429) {
          job.rateLimitCount = (job.rateLimitCount ?? 0) + 1;
          delay = Math.max(
            delay,
            Math.min(
              900_000,
              60_000 * 2 ** Math.min(job.rateLimitCount - 1, 4),
            ),
          );
        }
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryMs = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter ?? "") - now();
        if (Number.isFinite(retryMs) && retryMs > 0) {
          delay = Math.max(delay, retryMs);
        }
        await response.body?.cancel();
        job.lastError = "Conversation retrieval returned HTTP " +
          response.status;
        retryable = true;
      } else if (!response.ok) {
        await response.body?.cancel();
        job.lastError = "Conversation retrieval returned HTTP " +
          response.status + "; resume this job after resolving access";
      } else {
        const conversation = assertRecord(
          await response.json(),
          "Conversation response",
        );
        const answer = answerForMessage(conversation, job.messageId);
        delete job.rateLimitCount;
        delete job.nextPollAt;
        delete job.lastError;
        if (answer !== undefined) {
          completed = answer;
        }
        retryable = true;
      }
    } catch {
      // A read failure is safe to retry. Never repeat the conversation POST.
      job.lastError =
        "Conversation retrieval interrupted; retrying the existing job";
      retryable = true;
    }
    if (completed !== undefined) {
      job.answer = completed;
      job.status = "completed";
      await save(job);
      return completed;
    }
    if (retryable) job.nextPollAt = new Date(now() + delay).toISOString();
    await save(job);
    if (!retryable) throw new Error(job.lastError);
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(delay, remaining));
  }
  job.status = "timed_out";
  job.lastError =
    "No completed answer within six hours; resume this job without resubmitting";
  await save(job);
  throw new Error(job.lastError);
}

function appendAssistantValue(
  value: JsonObject,
  messages: Map<string, string>,
  fallback: { value: string },
): void {
  const message = value.v?.message ?? value.message;
  if (message && typeof message === "object") {
    const role = message.author?.role;
    const parts = message.content?.parts;
    if (role === "assistant" && Array.isArray(parts)) {
      const text = parts.filter((part: unknown) => typeof part === "string")
        .join("");
      const id = typeof message.id === "string"
        ? message.id
        : `message-${messages.size}`;
      messages.set(id, text);
    }
  }
  if (value.o === "append" && typeof value.v === "string") {
    fallback.value += value.v;
  }
}

export function parseSseText(raw: string): ParsedSse {
  const messages = new Map<string, string>();
  const fallback = { value: "" };
  const eventTypes: string[] = [];
  let event = "message";
  let dataLines: string[] = [];
  let terminal = false;
  let conversationId: string | undefined;

  const flush = () => {
    if (dataLines.length === 0) {
      event = "message";
      return;
    }
    const data = dataLines.join("\n");
    if (event !== "message") eventTypes.push(event);
    if (data === "[DONE]") {
      terminal = true;
    } else {
      try {
        const parsed = JSON.parse(data) as JsonObject;
        if (typeof parsed.conversation_id === "string") {
          conversationId = parsed.conversation_id;
        }
        if (
          parsed.type === "stream_handoff" ||
          parsed.type === "conversation_detail_metadata"
        ) {
          eventTypes.push(String(parsed.type));
        }
        appendAssistantValue(parsed, messages, fallback);
      } catch {
        // Ignore the protocol's non-JSON encoding marker and malformed keepalives.
      }
    }
    event = "message";
    dataLines = [];
  };

  for (const line of raw.replaceAll("\r\n", "\n").split("\n")) {
    if (line === "") {
      flush();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();

  const text = messages.size > 0
    ? [...messages.values()].join("\n")
    : fallback.value;
  return { text, terminal, eventTypes, conversationId };
}

export function conversationBody(
  prompt: string,
  messageId: string,
): JsonObject {
  return {
    action: "next",
    messages: [
      {
        id: messageId,
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content: { content_type: "text", parts: [prompt] },
        metadata: {
          selected_sources: [],
          serialization_metadata: { custom_symbol_offsets: [] },
          submission_mode: "manual_send",
        },
      },
    ],
    parent_message_id: "client-created-root",
    model: MODEL,
    client_prepare_state: "sent",
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    conversation_mode: { kind: "primary_assistant" },
    enable_message_followups: true,
    system_hints: [],
    model_response_contracts: MODEL_RESPONSE_CONTRACTS,
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_contextual_info: {
      is_dark_mode: true,
      time_since_loaded: 0,
      page_height: 1581,
      page_width: 1505,
      pixel_ratio: 2,
      screen_height: 2160,
      screen_width: 3840,
      app_name: "chatgpt.com",
      has_web_push_capabilities: true,
      web_push_notification_permission: "default",
    },
    paragen_cot_summary_display_override: "allow",
    force_parallel_switch: "auto",
    thinking_effort: "standard",
    local_function_names: ["local.continue_in_work"],
  };
}

async function submitConversation(
  session: ChatSession,
  job: ProJob,
  store: JobStore,
): Promise<void> {
  const prompt = job.prompt;
  const sentinel = await SentinelHarness.create(session);
  const requirements = await sentinel.chatRequirements();
  const traceId = randomUuid();
  const messageId = job.messageId;

  const prepareBody = {
    action: "next",
    parent_message_id: "client-created-root",
    model: MODEL,
    client_prepare_state: "success",
    client_prepare_dispatch: "immediate",
    client_prepare_source: "context_change",
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    conversation_mode: { kind: "primary_assistant" },
    system_hints: [],
    model_response_contracts: MODEL_RESPONSE_CONTRACTS,
    partial_query: {
      id: messageId,
      author: { role: "user" },
      content: { content_type: "text", parts: [prompt] },
    },
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_contextual_info: {
      app_name: "chatgpt.com",
      has_web_push_capabilities: true,
      web_push_notification_permission: "default",
    },
    thinking_effort: "standard",
    local_function_names: ["local.continue_in_work"],
  };
  const prepare = await session.fetch(
    `${CHATGPT_ORIGIN}/backend-api/f/conversation/prepare`,
    {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "x-oai-turn-trace-id": traceId,
        "x-openai-target-path": "/backend-api/f/conversation/prepare",
        "x-openai-target-route": "/backend-api/f/conversation/prepare",
      },
      body: JSON.stringify(prepareBody),
    },
  );
  const prepareText = await prepare.text();
  if (!prepare.ok) {
    throw new Error(
      `Conversation prepare returned ${prepare.status}: ${
        safeResponseSummary(prepareText)
      }`,
    );
  }

  job.status = "submitting";
  job.submissionAttemptedAt = new Date().toISOString();
  await store.save(job);
  const response = await session.fetch(
    `${CHATGPT_ORIGIN}/backend-api/f/conversation`,
    {
      signal: AbortSignal.timeout(POLL_WINDOW_MS),
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "oai-genui-client-actions": "open_entity_detail",
        "x-oai-is-client-observation": clientObservation(
          session.cookies.header(),
        ),
        "x-oai-is-pending-updates": '{"v":3,"updates":[]}',
        "x-oai-turn-trace-id": traceId,
        "openai-sentinel-chat-requirements-token":
          requirements.chatRequirementsToken,
        "openai-sentinel-proof-token": requirements.proof,
        "openai-sentinel-turnstile-token": requirements.turnstile,
        "x-openai-target-path": "/backend-api/f/conversation",
        "x-openai-target-route": "/backend-api/f/conversation",
      },
      body: JSON.stringify(conversationBody(prompt, messageId)),
    },
  );
  if (!response.ok) {
    job.status = response.status >= 400 && response.status < 500
      ? "failed"
      : "uncertain";
    job.lastError = "Conversation returned HTTP " + response.status +
      "; do not resubmit automatically";
    await response.body?.cancel();
    await store.save(job);
    throw new Error(job.lastError);
  }
  await captureConversation(response, async (id) => {
    if (job.conversationId && job.conversationId !== id) {
      throw new Error("Conversation ID changed during submission");
    }
    job.conversationId = id;
    job.status = "pending";
    await store.save(job);
  });
  if (!job.conversationId) {
    throw new Error("Submission ended without a recoverable conversation ID");
  }
}

export async function captureConversation(
  response: Response,
  saveId: (id: string) => Promise<void>,
): Promise<void> {
  if (!response.body) throw new Error("Submission returned no stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let saved: string | undefined;
  const consume = async (frame: string) => {
    const parsed = parseSseText(frame);
    if (parsed.conversationId && parsed.conversationId !== saved) {
      await saveId(parsed.conversationId);
      saved = parsed.conversationId;
    }
    return parsed.terminal || parsed.eventTypes.includes("stream_handoff");
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer) await consume(buffer);
        break;
      }
      buffer += value;
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (await consume(frame)) return;
      }
      if (buffer.length > 8 * 1024 * 1024) {
        throw new Error("Submission event exceeded the supported size");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function accountIdForSession(session: WebSession): string {
  if (session.headers["chatgpt-account-id"]) {
    return session.headers["chatgpt-account-id"];
  }
  try {
    const claims = JSON.parse(
      atob(
        session.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"),
      ),
    );
    return typeof claims["https://api.openai.com/auth"]?.chatgpt_account_id ===
        "string"
      ? claims["https://api.openai.com/auth"].chatgpt_account_id
      : "";
  } catch {
    return "";
  }
}

async function accountIdentity(session: WebSession): Promise<string> {
  const parts = session.accessToken.split(".");
  let claims: JsonObject;
  try {
    claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw new Error("Invalid web-session identity");
  }
  const subject = requiredString(claims.sub, "Web-session subject");
  const account = session.headers["chatgpt-account-id"] ??
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? "";
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([subject, account])),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function submitJob(
  prompt: string,
  store = new JobStore(),
  onCreated?: (job: ProJob) => void,
): Promise<ProJob> {
  const auth = await loadWebSession(new URL("../", store.directory));
  const job = await store.create(prompt, await accountIdentity(auth));
  onCreated?.(job);
  try {
    // Cached advisory lookup only; it never creates a model conversation.
    try {
      await usageForAccount(store, job.account, {
        session: new ChatSession(auth),
        accountId: accountIdForSession(auth),
      });
    } catch {
      /* An unavailable estimate must not block the requested query. */
    }
    return await store.withLock(job.id, async (current) => {
      try {
        await submitConversation(new ChatSession(auth), current, store);
      } catch (error) {
        if (current.conversationId) {
          current.status = "pending";
          current.lastError =
            "Initial stream interrupted; retrieve the existing conversation";
        } else {
          if (current.status !== "failed") {
            current.status = current.status === "preparing"
              ? "failed"
              : "uncertain";
          }
          current.lastError ??= current.status === "uncertain"
            ? "Submission outcome unknown; do not resubmit automatically"
            : "Preparation failed before submission";
          await store.save(current);
          throw new Error(current.lastError + "; job " + current.id);
        }
      }
      await store.save(current);
      return current;
    });
  } finally {
    await reportUsage(store, job.account);
  }
}

export async function resultForJob(
  id: string,
  store = new JobStore(),
): Promise<string> {
  return await store.withLock(id, async (job) => {
    await reportUsage(store, job.account);
    if (job.status === "completed") {
      return requiredString(job.answer, "Saved answer");
    }
    if (!job.conversationId) {
      throw new Error(
        "Job has no conversation ID (" + job.status +
          "); do not resubmit automatically",
      );
    }
    const auth = await loadWebSession(new URL("../", store.directory));
    if (await accountIdentity(auth) !== job.account) {
      throw new Error("Web-session account does not match this job");
    }
    return await pollJob(
      new ChatSession(auth),
      job,
      (value) => store.save(value),
    );
  });
}

export async function run(
  prompt: string,
  store = new JobStore(),
): Promise<string> {
  const job = await submitJob(
    prompt,
    store,
    (job) => console.error("GPT Pro job: " + job.id),
  );
  return await resultForJob(job.id, store);
}

function jobSummary(job: ProJob) {
  return {
    jobId: job.id,
    status: job.status,
    model: job.model,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastPollAt: job.lastPollAt,
    pollCount: job.pollCount,
    rateLimitCount: job.rateLimitCount,
    nextPollAt: job.nextPollAt,
    conversationKnown: !!job.conversationId,
    promptPreview: job.prompt.slice(0, 120),
    lastError: job.lastError,
  };
}

export async function main(args: string[]): Promise<void> {
  let directory: URL | undefined;
  if (args[0] === "--state-dir") {
    if (!args[1]) throw new Error("--state-dir requires an absolute path");
    directory = stateDirectory(args[1]);
    args = args.slice(2);
  }
  const command = args[0];
  if (command === "--help") {
    console.log(
      "Usage: ask-gpt-pro.ts [--state-dir /absolute/path] [--background] [--] <prompt>\n       ask-gpt-pro.ts --jobs | --status <job-id> | --result <job-id> | --watch\nSetup: --auth-import <file|-> | --auth-check\nPrompts may also be piped on stdin. Results are cached; retrieval never submits.\n--watch retrieves the current pending jobs concurrently and prints JSON lines.",
    );
    return;
  }
  directory ??= stateDirectory();
  const store = new JobStore(new URL(".gpt-pro-jobs/", directory));
  if (command === "--auth-import") {
    if (args.length !== 2) {
      throw new Error(
        "--auth-import requires a private file path or - for stdin",
      );
    }
    const text = args[1] === "-"
      ? await new Response(Deno.stdin.readable).text()
      : await Deno.readTextFile(args[1]);
    await importWebSession(text, directory);
    console.log(JSON.stringify({ status: "imported", modelSubmission: false }));
    return;
  }
  if (command === "--auth-check") {
    if (args.length !== 1) throw new Error("--auth-check takes no arguments");
    const auth = await loadWebSession(directory);
    const session = new ChatSession(auth);
    await reportUsage(store, await accountIdentity(auth), {
      session,
      accountId: accountIdForSession(auth),
    });
    const response = await session.fetch(
      CHATGPT_ORIGIN + "/backend-api/models",
      { signal: AbortSignal.timeout(30000) },
    );
    await response.body?.cancel();
    console.log(
      JSON.stringify({
        authenticated: response.ok,
        httpStatus: response.status,
        submissionEligibility: "not_tested",
        modelSubmission: false,
      }),
    );
    if (!response.ok) Deno.exitCode = 1;
    return;
  }
  if (command === "--jobs") {
    if (args.length !== 1) throw new Error("--jobs takes no arguments");
    const jobs = await store.list();
    for (const account of new Set(jobs.map((job) => job.account))) {
      await reportUsage(store, account);
    }
    console.log(JSON.stringify(jobs.map(jobSummary)));
    return;
  }
  if (command === "--status" || command === "--result") {
    if (args.length !== 2) throw new Error(command + " requires one job ID");
    if (command === "--status") {
      const job = await store.read(args[1]);
      await reportUsage(store, job.account);
      console.log(JSON.stringify(jobSummary(job)));
    } else console.log(await resultForJob(args[1], store));
    return;
  }
  if (command === "--watch") {
    if (args.length !== 1) throw new Error("--watch takes no arguments");
    const pending = (await store.list()).filter((job) =>
      job.conversationId && job.status !== "completed" &&
      job.status !== "failed"
    );
    await Promise.all(pending.map(async (job) => {
      try {
        const answer = await resultForJob(job.id, store);
        console.log(
          JSON.stringify({ jobId: job.id, status: "completed", answer }),
        );
      } catch (error) {
        console.log(
          JSON.stringify({
            jobId: job.id,
            status: (await store.read(job.id)).status,
            error: redactSensitiveText(errorText(error)),
          }),
        );
        Deno.exitCode = 1;
      }
    }));
    return;
  }
  const background = command === "--background";
  let promptArgs = background ? args.slice(1) : args;
  if (promptArgs[0] === "--") promptArgs = promptArgs.slice(1);
  else if (promptArgs[0]?.startsWith("--")) {
    throw new Error(
      "Unknown option; use -- before a prompt that starts with --",
    );
  }
  let prompt = promptArgs.join(" ").trim();
  if (!prompt) prompt = (await new Response(Deno.stdin.readable).text()).trim();
  if (!prompt) throw new Error("Provide a prompt as arguments or stdin");
  if (background) {
    const job = await submitJob(
      prompt,
      store,
      (job) => console.error("GPT Pro job: " + job.id),
    );
    console.log(JSON.stringify(jobSummary(job)));
  } else console.log(await run(prompt, store));
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(redactSensitiveText(errorText(error)));
    Deno.exitCode = 1;
  }
}
