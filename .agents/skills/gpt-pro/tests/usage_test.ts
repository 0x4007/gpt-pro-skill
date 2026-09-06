import {
  estimateUsage,
  subscriptionPlan,
  usageForAccount,
} from "../scripts/usage.ts";
import { JobStore, type ProJob } from "../scripts/jobs.ts";
import { pathToFileURL } from "node:url";

const DAY = 86400000;
const account = "a".repeat(64);
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function job(time = 0): ProJob {
  return {
    version: 1,
    id: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    model: "gpt-6-pro",
    account,
    prompt: "fixture",
    status: "pending",
    createdAt: new Date(time).toISOString(),
    updatedAt: new Date(time).toISOString(),
    submissionAttemptedAt: new Date(time).toISOString(),
    pollCount: 0,
  };
}
const subscription = {
  version: 1 as const,
  plan: "pro_200" as const,
  checkedAt: new Date(DAY).toISOString(),
  lookup: "detected" as const,
};
function body(plan = "pro", subscriptionPlan = "chatgptpro") {
  return {
    accounts: {
      personal: {
        account: { account_id: "fixture", plan_type: plan },
        entitlement: {
          has_active_subscription: true,
          subscription_plan: subscriptionPlan,
        },
      },
    },
  };
}

Deno.test("pacing uses published tier budgets and suppresses first-day noise", () => {
  const jobs = Array.from({ length: 30 }, () => job());
  const estimate = estimateUsage(jobs, account, subscription, DAY);
  assert(
    estimate.expectedByNow === 28.57 &&
      estimate.projectedWeeklyAttempts === 210,
  );
  assert(estimate.paceStatus === "above_pace" && estimate.nudge);
  assert(estimate.providerResetAt === null);
  const lite = estimateUsage(jobs, account, {
    ...subscription,
    plan: "pro_100",
  }, DAY);
  assert(lite.weeklyAllowance === 50 && lite.expectedByNow === 7.14);
  assert(estimateUsage(jobs, account, subscription, DAY - 1).nudge === null);
  assert(estimateUsage(jobs, account, undefined, DAY).weeklyAllowance === null);
  assert(
    estimateUsage(
      Array.from({ length: 200 }, () => job()),
      account,
      subscription,
      0,
    ).paceStatus === "local_allowance_reached",
  );
});

Deno.test("count attempts once, isolate accounts, exclude preparation and retrieval", () => {
  const first = job();
  first.pollCount = 541;
  const preparing = {
    ...job(),
    status: "failed" as const,
    submissionAttemptedAt: undefined,
  };
  const uncertain = {
    ...preparing,
    id: crypto.randomUUID(),
    status: "uncertain" as const,
  };
  const rejected = { ...job(), status: "failed" as const };
  const other = { ...job(), account: "other" };
  const jobs = [
    first,
    first,
    preparing,
    uncertain,
    rejected,
    other,
    job(DAY * 9),
  ];
  assert(
    estimateUsage(jobs, account, subscription, DAY).localSubmissionAttempts ===
      3,
  );
  const rollover = estimateUsage(
    [...jobs, job(DAY * 7)],
    account,
    subscription,
    DAY * 8,
  );
  assert(
    rollover.localSubmissionAttempts === 1 &&
      rollover.windowStart === new Date(DAY * 7).toISOString(),
  );
});

Deno.test("subscription detection requires matching active account and consistent aliases", () => {
  assert(subscriptionPlan(body(), "fixture") === "pro_200");
  assert(
    subscriptionPlan(body("prolite", "chatgptprolite"), "fixture") ===
      "pro_100",
  );
  assert(subscriptionPlan(body(), "other") === "unknown");
  assert(
    subscriptionPlan(body("business", "business"), "fixture") === "unknown",
  );
  const inactive = body();
  inactive.accounts.personal.entitlement.has_active_subscription = false;
  assert(subscriptionPlan(inactive, "fixture") === "unknown");
  const ambiguous = {
    accounts: { ...body().accounts, alias: inactive.accounts.personal },
  };
  assert(subscriptionPlan(ambiguous, "fixture") === "unknown");
  assert(
    subscriptionPlan({ accounts: { broken: null } }, "fixture") === "unknown",
  );
});

Deno.test("subscription cache serializes lookups, stores sanitized fields, and respects recent 429", async () => {
  const root = await Deno.makeTempDir();
  try {
    const store = new JobStore(pathToFileURL(root + "/.gpt-pro-jobs/"));
    await store.create("fixture", account);
    let requests = 0;
    const live = {
      accountId: "fixture",
      session: {
        fetch: () => {
          requests++;
          return Promise.resolve(
            Response.json({ ...body(), secret: "must-not-cache" }),
          );
        },
      },
    };
    const results = await Promise.all([
      usageForAccount(store, account, live),
      usageForAccount(store, account, live),
    ]);
    assert(requests === 1 && results.every((r) => r.plan === "pro_200"));
    const cachePath = root + `/usage-${account}.json`;
    const cached = await Deno.readTextFile(cachePath);
    assert(!cached.includes("must-not-cache") && !cached.includes("fixture"));
    const info = await Deno.stat(cachePath);
    assert(info.mode === null || (info.mode & 0o077) === 0);
    const record = (await store.list())[0];
    record.lastError = "HTTP 429";
    await store.save(record);
    await Deno.remove(cachePath);
    assert(
      (await usageForAccount(store, account, live)).plan === "unknown" &&
        requests === 1,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
