import {
  answerForMessage,
  captureConversation,
  pollJob,
  resultForJob,
} from "../scripts/ask-gpt-pro.ts";
import { JobStore, POLL_WINDOW_MS, type ProJob } from "../scripts/jobs.ts";

function fixture(id = crypto.randomUUID()): ProJob {
  return {
    version: 1,
    id,
    messageId: crypto.randomUUID(),
    model: "gpt-6-pro",
    account: "fixture-account",
    prompt: "fixture-prompt",
    status: "pending",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    conversationId: crypto.randomUUID(),
    pollCount: 0,
  };
}
function conversation(job: ProJob, answer = "fixture-answer") {
  return {
    current_node: "answer",
    mapping: {
      user: {
        parent: null,
        message: { id: job.messageId, author: { role: "user" } },
      },
      answer: {
        parent: "user",
        message: {
          author: { role: "assistant" },
          channel: "final",
          status: "finished_successfully",
          end_turn: true,
          metadata: { model_slug: "gpt-6-pro" },
          content: { content_type: "text", parts: [answer] },
        },
      },
    },
  };
}

Deno.test("six-hour polling expires without submitting and can resume the same job", async () => {
  const job = fixture();
  let clock = 0, calls = 0;
  const fetcher = {
    fetch: async (input: string | URL, init?: RequestInit) => {
      calls++;
      if (init?.method && init.method !== "GET") {
        throw new Error("Unexpected mutation");
      }
      if (!String(input).endsWith(job.conversationId!)) {
        throw new Error("Wrong conversation");
      }
      return Response.json({ mapping: {} });
    },
  };
  let timedOut = false;
  try {
    await pollJob(fetcher, job, async () => {}, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
  } catch {
    timedOut = true;
  }
  if (
    !timedOut || clock !== POLL_WINDOW_MS || POLL_WINDOW_MS !== 21600000 ||
    job.status !== "timed_out" || calls < 700
  ) throw new Error("Incorrect six-hour window");
  const resumed = await pollJob(
    { fetch: () => Promise.resolve(Response.json(conversation(job))) },
    job,
    async () => {},
  );
  if (resumed !== "fixture-answer" || job.status as string !== "completed") {
    throw new Error("Existing job could not resume");
  }
});

Deno.test("transient GET failures honor Retry-After; auth failures preserve resumable state", async () => {
  const job = fixture();
  let clock = 0, step = 0;
  const delays: number[] = [];
  const answer = await pollJob(
    {
      fetch: () => {
        step++;
        if (step === 1) throw new TypeError("fixture network failure");
        if (step === 2) {
          return Promise.resolve(
            new Response(null, {
              status: 429,
              headers: { "retry-after": "120" },
            }),
          );
        }
        if (step === 3) {
          return Promise.resolve(
            new Response(null, { status: 503 }),
          );
        }
        return Promise.resolve(Response.json(conversation(job)));
      },
    },
    job,
    async () => {},
    {
      now: () => clock,
      sleep: async (ms) => {
        delays.push(ms);
        clock += ms;
      },
    },
  );
  if (answer !== "fixture-answer" || delays[1] !== 120000) {
    throw new Error("Read retry policy failed");
  }
  const denied = fixture();
  let rejected = false;
  try {
    await pollJob(
      { fetch: () => Promise.resolve(new Response(null, { status: 401 })) },
      denied,
      async () => {},
      {
        sleep: () => {
          throw new Error("Must not retry auth failure");
        },
      },
    );
  } catch {
    rejected = true;
  }
  if (
    !rejected || denied.status !== "pending" || !denied.conversationId ||
    !denied.lastError?.includes("401")
  ) throw new Error("Auth failure lost resumable state");
});

Deno.test("stream capture persists an early conversation ID before an interrupted stream", async () => {
  const chunks = [
    'data: {"conversation_',
    'id":"fixture-conversation"}\r',
    "\n\r\n",
  ];
  let index = 0, saved = "";
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[index++]));
      } else controller.error(new Error("fixture disconnect"));
    },
  });
  let failed = false;
  try {
    await captureConversation(new Response(stream), async (id) => {
      saved = id;
    });
  } catch {
    failed = true;
  }
  if (!failed || saved !== "fixture-conversation") {
    throw new Error("Lost conversation ID on disconnect");
  }
});

Deno.test("handoff closes the stream without waiting for terminal response", async () => {
  let cancelled = false, saved = "";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"stream_handoff","conversation_id":"fixture-conversation"}\n\n',
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  await captureConversation(new Response(stream), async (id) => {
    saved = id;
  });
  if (!cancelled || saved !== "fixture-conversation") {
    throw new Error("Handoff did not detach safely");
  }
});

Deno.test("answer matching survives a later turn and rejects ambiguous or wrong-model finals", () => {
  const job = fixture();
  const value: any = conversation(job);
  value.mapping.later = {
    parent: "answer",
    message: { id: "later-user", author: { role: "user" } },
  };
  value.current_node = "later";
  if (answerForMessage(value, job.messageId) !== "fixture-answer") {
    throw new Error("Later turn hid the matching answer");
  }
  value.mapping.alternative = structuredClone(value.mapping.answer);
  value.mapping.alternative.message.content.parts = ["different-answer"];
  if (answerForMessage(value, job.messageId) !== undefined) {
    throw new Error("Ambiguous result accepted");
  }
  delete value.mapping.alternative;
  value.mapping.answer.message.metadata.model_slug = "other-model";
  if (answerForMessage(value, job.messageId) !== undefined) {
    throw new Error("Wrong model accepted");
  }
});

Deno.test("private job store isolates concurrent jobs and resumes cached results without auth or network", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.chmod(dir, 0o700);
  const store = new JobStore(new URL("file://" + dir + "/"));
  try {
    const [a, b] = await Promise.all([
      store.create("prompt-a", "account"),
      store.create("prompt-b", "account"),
    ]);
    await Promise.all(
      [a, b].map((job) =>
        store.withLock(job.id, async (current) => {
          current.status = "completed";
          current.answer = "answer-" + current.prompt;
          await store.save(current);
        })
      ),
    );
    const reloaded = new JobStore(store.directory);
    if (
      await resultForJob(a.id, reloaded) !== "answer-prompt-a" ||
      await resultForJob(b.id, reloaded) !== "answer-prompt-b"
    ) throw new Error("Results crossed job boundaries");
    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.withLock(a.id, async (job) => {
          const before = job.pollCount;
          await new Promise((resolve) => setTimeout(resolve, 1));
          job.pollCount = before + 1;
          await store.save(job);
        })),
    );
    if ((await store.read(a.id)).pollCount !== 5) {
      throw new Error("Concurrent writers lost an update");
    }
    const info = await Deno.stat(new URL(a.id + ".json", store.directory));
    if (info.mode !== null && (info.mode & 0o077) !== 0) {
      throw new Error("Public job file");
    }
    let escaped = false;
    try {
      await store.read("../outside");
    } catch {
      escaped = true;
    }
    if (!escaped) throw new Error("Path traversal accepted");
    if ((await store.list()).length !== 2) {
      throw new Error("Job listing lost records");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failure to persist a completed answer is not hidden as a network retry", async () => {
  const job = fixture();
  let saves = 0, calls = 0, failed = false;
  try {
    await pollJob(
      {
        fetch: () => {
          calls++;
          return Promise.resolve(Response.json(conversation(job)));
        },
      },
      job,
      async () => {
        if (++saves === 2) throw new Error("disk full");
      },
    );
  } catch {
    failed = true;
  }
  if (!failed || calls !== 1) {
    throw new Error("Persistence failure retried network");
  }
});

Deno.test("an answer arriving after 45 minutes is collected before the six-hour deadline", async () => {
  const job = fixture();
  let clock = 0;
  const answer = await pollJob(
    {
      fetch: () =>
        Promise.resolve(Response.json(
          clock >= 45 * 60 * 1000
            ? conversation(job, "late-answer")
            : { mapping: {} },
        )),
    },
    job,
    async () => {},
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );
  if (
    answer !== "late-answer" || clock < 45 * 60 * 1000 ||
    clock >= POLL_WINDOW_MS
  ) throw new Error("Long-running result was lost");
});

Deno.test("jobs without a conversation handle are never automatically resubmitted", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.chmod(dir, 0o700);
  const store = new JobStore(new URL("file://" + dir + "/"));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    throw new Error("Network must not be used");
  };
  try {
    for (
      const status of [
        "preparing",
        "submitting",
        "uncertain",
        "failed",
      ] as const
    ) {
      const job = await store.create("fixture-prompt", "fixture-account");
      await store.withLock(job.id, async (value) => {
        value.status = status;
        await store.save(value);
      });
      let rejected = false;
      try {
        await resultForJob(job.id, store);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("Handle-free job accepted for retrieval");
    }
    if (calls !== 0) throw new Error("Retrieval attempted a new request");
  } finally {
    globalThis.fetch = original;
    await Deno.remove(dir, { recursive: true });
  }
});
