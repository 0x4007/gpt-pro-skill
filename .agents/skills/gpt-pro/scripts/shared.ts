/**
 * Bag for the two dynamic boundaries in this file: the headless-browser shim objects the
 * Sentinel bundle mutates, and JSON payloads received from the network. Nothing read out of
 * one of these is trusted; callers narrow with objectValue/callable or the required* helpers
 * before use, which is why the values stay `unknown` instead of collapsing to `any`.
 */
export type JsonObject = Record<string, unknown>;

export type DynamicFunction = (...args: unknown[]) => unknown;

export function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export function callable(value: unknown): DynamicFunction | undefined {
  return typeof value === "function" ? (value as DynamicFunction) : undefined;
}

export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const MODEL = "gpt-6-pro";
export const MODEL_RESPONSE_CONTRACTS = [
  {
    id: "photo_upload_action.v1",
    protocol_version: 1,
    presets: ["cap:image", "cap:file", "placement:end"],
  },
];

export function randomUuid(): string {
  return crypto.randomUUID();
}

export function isIntegrityState(value: string): boolean {
  return value.length <= 2048 && value.trim() === value && /^ois1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export function clientObservation(cookieHeader: string): string {
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("__Secure-oai-is="))
    .map((part) => part.slice("__Secure-oai-is=".length));
  if (values.length === 0) return "v1.s.m";
  let state: string;
  try {
    state = decodeURIComponent(values[0]);
  } catch {
    return "v1.s.i";
  }
  if (!isIntegrityState(state) || !/^[A-Za-z0-9_-]{16}$/.test(state.split(".")[2])) return "v1.s.i";
  return `v1.s.${values.length > 1 ? "d" : "p"}.${state.split(".")[2]}`;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/(openai-sentinel-[\w-]+\s*:\s*)[^\s,;]+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/[A-Za-z0-9_-]{180,}/g, "<redacted>");
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function safeResponseSummary(body: string): string {
  try {
    const parsed = JSON.parse(body) as JsonObject;
    const detail = typeof parsed.detail === "string" ? parsed.detail : null;
    if (detail) return redactSensitiveText(detail).slice(0, 500);
  } catch {}
  return redactSensitiveText(body.replace(/\s+/g, " ").trim()).slice(0, 500);
}

export function assertRecord(value: unknown, label: string): JsonObject {
  const record = objectValue(value);
  if (!record) {
    throw new Error(`${label} was not an object`);
  }
  return record;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was missing`);
  }
  return value;
}

export function requiredValue<TValue>(value: TValue | null, message: string): TValue {
  if (value === null) throw new Error(message);
  return value;
}

export function withTimeout<T>(promise: Promise<T>, label: string, ms = 90_000): Promise<T> {
  // Deno types the timer handle as Timeout, and the lint tsconfig carries no host globals
  // at all, so the handle is held indirectly rather than naming either environment's shape.
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  const timeout = new Promise<never>((_, reject) => {
    timer.handle = setTimeout(() => {
      reject(new Error(`${label} timed out`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer.handle !== undefined) clearTimeout(timer.handle);
  });
}
