import { stateDirectory } from "./state.ts";
import { JobStore, type ProJob } from "./jobs.ts";
import { reportUsage } from "./usage.ts";
import { ChatSession, importWebSession, loadWebSession, parseSessionImport, parseWebSession, type WebSession } from "./session.ts";
import { SentinelHarness } from "./sentinel.ts";
import { answerForMessage, completedAnswer, conversationBody, parseSseText } from "./answers.ts";
import { accountIdForSession, accountIdentity, captureConversation, pollJob, resultForJob, run, submitJob } from "./polling.ts";
import { CHATGPT_ORIGIN, clientObservation, errorText, redactSensitiveText } from "./shared.ts";

// Public API: re-exported from this entry point so scripts/authenticate.ts and the tests keep
// importing the same names from the same module.
export {
  answerForMessage,
  captureConversation,
  ChatSession,
  clientObservation,
  completedAnswer,
  conversationBody,
  importWebSession,
  loadWebSession,
  parseSessionImport,
  parseSseText,
  parseWebSession,
  pollJob,
  redactSensitiveText,
  resultForJob,
  SentinelHarness,
};
export type { WebSession };

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

const HELP_TEXT =
  "Usage: ask-gpt-pro.ts [--state-dir /absolute/path] [--background] [--] <prompt>\n       ask-gpt-pro.ts --jobs | --status <job-id> | --result <job-id> | --watch\n       ask-gpt-pro.ts --timings [--since YYYY-MM-DD]\nSetup: --auth-import <file|-> | --auth-check\nPrompts may also be piped on stdin. Results are cached; retrieval never submits.\n--watch retrieves the current pending jobs concurrently and prints JSON lines.\n--timings summarises locally measured durations; it uses no network and no model turn.";

const MINUTE_MS = 60_000;

/**
 * Duration ranges in minutes for the histogram. Fixed ranges keep resolution where the
 * real generations sit instead of spreading one sample per minute over empty buckets.
 * A null upper bound is the open-ended tail.
 */
const TIMING_RANGES: [number, number | null][] = [
  [0, 5],
  [5, 10],
  [10, 15],
  [15, 20],
  [20, null],
];

/** Durations beyond this are treated as abandoned retrieval rather than slow generation. */
const TIMING_STALE_MS = 60 * MINUTE_MS;

/** Effective sample floor before a distribution is worth quoting. */
const TIMING_MIN_SAMPLE = 5;

function percentile(sorted: number[], fraction: number): number {
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** Reads the optional --since cutoff, rejecting anything that is not a plain date. */
function parseSinceOption(args: string[]): string | undefined {
  let since: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--since") throw new Error("Unknown --timings option: " + args[index]);
    since = args[++index];
    if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("--since requires a YYYY-MM-DD date");
  }
  return since;
}

interface DurationSet {
  durations: number[];
  statuses: Record<string, number>;
  undated: number;
}

/** Collects submission-to-answer spans, sorting them for percentile reads. */
function collectDurations(jobs: ProJob[]): DurationSet {
  const durations: number[] = [];
  const statuses: Record<string, number> = {};
  let undated = 0;
  for (const job of jobs) {
    statuses[job.status] = (statuses[job.status] ?? 0) + 1;
    if (job.status !== "completed") continue;
    const start = Date.parse(job.createdAt);
    const end = Date.parse(job.lastPollAt ?? job.updatedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      undated++;
      continue;
    }
    durations.push(end - start);
  }
  durations.sort((left, right) => left - right);
  return { durations, statuses, undated };
}

/** Converts a millisecond span to whole minutes, rounded for stable reporting. */
function measureMinutes(value: number): number {
  return Number((value / MINUTE_MS).toFixed(1));
}

/**
 * Summarises how long completed jobs actually took, read entirely from local records.
 * The measured span is submission to recorded answer, so it approximates the wait a
 * caller experiences rather than the server's own generation time.
 */
async function timingsCommand(args: string[], store: JobStore): Promise<void> {
  const since = parseSinceOption(args);
  const jobs = (await store.list()).filter((job) => !since || job.createdAt >= since);
  const { durations, statuses, undated } = collectDurations(jobs);
  const stale = durations.filter((duration) => duration > TIMING_STALE_MS).length;
  console.log(
    JSON.stringify(
      {
        scope: since ? "jobs created on or after " + since : "all saved jobs",
        jobs: jobs.length,
        statuses,
        completedWithoutDuration: undated,
        sample: durations.length,
        sampleNote:
          "Submission to recorded answer. Not server generation time; early runs used an older upload path and some records reflect abandoned retrieval.",
        confidence: durations.length < TIMING_MIN_SAMPLE ? "insufficient" : "indicative",
        minutes: {
          min: durations.length ? measureMinutes(durations[0]) : null,
          p25: durations.length ? measureMinutes(percentile(durations, 0.25)) : null,
          median: durations.length ? measureMinutes(percentile(durations, 0.5)) : null,
          p75: durations.length ? measureMinutes(percentile(durations, 0.75)) : null,
          p90: durations.length ? measureMinutes(percentile(durations, 0.9)) : null,
          max: durations.length ? measureMinutes(durations[durations.length - 1]) : null,
        },
        stale,
        staleNote:
          stale === 0
            ? null
            : String(stale) +
              " completed job(s) exceeded one hour, which indicates abandoned retrieval rather than slow generation; exclude them before quoting a typical duration.",
        histogram: TIMING_RANGES.map(([from, to]) => ({
          range: to === null ? String(from) + "+ min" : String(from) + "-" + String(to) + " min",
          count: durations.filter((duration) => duration >= from * MINUTE_MS && (to === null || duration < to * MINUTE_MS)).length,
        })),
      },
      null,
      2
    )
  );
}

async function importAuthCommand(args: string[], directory: URL): Promise<void> {
  if (args.length !== 2) {
    throw new Error("--auth-import requires a private file path or - for stdin");
  }
  const text = args[1] === "-" ? await new Response(Deno.stdin.readable).text() : await Deno.readTextFile(args[1]);
  await importWebSession(text, directory);
  console.log(JSON.stringify({ status: "imported", modelSubmission: false }));
}

async function authCheckCommand(args: string[], store: JobStore, directory: URL): Promise<void> {
  if (args.length !== 1) throw new Error("--auth-check takes no arguments");
  const auth = await loadWebSession(directory);
  const session = new ChatSession(auth);
  await reportUsage(store, await accountIdentity(auth), {
    session,
    accountId: accountIdForSession(auth),
  });
  const response = await session.fetch(CHATGPT_ORIGIN + "/backend-api/models", { signal: AbortSignal.timeout(30000) });
  await response.body?.cancel();
  console.log(
    JSON.stringify({
      authenticated: response.ok,
      httpStatus: response.status,
      submissionEligibility: "not_tested",
      modelSubmission: false,
    })
  );
  if (!response.ok) Deno.exitCode = 1;
}

async function jobsCommand(args: string[], store: JobStore): Promise<void> {
  if (args.length !== 1) throw new Error("--jobs takes no arguments");
  const jobs = await store.list();
  for (const account of new Set(jobs.map((job) => job.account))) {
    await reportUsage(store, account);
  }
  console.log(JSON.stringify(jobs.map(jobSummary)));
}

async function jobLookupCommand(command: string, args: string[], store: JobStore): Promise<void> {
  if (args.length !== 2) throw new Error(command + " requires one job ID");
  if (command === "--status") {
    const job = await store.read(args[1]);
    await reportUsage(store, job.account);
    console.log(JSON.stringify(jobSummary(job)));
  } else console.log(await resultForJob(args[1], store));
}

async function watchCommand(args: string[], store: JobStore): Promise<void> {
  if (args.length !== 1) throw new Error("--watch takes no arguments");
  const pending = (await store.list()).filter((job) => job.conversationId && job.status !== "completed" && job.status !== "failed");
  await Promise.all(
    pending.map(async (job) => {
      try {
        const answer = await resultForJob(job.id, store);
        console.log(JSON.stringify({ jobId: job.id, status: "completed", answer }));
      } catch (error) {
        console.log(
          JSON.stringify({
            jobId: job.id,
            status: (await store.read(job.id)).status,
            error: redactSensitiveText(errorText(error)),
          })
        );
        Deno.exitCode = 1;
      }
    })
  );
}

async function promptCommand(args: string[], store: JobStore): Promise<void> {
  const background = args[0] === "--background";
  let promptArgs = background ? args.slice(1) : args;
  if (promptArgs[0] === "--") promptArgs = promptArgs.slice(1);
  else if (promptArgs[0]?.startsWith("--")) {
    throw new Error("Unknown option; use -- before a prompt that starts with --");
  }
  let prompt = promptArgs.join(" ").trim();
  if (!prompt) prompt = (await new Response(Deno.stdin.readable).text()).trim();
  if (!prompt) throw new Error("Provide a prompt as arguments or stdin");
  if (background) {
    const job = await submitJob(prompt, store, (job) => {
      console.error("GPT Pro job: " + job.id);
    });
    console.log(JSON.stringify(jobSummary(job)));
  } else console.log(await run(prompt, store));
}

async function main(args: string[]): Promise<void> {
  let directory: URL | undefined;
  if (args[0] === "--state-dir") {
    if (!args[1]) throw new Error("--state-dir requires an absolute path");
    directory = stateDirectory(args[1]);
    args = args.slice(2);
  }
  const command = args[0];
  if (command === "--help") {
    console.log(HELP_TEXT);
    return;
  }
  directory ??= stateDirectory();
  const store = new JobStore(new URL(".gpt-pro-jobs/", directory));
  switch (command) {
    case "--auth-import":
      await importAuthCommand(args, directory);
      return;
    case "--auth-check":
      await authCheckCommand(args, store, directory);
      return;
    case "--jobs":
      await jobsCommand(args, store);
      return;
    case "--status":
    case "--result":
      await jobLookupCommand(command, args, store);
      return;
    case "--timings":
      await timingsCommand(args.slice(1), store);
      return;
    case "--watch":
      await watchCommand(args, store);
      return;
    default:
      await promptCommand(args, store);
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(redactSensitiveText(errorText(error)));
    Deno.exitCode = 1;
  }
}
