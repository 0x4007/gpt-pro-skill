import { ChatSession, clientObservation } from "../scripts/ask-gpt-pro.ts";

// Synthetic protocol fixtures only; these are not server-issued credentials.
const states = [
  "ois1.fixture.AAAAAAAAAAAAAAAA.signature",
  "ois1.fixture.BBBBBBBBBBBBBBBB.signature",
  "ois1.fixture.CCCCCCCCCCCCCCCC.signature",
  "ois1.fixture.DDDDDDDDDDDDDDDD.signature",
];

Deno.test("HTTP lifecycle carries rotated integrity state into preparation and submission", async () => {
  const originalFetch = globalThis.fetch;
  const session = new ChatSession("fixture-token", "fixture-account");
  const paths = [
    "/backend-api/sentinel/sdk.js",
    "/backend-api/sentinel/chat-requirements/prepare",
    "/backend-api/sentinel/chat-requirements/finalize",
    "/backend-api/f/conversation/prepare",
    "/backend-api/f/conversation",
  ];
  let step = 0;
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const cookie = request.headers.get("cookie") ?? "";
    if (new URL(request.url).pathname !== paths[step]) {
      throw new Error("Unexpected lifecycle request");
    }
    const expected = step === 0 ? null : states[step - 1];
    if (
      expected === null
        ? cookie.includes("__Secure-oai-is=")
        : !cookie.split("; ").includes(`__Secure-oai-is=${expected}`)
    ) throw new Error("Request sent stale integrity state");
    if (step === 4) {
      if (
        request.headers.get("x-oai-is-client-observation") !==
          "v1.s.p.DDDDDDDDDDDDDDDD" || !cookie.includes("oai-sc=fixture")
      ) throw new Error("Submission lost observation or ordinary cookie state");
    }
    const headers = new Headers();
    if (step < states.length) headers.set("x-oai-is-update", states[step]);
    if (step === 1) headers.set("set-cookie", "oai-sc=fixture; Secure; Path=/");
    step++;
    return Promise.resolve(new Response(null, { headers }));
  };
  try {
    for (const path of paths.slice(0, -1)) {
      await session.fetch(`https://chatgpt.com${path}`);
    }
    await session.fetch(`https://chatgpt.com${paths[4]}`, {
      method: "POST",
      headers: {
        "x-oai-is-client-observation": clientObservation(
          session.cookies.header(),
        ),
      },
    });
    if (step !== 5) throw new Error("Lifecycle did not reach submission");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("late integrity updates cannot overwrite a completed rotation", async () => {
  const originalFetch = globalThis.fetch;
  const session = new ChatSession("fixture-token", "fixture-account");
  session.cookies.set("__Secure-oai-is", states[0]);
  const resolveResponses: Array<(response: Response) => void> = [];
  globalThis.fetch = () =>
    new Promise((resolve) => resolveResponses.push(resolve));
  try {
    const slow = session.fetch("https://chatgpt.com/slow");
    const fast = session.fetch("https://chatgpt.com/fast");
    resolveResponses[1](
      new Response(null, {
        headers: { "x-oai-is-update": states[1] },
      }),
    );
    await fast;
    resolveResponses[0](
      new Response(null, {
        headers: {
          "x-oai-is-update": states[2],
          "set-cookie": "oai-sc=late; Secure",
        },
      }),
    );
    await slow;
    if (
      session.cookies.integrityState() !== states[1] ||
      !session.cookies.header().includes("oai-sc=late")
    ) {
      throw new Error(
        "Late response overwrote state or lost unrelated cookies",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("invalid updates are ignored and Set-Cookie rotation wins over stale header", async () => {
  const originalFetch = globalThis.fetch;
  const session = new ChatSession("fixture-token", "fixture-account");
  session.cookies.set("__Secure-oai-is", states[0]);
  try {
    for (
      const update of ["", "invalid", `${states[1]}.extra`, "x".repeat(2049)]
    ) {
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(null, {
            headers: { "x-oai-is-update": update },
          }),
        );
      await session.fetch("https://chatgpt.com/fixture");
      if (session.cookies.integrityState() !== states[0]) {
        throw new Error("Invalid update changed integrity state");
      }
    }
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(null, {
          headers: {
            "set-cookie": `__Secure-oai-is=${states[2]}; Secure; Path=/`,
            "x-oai-is-update": states[1],
          },
        }),
      );
    await session.fetch("https://chatgpt.com/fixture");
    if (session.cookies.integrityState() !== states[2]) {
      throw new Error("Header update overwrote the Set-Cookie rotation");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("invalid stored state can bootstrap from a valid response update", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const value of ["", "%invalid", `${states[0]}%0A`]) {
      const session = new ChatSession("fixture-token", "fixture-account");
      session.cookies.set("__Secure-oai-is", value);
      if (session.cookies.integrityState() !== null) {
        throw new Error("Malformed stored state was accepted");
      }
      if (clientObservation(session.cookies.header()) !== "v1.s.i") {
        throw new Error("Malformed stored state was reported as present");
      }
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(null, {
            headers: { "x-oai-is-update": states[0] },
          }),
        );
      await session.fetch("https://chatgpt.com/fixture");
      if (session.cookies.integrityState() !== states[0]) {
        throw new Error("Valid bootstrap update was discarded");
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
