import { type JobStore, type ProJob } from "./jobs.ts";
import { ensurePrivateState } from "./state.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const THROTTLE_WINDOW = 15 * 60 * 1000;
const LIMIT_SOURCE = "https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt";
type Plan = "pro_200" | "pro_100" | "unknown";
type Lookup = "detected" | "unavailable";
type PaceStatus = "unknown_allowance" | "local_allowance_reached" | "collecting_history" | "above_pace" | "within_local_pace";
interface Subscription {
  version: 1;
  checkedAt: string;
  plan: Plan;
  lookup: Lookup;
}
interface Fetcher {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export function subscriptionPlan(body: unknown, accountId: string): Plan {
  if (!body || typeof body !== "object") return "unknown";
  const accounts = (body as Record<string, unknown>).accounts;
  if (!accounts || typeof accounts !== "object" || !accountId) return "unknown";
  const matches = Object.values(accounts).filter((value) => value?.account?.account_id === accountId);
  if (!matches.length) return "unknown";
  const plans = matches.map((value) => {
    if (value.entitlement?.has_active_subscription !== true) return "unknown";
    const plan = value.entitlement.subscription_plan;
    if (value.account.plan_type === "pro" && plan === "chatgptpro") {
      return "pro_200";
    }
    if (value.account.plan_type === "prolite" && plan === "chatgptprolite") {
      return "pro_100";
    }
    return "unknown";
  });
  return plans.every((plan) => plan === plans[0]) ? plans[0] : "unknown";
}

function attemptedAt(job: ProJob): number | undefined {
  if (!job.submissionAttemptedAt && !job.conversationId && job.status !== "submitting" && job.status !== "uncertain") return undefined;
  const time = Date.parse(job.submissionAttemptedAt ?? job.createdAt);
  return Number.isFinite(time) ? time : undefined;
}

function allowanceForPlan(plan: Plan): number | null {
  if (plan === "pro_200") return 200;
  if (plan === "pro_100") return 50;
  return null;
}

function expectedAttempts(allowance: number | null, elapsed: number): number | null {
  return allowance === null ? null : (allowance * elapsed) / WEEK;
}

function paceStatus(allowance: number | null, expected: number | null, used: number, elapsed: number): PaceStatus {
  if (allowance === null || expected === null) return "unknown_allowance";
  if (used >= allowance) return "local_allowance_reached";
  if (elapsed < DAY) return "collecting_history";
  if (used > expected) return "above_pace";
  return "within_local_pace";
}

function paceNudge(status: PaceStatus, used: number, expected: number | null): string | null {
  if (status !== "above_pace" && status !== "local_allowance_reached") return null;
  // Unreachable while `paceStatus` owns the status: both nudged statuses require a known pace.
  if (expected === null) return null;
  return `Gently tell the user: this installation has recorded ${String(used)} Pro submission attempts in its planning week, above the evenly spread pace of ${expected.toFixed(
    1
  )}. Consider spacing out optional Pro requests and reusing answers. This is an estimate, not an OpenAI quota warning.`;
}

export function estimateUsage(jobs: ProJob[], account: string, subscription: Subscription | undefined, now = Date.now()) {
  const attempts = [...new Map(jobs.filter((job) => job.account === account).map((job) => [job.id, job])).values()]
    .map(attemptedAt)
    .filter((time): time is number => time !== undefined && time <= now);
  const anchor = attempts.length ? Math.min(...attempts) : now;
  const start = anchor + Math.floor((now - anchor) / WEEK) * WEEK;
  const elapsed = now - start;
  const used = attempts.filter((time) => time >= start).length;
  const plan = subscription?.plan ?? "unknown";
  const allowance = allowanceForPlan(plan);
  const expected = expectedAttempts(allowance, elapsed);
  const projected = elapsed >= DAY ? (used * WEEK) / elapsed : null;
  const status = paceStatus(allowance, expected, used, elapsed);
  const nudge = paceNudge(status, used, expected);
  return {
    model: "gpt-6-pro",
    plan,
    subscriptionCheckedAt: subscription?.checkedAt ?? null,
    subscriptionLookup: subscription?.lookup ?? "not_checked",
    subscriptionStale:
      !subscription ||
      !Number.isFinite(Date.parse(subscription.checkedAt)) ||
      now < Date.parse(subscription.checkedAt) ||
      now - Date.parse(subscription.checkedAt) >= CACHE_TTL,
    weeklyAllowance: allowance,
    allowanceSource: allowance === null ? null : LIMIT_SOURCE,
    allowanceVerifiedOn: allowance === null ? null : "2026-09-06",
    providerResetAt: null,
    windowSource: "local_planning_week_not_provider_reset",
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(start + WEEK).toISOString(),
    localSubmissionAttempts: used,
    localAttemptsLast7Days: attempts.filter((time) => time >= now - WEEK).length,
    expectedByNow: expected === null ? null : Number(expected.toFixed(2)),
    projectedWeeklyAttempts: projected === null ? null : Number(projected.toFixed(2)),
    paceStatus: status,
    nudge,
    caveat:
      "Local attempts only; excludes ChatGPT app use, other installations, and deleted records. Attempts are not confirmed billed messages. Unknown plans have no guessed allowance. The planning week starts at the earliest saved attempt; the actual quota reset and remaining balance are unknown. HTTP retrieval throttles are separate.",
  };
}

function isPlan(value: unknown): value is Plan {
  return value === "pro_200" || value === "pro_100" || value === "unknown";
}

function isLookup(value: unknown): value is Lookup {
  return value === "detected" || value === "unavailable";
}

function decodeSubscription(value: unknown): Subscription | undefined {
  if (!value || typeof value !== "object") return undefined;
  // The cached snapshot is untrusted JSON, so validate it as a property bag before trusting it.
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !isPlan(record.plan) ||
    !isLookup(record.lookup) ||
    typeof record.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(record.checkedAt))
  )
    return undefined;
  return { version: 1, plan: record.plan, lookup: record.lookup, checkedAt: record.checkedAt };
}

function isPrivateFile(info: Deno.FileInfo): boolean {
  return info.isFile && !info.isSymlink && (info.mode === null || (info.mode & 0o077) === 0);
}

async function readSubscription(path: URL): Promise<Subscription | undefined> {
  try {
    const info = await Deno.lstat(path);
    if (!isPrivateFile(info)) return undefined;
    return decodeSubscription(JSON.parse(await Deno.readTextFile(path)));
  } catch {
    return undefined;
  }
}

async function fetchSubscription(session: Fetcher, accountId: string): Promise<Subscription> {
  const checkedAt = new Date().toISOString();
  try {
    const response = await session.fetch("https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27", { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      await response.body?.cancel();
    } else {
      return {
        version: 1,
        checkedAt,
        plan: subscriptionPlan(await response.json(), accountId),
        lookup: "detected",
      };
    }
  } catch {}
  return { version: 1, checkedAt, plan: "unknown", lookup: "unavailable" };
}

function isFreshSnapshot(value: Subscription | undefined): boolean {
  if (!value) return false;
  return Date.now() >= Date.parse(value.checkedAt) && Date.now() - Date.parse(value.checkedAt) < CACHE_TTL;
}

function hasRecentThrottle(jobs: ProJob[], account: string): boolean {
  return jobs.some(
    (job) => job.account === account && job.lastError?.includes("HTTP 429") && Date.now() - Date.parse(job.lastPollAt ?? job.updatedAt) < THROTTLE_WINDOW
  );
}

async function assertUsageLock(lockPath: URL): Promise<void> {
  try {
    const info = await Deno.lstat(lockPath);
    if (!isPrivateFile(info)) {
      throw new Error("Invalid usage lock");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function writeSubscriptionSnapshot(directory: URL, path: URL, account: string, snapshot: Subscription): Promise<void> {
  const temporary = new URL(`usage-${account}.${crypto.randomUUID()}.tmp`, directory);
  try {
    await Deno.writeTextFile(temporary, JSON.stringify(snapshot), {
      createNew: true,
      mode: 0o600,
    });
    await Deno.rename(temporary, path);
  } finally {
    try {
      await Deno.remove(temporary);
    } catch {}
  }
}

async function refreshSnapshotWithLock(
  directory: URL,
  path: URL,
  account: string,
  current: Subscription | undefined,
  live: { session: Fetcher; accountId: string }
): Promise<Subscription | undefined> {
  let snapshot = current;
  let lock: Deno.FsFile | undefined;
  try {
    await ensurePrivateState(directory);
    const lockPath = new URL(`usage-${account}.lock`, directory);
    await assertUsageLock(lockPath);
    lock = await Deno.open(lockPath, {
      create: true,
      read: true,
      write: true,
      mode: 0o600,
    });
    await lock.lock(true);
    snapshot = await readSubscription(path);
    if (!isFreshSnapshot(snapshot)) {
      snapshot = await fetchSubscription(live.session, live.accountId);
      await writeSubscriptionSnapshot(directory, path, account, snapshot);
    }
  } catch {
    if (!snapshot && !lock) {
      snapshot = await fetchSubscription(live.session, live.accountId);
    }
  } finally {
    lock?.close();
  }
  return snapshot;
}

export async function usageForAccount(store: JobStore, account: string, live?: { session: Fetcher; accountId: string }) {
  const jobs = await store.list();
  if (!/^[a-f0-9]{64}$/.test(account)) {
    return estimateUsage(jobs, account, undefined);
  }
  const directory = new URL("../", store.directory);
  const path = new URL(`usage-${account}.json`, directory);
  let snapshot = await readSubscription(path);
  if (live && !isFreshSnapshot(snapshot) && !hasRecentThrottle(jobs, account)) {
    snapshot = await refreshSnapshotWithLock(directory, path, account, snapshot, live);
  }
  return estimateUsage(jobs, account, snapshot);
}

export async function reportUsage(store: JobStore, account: string, live?: { session: Fetcher; accountId: string }) {
  try {
    console.error("GPT Pro usage estimate: " + JSON.stringify(await usageForAccount(store, account, live)));
  } catch {
    console.error("GPT Pro usage estimate: unavailable; local usage could not be read. This does not indicate remaining quota.");
  }
}
