import { createContext, runInContext } from "node:vm";
import { ChatSession } from "./session.ts";
import {
  assertRecord,
  callable,
  CHATGPT_ORIGIN,
  type DynamicFunction,
  type JsonObject,
  objectValue,
  requiredString,
  requiredValue,
  safeResponseSummary,
  withTimeout,
} from "./shared.ts";

/** Listeners are registered by the bundle, so the event payload is only ever forwarded. */
type Listener = (event: unknown) => void;

/** A shim window as makeWindow builds it: the bag of globals plus the frame message receiver. */
type ShimWindow = JsonObject & { __receiveMessage: Listener };

function makeEventTarget(window: JsonObject): Listener {
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
  function receiveMessage(event: unknown): void {
    for (const listener of (listeners.get("message") ?? []).slice()) {
      listener.call(window, event);
    }
  }
  window.__receiveMessage = receiveMessage;
  return receiveMessage;
}

function elementShim(extra: JsonObject = {}): JsonObject {
  const attributes = new Map<string, string>();
  // The children array is bound here so the shim can reach it with real types while the
  // bundle keeps seeing the same array behind element.children.
  const children: JsonObject[] = [];
  const element: JsonObject = {
    style: {},
    children,
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
      children.push(child);
      return child;
    },
    removeChild(child: JsonObject) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
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
    getParameter(name: number): unknown {
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

const ESCAPE_UNESCAPED = /[^A-Za-z0-9@*_+./-]/g;
const UNESCAPE_SEQUENCE = /%u[0-9A-Fa-f]{4}|%[0-9A-Fa-f]{2}/g;

// The Sentinel bundle reads the legacy window.escape/window.unescape globals, which
// TypeScript and Deno both report as deprecated. These implement the same Annex B
// semantics (uppercase %XX below U+0100, %uXXXX above, code-unit by code-unit) so the
// shim exposes identical behaviour without reaching for the deprecated globals.
function legacyEscape(value: unknown): string {
  return String(value).replace(ESCAPE_UNESCAPED, (character) => {
    const code = character.charCodeAt(0);
    const hex = code.toString(16).toUpperCase();
    return code < 256 ? "%" + hex.padStart(2, "0") : "%u" + hex.padStart(4, "0");
  });
}

function legacyUnescape(value: unknown): string {
  return String(value).replace(UNESCAPE_SEQUENCE, (sequence) => {
    return String.fromCharCode(parseInt(sequence.charAt(1) === "u" ? sequence.slice(2) : sequence.slice(1), 16));
  });
}

function makeWindow(
  session: ChatSession,
  sdkUrl: string,
  frameUrl: string,
  kind: "outer" | "child",
  parent: ShimWindow | null,
  onCreateChild?: () => ShimWindow
): ShimWindow {
  const window: JsonObject = {};
  const receiveMessage = makeEventTarget(window);

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
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: unknown) {
      storage.set(key, String(value));
    },
    removeItem(key: string) {
      storage.delete(key);
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
  window.fetch = (input: string | URL, init?: RequestInit) => session.fetch(input, init);
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.setInterval = setInterval;
  window.clearInterval = clearInterval;
  window.queueMicrotask = queueMicrotask;
  window.requestIdleCallback = (callback: (deadline: JsonObject) => void) => {
    return setTimeout(() => {
      callback({ timeRemaining: () => 1, didTimeout: false });
    }, 0);
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
  window.escape = legacyEscape;
  window.unescape = legacyUnescape;
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
          for (const listener of (iframeListeners.get(event.type) ?? []).slice()) {
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
        session.cookies.setFromScript(first.slice(0, separator).trim(), first.slice(separator + 1));
      }
    },
  };
  document.head = elementShim({
    appendChild(element: JsonObject) {
      if (callable(element.onload)) {
        // The callback is re-read when the microtask runs, exactly as a browser would fire it.
        queueMicrotask(() => {
          (element.onload as DynamicFunction)();
        });
      }
      return element;
    },
  });
  document.body = elementShim({
    appendChild(element: JsonObject) {
      if (element.contentWindow === null && onCreateChild) {
        const child = onCreateChild();
        element.contentWindow = child;
        element.contentDocument = child.document;
        window.__childWindow = child;
        // contentWindow is the child we just stored, so the frame writes to the same object.
        child.postMessage = (data: unknown, origin: string) => {
          child.__receiveMessage({ data, origin, source: window });
        };
        queueMicrotask(() => {
          (element.dispatchEvent as DynamicFunction)({ type: "load" });
        });
      }
      return element;
    },
  });
  window.document = document;
  document.location = location;

  window.postMessage = (data: unknown, origin: string) => {
    if (kind === "child" && parent) {
      parent.__receiveMessage({ data, origin, source: window });
    } else {
      receiveMessage({ data, origin, source: window.__childWindow });
    }
  };

  return window as ShimWindow;
}

function patchSentinelSdk(source: string): string {
  const withEngine = source.replace("var E=new O;", "var E=new O;window.__uosSentinelEngine=E;");
  const withVm = withEngine.replace(
    'var _n="undefined"!=typeof globalThis?',
    'window.__uosSentinelRunTurnstile=Rn;window.__uosSentinelBindProof=D;var _n="undefined"!=typeof globalThis?'
  );
  if (withVm === source) {
    throw new Error("The fetched Sentinel SDK did not match the known interface");
  }
  return withVm;
}

/** The proof engine the SDK patch exposes: the shim bag plus the two calls this file makes on it. */
type SentinelProofEngine = JsonObject & {
  getRequirementsToken: DynamicFunction;
  getEnforcementToken: DynamicFunction;
};

function sentinelProofEngine(value: unknown): SentinelProofEngine | undefined {
  const engine = objectValue(value);
  if (!engine || !callable(engine.getRequirementsToken)) return undefined;
  // The methods keep running against the engine object itself, so `this` is preserved.
  return engine as SentinelProofEngine;
}

/**
 * Runs the Sentinel SDK bundle inside a contextified shim window.
 *
 * The executed source is not free-form input: SentinelHarness.create accepts only the SDK
 * URL advertised by chatgpt.com, ChatSession.fetch refuses any other origin, and
 * patchSentinelSdk rejects a bundle that does not match the known interface. This remains
 * the one deliberate dynamic-execution site in the file, and sonarjs/code-eval cannot see
 * any of that provenance for a non-literal argument.
 */
function runSentinelSource(source: string, context: JsonObject, filename: string): void {
  // eslint-disable-next-line sonarjs/code-eval -- executing the vetted SDK bundle in its shim window is the whole point of this harness.
  runInContext(source, context, { filename });
}

export class SentinelHarness {
  private constructor(
    private readonly _session: ChatSession,
    private readonly _sdkSource: string,
    private readonly _sdkUrl: string
  ) {}

  static async create(session: ChatSession): Promise<SentinelHarness> {
    const bootstrapResponse = await session.fetch(`${CHATGPT_ORIGIN}/backend-api/sentinel/sdk.js`);
    if (!bootstrapResponse.ok) {
      throw new Error(`Sentinel bootstrap returned ${String(bootstrapResponse.status)}: ${safeResponseSummary(await bootstrapResponse.text())}`);
    }
    const bootstrap = await bootstrapResponse.text();
    const sdkUrl = /https:\/\/chatgpt\.com\/sentinel\/[^'" ]+\/sdk\.js/.exec(bootstrap)?.[0];
    if (!sdkUrl) {
      throw new Error("Sentinel bootstrap did not provide an SDK URL");
    }

    const sdkResponse = await session.fetch(sdkUrl);
    if (!sdkResponse.ok) {
      throw new Error(`Sentinel SDK returned ${String(sdkResponse.status)}: ${safeResponseSummary(await sdkResponse.text())}`);
    }
    return new SentinelHarness(session, patchSentinelSdk(await sdkResponse.text()), sdkUrl);
  }

  async chatRequirements(): Promise<{
    proof: string;
    turnstile: string;
    chatRequirementsToken: string;
  }> {
    const version = /\/sentinel\/([^/]+)\//.exec(this._sdkUrl)?.[1];
    if (!version) {
      throw new Error("Could not identify the Sentinel SDK version");
    }
    const frameUrl = `${CHATGPT_ORIGIN}/backend-api/sentinel/frame.html?sv=${encodeURIComponent(version)}`;

    let child: ShimWindow | null = null;
    const outer = makeWindow(this._session, this._sdkUrl, frameUrl, "outer", null, () => {
      child = makeWindow(this._session, this._sdkUrl, frameUrl, "child", outer);
      createContext(child);
      runSentinelSource(this._sdkSource, child, "sentinel-child.js");
      return child;
    });
    createContext(outer);
    runSentinelSource(this._sdkSource, outer, "sentinel-outer.js");
    requiredValue(child, "Sentinel iframe context was not created");

    const engine = sentinelProofEngine(outer.__uosSentinelEngine);
    const bindProof = callable(outer.__uosSentinelBindProof);
    const runTurnstile = callable(outer.__uosSentinelRunTurnstile);
    if (!engine) {
      throw new Error("Sentinel proof engine was not exposed by the SDK");
    }
    if (!bindProof || !runTurnstile) {
      throw new Error("Sentinel Turnstile VM was not exposed by the SDK");
    }

    const proof = requiredString(await withTimeout(Promise.resolve(engine.getRequirementsToken()), "Sentinel proof generation"), "Sentinel proof");
    const prepareResponse = await this._session.fetch(`${CHATGPT_ORIGIN}/backend-api/sentinel/chat-requirements/prepare`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ p: proof }),
    });
    const prepareBody = await prepareResponse.text();
    if (!prepareResponse.ok) {
      throw new Error(`Chat requirements prepare returned ${String(prepareResponse.status)}: ${safeResponseSummary(prepareBody)}`);
    }
    const requirements = assertRecord(JSON.parse(prepareBody), "Chat requirements prepare response");
    const turnstile = assertRecord(requirements.turnstile, "Chat requirements Turnstile");
    const prepareToken = requiredString(requirements.prepare_token, "Chat requirements prepare token");

    bindProof(requirements, proof);
    const finalProof = requiredString(
      await withTimeout(Promise.resolve(engine.getEnforcementToken(requirements)), "Chat requirements proof-of-work"),
      "Chat requirements proof-of-work answer"
    );
    const turnstileValue = turnstile.required
      ? requiredString(
          await withTimeout(Promise.resolve(runTurnstile(requirements, requiredString(turnstile.dx, "Turnstile VM"))), "Turnstile VM"),
          "Turnstile answer"
        )
      : "";
    if (/^\d+:\s+(?:TypeError|Error):/.test(atobSafe(turnstileValue))) {
      throw new Error("The Sentinel Turnstile VM returned an execution error");
    }

    const finalizeResponse = await this._session.fetch(`${CHATGPT_ORIGIN}/backend-api/sentinel/chat-requirements/finalize`, {
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
    });
    const finalizeBody = await finalizeResponse.text();
    if (!finalizeResponse.ok) {
      throw new Error(`Chat requirements finalize returned ${String(finalizeResponse.status)}: ${safeResponseSummary(finalizeBody)}`);
    }
    const final = assertRecord(JSON.parse(finalizeBody), "Chat requirements finalize response");
    return {
      proof: finalProof,
      turnstile: turnstileValue,
      chatRequirementsToken: requiredString(final.token, "Chat requirements token"),
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
