import { createContext, runInContext } from "node:vm";

type JsonObject = Record<string, any>;

const CHATGPT_ORIGIN = "https://chatgpt.com";
const MODEL = "gpt-6-pro";
const CLIENT_BUILD = "10328501";
const CLIENT_VERSION = "prod-0284065d19c970cfd6e970c173150f4d17d52d73";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

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
  #values = new Map<string, string>();

  set(name: string, value: string): void {
    this.#values.set(name, value);
  }

  ingest(response: Response): void {
    const getSetCookie = (
      response.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie;
    const lines = getSetCookie ? getSetCookie.call(response.headers) : [];
    for (const line of lines) {
      const first = line.split(";", 1)[0];
      const separator = first.indexOf("=");
      if (separator > 0) {
        this.set(first.slice(0, separator), first.slice(separator + 1));
      }
    }
  }

  header(): string {
    return [...this.#values]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

interface AuthDocument {
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
}

async function loadAuth(): Promise<{ accessToken: string; accountId: string }> {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  const codexHome = Deno.env.get("CODEX_HOME") ??
    (home ? `${home}/.codex` : null);
  if (!codexHome) throw new Error("HOME or CODEX_HOME was not available");

  const authPath = `${codexHome}/auth.json`;
  let auth: AuthDocument;
  try {
    auth = JSON.parse(await Deno.readTextFile(authPath)) as AuthDocument;
  } catch {
    throw new Error(`Could not read ${authPath}`);
  }

  const accessToken = requiredString(
    auth.tokens?.access_token,
    "ChatGPT access token",
  );
  const accountId = requiredString(
    auth.tokens?.account_id,
    "ChatGPT account id",
  );
  return { accessToken, accountId };
}

class ChatSession {
  readonly deviceId = randomUuid();
  readonly sessionId = randomUuid();
  readonly cookies = new CookieJar();
  readonly browserHeaders: Record<string, string>;

  constructor(
    private readonly accessToken: string,
    private readonly accountId: string,
  ) {
    this.cookies.set("oai-did", this.deviceId);
    this.browserHeaders = {
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      "oai-client-build-number": CLIENT_BUILD,
      "oai-client-version": CLIENT_VERSION,
      "oai-device-id": this.deviceId,
      "oai-language": "en-US",
      "oai-session-id": this.sessionId,
      origin: CHATGPT_ORIGIN,
      pragma: "no-cache",
      referer: `${CHATGPT_ORIGIN}/`,
      "sec-ch-ua": '"Not=A?Brand";v="99", "Brave";v="151", "Chromium";v="151"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-model": '""',
      "sec-ch-ua-platform": '"macOS"',
      "sec-ch-ua-platform-version": '"26.6.1"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "sec-gpc": "1",
      "user-agent": USER_AGENT,
    };
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(this.browserHeaders)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${this.accessToken}`);
    headers.set("chatgpt-account-id", this.accountId);
    const cookie = this.cookies.header();
    if (cookie) headers.set("cookie", cookie);

    const response = await fetch(input, { ...init, headers });
    this.cookies.ingest(response);
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
    userAgent: USER_AGENT,
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
      return session.cookies.header();
    },
    set cookie(value: string) {
      const first = value.split(";", 1)[0];
      const separator = first.indexOf("=");
      if (separator > 0) {
        session.cookies.set(
          first.slice(0, separator),
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

class SentinelHarness {
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
    const pow = assertRecord(
      requirements.proofofwork,
      "Chat requirements proof-of-work",
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
    const finalProof = requiredString(
      await withTimeout(
        Promise.resolve(engine._generateAnswerAsync(pow.seed, pow.difficulty)),
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
  let nodeId = conversation.current_node;
  const visited = new Set<string>();
  let answer: string | undefined;
  while (typeof nodeId === "string" && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = mapping[nodeId];
    if (!node || typeof node !== "object") return undefined;
    const message = node.message;
    if (message?.author?.role === "user") {
      return message.id === messageId ? answer : undefined;
    }
    if (
      answer === undefined && message?.author?.role === "assistant" &&
      message.channel === "final" &&
      message.status === "finished_successfully" && message.end_turn === true &&
      message.content?.content_type === "text" &&
      Array.isArray(message.content.parts)
    ) {
      const text = message.content.parts.filter((part: unknown) =>
        typeof part === "string"
      ).join("");
      if (text.trim()) answer = text;
    }
    nodeId = node.parent;
  }
  return undefined;
}

async function waitForAnswer(
  session: ChatSession,
  conversationId: string,
  messageId: string,
): Promise<string> {
  const signal = AbortSignal.timeout(30 * 60 * 1000);
  while (!signal.aborted) {
    const response = await session.fetch(
      `${CHATGPT_ORIGIN}/backend-api/conversation/${
        encodeURIComponent(conversationId)
      }`,
      { signal, headers: { accept: "application/json" } },
    );
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Conversation retrieval returned ${response.status}: ${
          safeResponseSummary(body)
        }`,
      );
    }
    const answer = answerForMessage(
      assertRecord(JSON.parse(body), "Conversation response"),
      messageId,
    );
    if (answer !== undefined) return answer;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    "Background answer was not ready within 30 minutes; do not resubmit the prompt automatically.",
  );
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

function conversationBody(prompt: string, messageId: string): JsonObject {
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
    timezone_offset_min: new Date().getTimezoneOffset() * -1,
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

async function run(prompt: string): Promise<string> {
  const { accessToken, accountId } = await loadAuth();
  const session = new ChatSession(accessToken, accountId);
  const sentinel = await SentinelHarness.create(session);
  const requirements = await sentinel.chatRequirements();
  const traceId = randomUuid();
  const messageId = randomUuid();

  const prepareBody = {
    action: "next",
    parent_message_id: "client-created-root",
    model: MODEL,
    client_prepare_state: "success",
    client_prepare_dispatch: "immediate",
    client_prepare_source: "context_change",
    timezone_offset_min: new Date().getTimezoneOffset() * -1,
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

  const response = await session.fetch(
    `${CHATGPT_ORIGIN}/backend-api/f/conversation`,
    {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "oai-genui-client-actions": "open_entity_detail",
        "oai-is-client-observation": `v1.s.p.${
          randomUuid().replaceAll("-", "").slice(0, 16)
        }`,
        "oai-is-pending-updates": '{"v":3,"updates":[]}',
        "oai-turn-trace-id": traceId,
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
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Conversation returned ${response.status}: ${safeResponseSummary(body)}`,
    );
  }
  const parsed = parseSseText(body);
  if (parsed.eventTypes.includes("stream_handoff")) {
    return await waitForAnswer(
      session,
      requiredString(parsed.conversationId, "Background conversation id"),
      messageId,
    );
  }
  return completedAnswer(parsed);
}

async function readPrompt(): Promise<string> {
  const fromArgs = Deno.args.join(" ").trim();
  if (fromArgs) return fromArgs;
  const fromStdin = await new Response(Deno.stdin.readable).text();
  const prompt = fromStdin.trim();
  if (!prompt) throw new Error("Provide a prompt as arguments or stdin");
  return prompt;
}

if (import.meta.main) {
  try {
    console.log(await run(await readPrompt()));
  } catch (error) {
    console.error(redactSensitiveText(errorText(error)));
    Deno.exitCode = 1;
  }
}
