import { JobStore, POLL_WINDOW_MS, type ProJob } from "./jobs.ts";
import { reportUsage, usageForAccount } from "./usage.ts";
import { ChatSession, loadWebSession, type WebSession } from "./session.ts";
import { SentinelHarness } from "./sentinel.ts";
import { answerForMessage, conversationBody, parseSseText } from "./answers.ts";
import {
  assertRecord,
  CHATGPT_ORIGIN,
  clientObservation,
  type JsonObject,
  MODEL,
  MODEL_RESPONSE_CONTRACTS,
  objectValue,
  randomUuid,
  requiredString,
  safeResponseSummary,
} from "./shared.ts";

export interface PollOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** What one retrieval attempt decided: keep polling, stop with an error, or finish with an answer. */
interface PollAttempt {
  retryable: boolean;
  delay: number;
  completed?: string;
}

/** Rate-limit accounting plus any Retry-After floor for a retryable retrieval failure. */
function retryDelay(job: ProJob, response: Response, now: () => number, delay: number): number {
  let next = delay;
  if (response.status === 429) {
    job.rateLimitCount = (job.rateLimitCount ?? 0) + 1;
    next = Math.max(next, Math.min(900_000, 60_000 * 2 ** Math.min(job.rateLimitCount - 1, 4)));
  }
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const retryMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? "") - now();
  if (Number.isFinite(retryMs) && retryMs > 0) {
    next = Math.max(next, retryMs);
  }
  return next;
}

/** Retrieves the conversation once, refreshing the job record with what the attempt learned. */
async function pollAttempt(
  session: Pick<ChatSession, "fetch">,
  job: ProJob,
  conversationId: string,
  now: () => number,
  deadline: number,
  delay: number
): Promise<PollAttempt> {
  try {
    const response = await session.fetch(CHATGPT_ORIGIN + "/backend-api/conversation/" + encodeURIComponent(conversationId), {
      signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, deadline - now()))),
      headers: { accept: "application/json" },
    });
    job.pollCount++;
    job.lastPollAt = new Date(now()).toISOString();
    if (response.status === 429 || response.status >= 500 || response.status === 404) {
      const nextDelay = retryDelay(job, response, now, delay);
      await response.body?.cancel();
      job.lastError = "Conversation retrieval returned HTTP " + String(response.status);
      return { retryable: true, delay: nextDelay };
    }
    if (!response.ok) {
      await response.body?.cancel();
      job.lastError = "Conversation retrieval returned HTTP " + String(response.status) + "; resume this job after resolving access";
      return { retryable: false, delay };
    }
    const conversation = assertRecord(await response.json(), "Conversation response");
    const answer = answerForMessage(conversation, job.messageId);
    delete job.rateLimitCount;
    delete job.nextPollAt;
    delete job.lastError;
    return { retryable: true, delay, completed: answer };
  } catch {
    job.lastError = "Conversation retrieval interrupted; retrying the existing job";
    return { retryable: true, delay };
  }
}

export async function pollJob(
  session: Pick<ChatSession, "fetch">,
  job: ProJob,
  save: (job: ProJob) => Promise<void>,
  options: PollOptions = {}
): Promise<string> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + POLL_WINDOW_MS;
  const conversationId = requiredString(job.conversationId, "Job conversation ID");
  job.status = "pending";
  await save(job);
  while (now() < deadline) {
    const nextPollAt = Date.parse(job.nextPollAt ?? "");
    if (nextPollAt > now()) {
      await sleep(Math.min(nextPollAt - now(), deadline - now()));
      continue;
    }
    const attempt = await pollAttempt(session, job, conversationId, now, deadline, job.pollCount < 6 ? 5000 : 30_000);
    if (attempt.completed !== undefined) {
      job.answer = attempt.completed;
      job.status = "completed";
      await save(job);
      return attempt.completed;
    }
    if (attempt.retryable) job.nextPollAt = new Date(now() + attempt.delay).toISOString();
    await save(job);
    if (!attempt.retryable) throw new Error(job.lastError);
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(attempt.delay, remaining));
  }
  job.status = "timed_out";
  job.lastError = "No completed answer within six hours; resume this job without resubmitting";
  await save(job);
  throw new Error(job.lastError);
}

async function submitConversation(session: ChatSession, job: ProJob, store: JobStore): Promise<void> {
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
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
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
  const prepare = await session.fetch(`${CHATGPT_ORIGIN}/backend-api/f/conversation/prepare`, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      "x-oai-turn-trace-id": traceId,
      "x-openai-target-path": "/backend-api/f/conversation/prepare",
      "x-openai-target-route": "/backend-api/f/conversation/prepare",
    },
    body: JSON.stringify(prepareBody),
  });
  const prepareText = await prepare.text();
  if (!prepare.ok) {
    throw new Error(`Conversation prepare returned ${String(prepare.status)}: ${safeResponseSummary(prepareText)}`);
  }

  job.status = "submitting";
  job.submissionAttemptedAt = new Date().toISOString();
  await store.save(job);
  const response = await session.fetch(`${CHATGPT_ORIGIN}/backend-api/f/conversation`, {
    signal: AbortSignal.timeout(POLL_WINDOW_MS),
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      "oai-genui-client-actions": "open_entity_detail",
      "x-oai-is-client-observation": clientObservation(session.cookies.header()),
      "x-oai-is-pending-updates": '{"v":3,"updates":[]}',
      "x-oai-turn-trace-id": traceId,
      "openai-sentinel-chat-requirements-token": requirements.chatRequirementsToken,
      "openai-sentinel-proof-token": requirements.proof,
      "openai-sentinel-turnstile-token": requirements.turnstile,
      "x-openai-target-path": "/backend-api/f/conversation",
      "x-openai-target-route": "/backend-api/f/conversation",
    },
    body: JSON.stringify(conversationBody(prompt, messageId)),
  });
  if (!response.ok) {
    job.status = response.status >= 400 && response.status < 500 ? "failed" : "uncertain";
    job.lastError = "Conversation returned HTTP " + String(response.status) + "; do not resubmit automatically";
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

export async function captureConversation(response: Response, saveId: (id: string) => Promise<void>): Promise<void> {
  if (!response.body) throw new Error("Submission returned no stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let saved: string | undefined;
  async function consume(frame: string): Promise<boolean> {
    const parsed = parseSseText(frame);
    if (parsed.conversationId && parsed.conversationId !== saved) {
      await saveId(parsed.conversationId);
      saved = parsed.conversationId;
    }
    return parsed.terminal || parsed.eventTypes.includes("stream_handoff");
  }
  try {
    for (;;) {
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
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function accountIdForSession(session: WebSession): string {
  if (session.headers["chatgpt-account-id"]) {
    return session.headers["chatgpt-account-id"];
  }
  try {
    const claims = JSON.parse(atob(session.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof claims["https://api.openai.com/auth"]?.chatgpt_account_id === "string" ? claims["https://api.openai.com/auth"].chatgpt_account_id : "";
  } catch {
    return "";
  }
}

/**
 * Header maps are typed as always-populated strings, but an account header really can be
 * absent, so the read is widened instead of letting `??` be reported as dead code.
 */
function optionalHeader(headers: Record<string, string>, name: string): string | undefined {
  return headers[name];
}

/**
 * The namespaced auth claim on a token. The account id stays untyped so it is hashed exactly
 * as it arrived, matching the previous behaviour for any non-string claim value.
 */
function tokenAccountClaim(claims: JsonObject): unknown {
  return objectValue(claims["https://api.openai.com/auth"])?.chatgpt_account_id;
}

export async function accountIdentity(session: WebSession): Promise<string> {
  const parts = session.accessToken.split(".");
  let claims: JsonObject;
  try {
    claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw new Error("Invalid web-session identity");
  }
  const subject = requiredString(claims.sub, "Web-session subject");
  const account = optionalHeader(session.headers, "chatgpt-account-id") ?? tokenAccountClaim(claims) ?? "";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([subject, account])));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function submitJob(prompt: string, store = new JobStore(), onCreated?: (job: ProJob) => void): Promise<ProJob> {
  const auth = await loadWebSession(new URL("../", store.directory));
  const job = await store.create(prompt, await accountIdentity(auth));
  onCreated?.(job);
  try {
    try {
      await usageForAccount(store, job.account, {
        session: new ChatSession(auth),
        accountId: accountIdForSession(auth),
      });
    } catch {}
    return await store.withLock(job.id, async (current) => {
      try {
        await submitConversation(new ChatSession(auth), current, store);
      } catch {
        if (current.conversationId) {
          current.status = "pending";
          current.lastError = "Initial stream interrupted; retrieve the existing conversation";
        } else {
          if (current.status !== "failed") {
            current.status = current.status === "preparing" ? "failed" : "uncertain";
          }
          current.lastError ??=
            current.status === "uncertain" ? "Submission outcome unknown; do not resubmit automatically" : "Preparation failed before submission";
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

export async function resultForJob(id: string, store = new JobStore()): Promise<string> {
  return await store.withLock(id, async (job) => {
    await reportUsage(store, job.account);
    if (job.status === "completed") {
      return requiredString(job.answer, "Saved answer");
    }
    if (!job.conversationId) {
      throw new Error("Job has no conversation ID (" + job.status + "); do not resubmit automatically");
    }
    const auth = await loadWebSession(new URL("../", store.directory));
    if ((await accountIdentity(auth)) !== job.account) {
      throw new Error("Web-session account does not match this job");
    }
    return await pollJob(new ChatSession(auth), job, (value) => store.save(value));
  });
}

export async function run(prompt: string, store = new JobStore()): Promise<string> {
  const job = await submitJob(prompt, store, (job) => {
    console.error("GPT Pro job: " + job.id);
  });
  return await resultForJob(job.id, store);
}
