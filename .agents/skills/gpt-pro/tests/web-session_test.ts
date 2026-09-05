import { ChatSession, parseWebSession } from "../scripts/ask-gpt-pro.ts";

function fixture() {
  return {
    accessToken: `e30.${btoa(JSON.stringify({ exp: 4102444800 }))}.fixture`,
    cookie:
      "oai-did=fixture-device; __Secure-oai-is=ois1.fixture.AAAAAAAAAAAAAAAA.signature; session=fixture; scoped=first; scoped=second",
    headers: {
      "oai-device-id": "fixture-device",
      "oai-session-id": "fixture-session",
      "oai-client-build-number": "fixture-build",
      "oai-client-version": "fixture-version",
      "user-agent": "fixture-agent",
      "oai-language": "en-US",
      "accept-language": "en-US",
    } as Record<string, string>,
  };
}
const encode = (value: unknown) =>
  `CHATGPT_WEB_SESSION='${JSON.stringify(value)}'`;

Deno.test("web session preserves the approved snapshot through the HTTP boundary", async () => {
  const original = globalThis.fetch;
  try {
    for (const account of [undefined, "fixture-account"]) {
      const value = fixture();
      if (account) value.headers["chatgpt-account-id"] = account;
      const session = new ChatSession(parseWebSession(encode(value)));
      globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        if (
          request.headers.get("cookie") !== value.cookie ||
          request.headers.get("authorization") !==
            `Bearer ${value.accessToken}` ||
          request.headers.get("chatgpt-account-id") !== (account ?? null) ||
          request.redirect !== "error"
        ) throw new Error("Snapshot or redirect policy was lost");
        for (const [name, expected] of Object.entries(value.headers)) {
          if (request.headers.get(name) !== expected) {
            throw new Error("Captured header was changed");
          }
        }
        return Promise.resolve(new Response(null));
      };
      await session.fetch("https://chatgpt.com/backend-api/models");
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("invalid web snapshots fail without exposing credential content", () => {
  const inputs = [
    "",
    "CHATGPT_WEB_SESSION='SECRET_INVALID_JSON'",
    encode(fixture()) + "\n" + encode(fixture()),
  ];
  for (
    const mutate of [
      (v: ReturnType<typeof fixture>) => {
        v.headers.authorization = "SECRET_VALUE";
      },
      (v: ReturnType<typeof fixture>) => {
        v.headers["user-agent"] = "SECRET_VALUE\r\nx: injected";
      },
      (v: ReturnType<typeof fixture>) => {
        v.cookie = "oai-did=SECRET_VALUE";
      },
      (v: ReturnType<typeof fixture>) => {
        v.headers["oai-device-id"] = "SECRET_VALUE";
      },
      (v: ReturnType<typeof fixture>) => {
        v.accessToken = "SECRET_VALUE";
      },
      (v: ReturnType<typeof fixture>) => {
        v.accessToken = `e30.${btoa('{"exp":1}')}.SECRET_VALUE`;
      },
      (v: ReturnType<typeof fixture>) => {
        v.cookie += "; oai-did=SECRET_VALUE";
      },
      (v: ReturnType<typeof fixture>) => {
        delete v.headers["oai-session-id"];
      },
    ]
  ) {
    const value = fixture();
    mutate(value);
    inputs.push(encode(value));
  }
  for (const input of inputs) {
    let rejected = false;
    try {
      parseWebSession(input);
    } catch (error) {
      rejected = true;
      if (!(error instanceof Error) || error.message.includes("SECRET")) {
        throw new Error("Credential exposed in error");
      }
    }
    if (!rejected) throw new Error("Invalid snapshot accepted");
  }
});

Deno.test("cross-origin requests never reach credential-bearing transport", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    return Promise.resolve(new Response(null));
  };
  try {
    const session = new ChatSession(parseWebSession(encode(fixture())));
    for (
      const url of [
        "https://example.com/",
        "http://chatgpt.com/",
        "https://chatgpt.com.evil.example/",
      ]
    ) {
      let rejected = false;
      try {
        await session.fetch(url);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("Cross-origin request accepted");
    }
    if (calls !== 0) throw new Error("Credentials reached transport");
  } finally {
    globalThis.fetch = original;
  }
});
