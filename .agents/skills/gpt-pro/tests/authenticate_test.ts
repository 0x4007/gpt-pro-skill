import { createCipheriv, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  clientMetadata,
  decryptCookie,
  sessionFromCookies,
  updateCookies,
} from "../scripts/authenticate.ts";
import { loadWebSession, parseWebSession } from "../scripts/ask-gpt-pro.ts";

const cookie =
  "__Secure-next-auth.session-token=fixture-session; oai-did=fixture-device; __Secure-oai-is=ois1.fixture.AAAAAAAAAAAAAAAA.signature";
const html =
  '<html lang="en-US" data-build="prod-abcdef1234" data-seq="12345">';
const token = (sub = "fixture-account", exp = 4102444800) =>
  `e30.${btoa(JSON.stringify({ sub, exp }))}.fixture`;
const encode = (value: unknown) =>
  "CHATGPT_WEB_SESSION=" + JSON.stringify(value);
function fixture(exp = 4102444800) {
  return {
    accessToken: token("fixture-account", exp),
    cookie,
    headers: {
      "user-agent": "fixture-agent",
      "oai-device-id": "fixture-device",
      "oai-session-id": "fixture-client-session",
      "oai-client-build-number": "1",
      "oai-client-version": "prod-old",
      "oai-language": "en-US",
      "accept-language": "en-US",
    },
  };
}

Deno.test("native cookie decryption validates encryption and domain binding", () => {
  const key = new Uint8Array(16).fill(42);
  const cipher = createCipheriv(
    "aes-128-cbc",
    key,
    new Uint8Array(16).fill(32),
  );
  const encrypted = Buffer.concat([
    Buffer.from("v10"),
    cipher.update(
      Buffer.concat([
        createHash("sha256").update(".chatgpt.com").digest(),
        Buffer.from("PRIVATE_FIXTURE"),
      ]),
    ),
    cipher.final(),
  ]);
  if (decryptCookie(encrypted, ".chatgpt.com", key, 24) !== "PRIVATE_FIXTURE") {
    throw new Error("Cookie did not decrypt");
  }
  for (
    const [value, host, version] of [[encrypted, ".example.com", 24], [
      encrypted,
      ".chatgpt.com",
      99,
    ], [Buffer.from("v20PRIVATE_FIXTURE"), ".chatgpt.com", 24]] as const
  ) {
    let rejected = false;
    try {
      decryptCookie(value, host, key, version);
    } catch (error) {
      rejected = true;
      if (String(error).includes("PRIVATE_FIXTURE")) {
        throw new Error("Cookie leaked into error");
      }
    }
    if (!rejected) throw new Error("Invalid protection accepted");
  }
});

Deno.test("cookie renewal removes expired chunks and preserves unrelated duplicate cookies", () => {
  const headers = new Headers();
  headers.append(
    "set-cookie",
    "__Secure-next-auth.session-token.0=new; Secure; HttpOnly",
  );
  headers.append(
    "set-cookie",
    "__Secure-next-auth.session-token.1=; Max-Age=0",
  );
  headers.append(
    "set-cookie",
    "gone=value; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  );
  const result = updateCookies(
    "__Secure-next-auth.session-token.0=old; __Secure-next-auth.session-token.1=old; scoped=one; scoped=two; gone=old",
    new Response(null, { headers }),
  );
  if (
    result !== "scoped=one; scoped=two; __Secure-next-auth.session-token.0=new"
  ) throw new Error("Cookie rotation lost data or retained old chunks");
});

Deno.test("fresh bootstrap uses only first-party HTTP and real page metadata", async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    paths.push(request.url);
    if (
      request.redirect !== "error" || request.headers.has("authorization") ||
      !request.headers.get("cookie")?.includes("fixture-session")
    ) throw new Error("Incorrect bootstrap boundary");
    return Promise.resolve(
      paths.length === 1
        ? Response.json({ accessToken: token() })
        : new Response(html),
    );
  };
  const session = await sessionFromCookies(
    cookie,
    "fixture-agent",
    undefined,
    fetcher,
  );
  if (
    paths.join(" ") !==
      "https://chatgpt.com/api/auth/session https://chatgpt.com/"
  ) throw new Error("Unexpected network request");
  if (
    session.headers["oai-client-build-number"] !== "12345" ||
    session.headers["oai-device-id"] !== "fixture-device"
  ) throw new Error("Client metadata mismatch");
  if (clientMetadata(html).version !== "prod-abcdef1234") {
    throw new Error("Build mismatch");
  }
});

Deno.test("renewal rejects account changes and throttling without retries", async () => {
  for (
    const response of [
      Response.json({ accessToken: token("another-account") }),
      new Response("PRIVATE_FIXTURE", { status: 429 }),
    ]
  ) {
    let calls = 0;
    let rejected = false;
    const fetcher: typeof fetch = () => {
      calls++;
      return Promise.resolve(response);
    };
    try {
      await sessionFromCookies(cookie, "fixture-agent", fixture(), fetcher);
    } catch (error) {
      rejected = true;
      if (String(error).includes("PRIVATE_FIXTURE")) {
        throw new Error("Server body leaked");
      }
    }
    if (!rejected || calls !== 1) {
      throw new Error("Failed renewal was accepted or retried");
    }
  }
});

Deno.test("expired session renews once across concurrent loaders and persists rotated cookies", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.chmod(dir, 0o700);
  const directory = pathToFileURL(dir + "/");
  const path = new URL(".env", directory);
  await Deno.writeTextFile(path, encode(fixture(1)), { mode: 0o600 });
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    paths.push(url.pathname);
    if (url.pathname === "/api/auth/session") {
      return Promise.resolve(
        Response.json({ accessToken: token() }, {
          headers: {
            "set-cookie": "__Secure-next-auth.session-token=rotated; Secure",
          },
        }),
      );
    }
    if (url.pathname === "/") return Promise.resolve(new Response(html));
    if (url.pathname === "/backend-api/models") {
      return Promise.resolve(new Response("{}"));
    }
    throw new Error("Unexpected network request");
  };
  try {
    const sessions = await Promise.all([
      loadWebSession(directory),
      loadWebSession(directory),
    ]);
    if (paths.join(" ") !== "/api/auth/session / /backend-api/models") {
      throw new Error("Concurrent renewal duplicated requests");
    }
    for (const session of sessions) {
      if (
        session.accessToken !== token() || !session.cookie.includes("=rotated")
      ) throw new Error("Renewal did not persist");
    }
    parseWebSession(await Deno.readTextFile(path));
    if (((await Deno.stat(path)).mode! & 0o077) !== 0) {
      throw new Error("Credential permissions changed");
    }
  } finally {
    globalThis.fetch = original;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failed expired-session renewal preserves the previous file", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.chmod(dir, 0o700);
  const directory = pathToFileURL(dir + "/");
  const path = new URL(".env", directory);
  const before = encode(fixture(1));
  await Deno.writeTextFile(path, before, { mode: 0o600 });
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("PRIVATE_FIXTURE", { status: 401 }));
  try {
    let rejected = false;
    try {
      await loadWebSession(directory);
    } catch {
      rejected = true;
    }
    if (!rejected || await Deno.readTextFile(path) !== before) {
      throw new Error("Failed renewal changed state");
    }
  } finally {
    globalThis.fetch = original;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("timed-out auth lock never enters renewal after the holder releases", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.chmod(dir, 0o700);
  const directory = pathToFileURL(dir + "/");
  await Deno.writeTextFile(new URL(".env", directory), encode(fixture(1)), {
    mode: 0o600,
  });
  const holder = await Deno.open(new URL(".auth.lock", directory), {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  await holder.lock(true);
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  let requests = 0;
  let timeoutObserved = false;
  let release: ReturnType<typeof setTimeout> | undefined;
  globalThis.fetch = () => {
    requests++;
    return Promise.resolve(new Response("{}"));
  };
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 30000) {
      return originalTimeout(() => {
        timeoutObserved = true;
        callback(...args);
        release = originalTimeout(() => holder.close(), 20);
      }, 10);
    }
    return originalTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  try {
    let rejected = false;
    try {
      await loadWebSession(directory);
    } catch {
      rejected = true;
    }
    if (!timeoutObserved || !rejected || requests !== 0) {
      throw new Error("Timed-out waiter entered renewal");
    }
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
    if (release !== undefined) clearTimeout(release);
    try {
      holder.close();
    } catch { /* Already released. */ }
    await Deno.remove(dir, { recursive: true });
  }
});
