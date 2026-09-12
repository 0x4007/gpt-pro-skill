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
  "Usage: ask-gpt-pro.ts [--state-dir /absolute/path] [--background] [--] <prompt>\n       ask-gpt-pro.ts --jobs | --status <job-id> | --result <job-id> | --watch\nSetup: --auth-import <file|-> | --auth-check\nPrompts may also be piped on stdin. Results are cached; retrieval never submits.\n--watch retrieves the current pending jobs concurrently and prints JSON lines.";

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
