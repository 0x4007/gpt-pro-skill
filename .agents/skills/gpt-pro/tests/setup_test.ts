import {
  importWebSession,
  loadWebSession,
  parseSessionImport,
} from "../scripts/ask-gpt-pro.ts";
import { stateDirectory } from "../scripts/state.ts";
import { pathToFileURL } from "node:url";

function fixture() {
  return {
    accessToken: `e30.${
      btoa(JSON.stringify({ sub: "fixture-subject", exp: 4102444800 }))
    }.fixture`,
    cookie:
      "oai-did=fixture-device; __Secure-oai-is=ois1.fixture.AAAAAAAAAAAAAAAA.signature",
    headers: {
      "oai-device-id": "fixture-device",
      "oai-session-id": "fixture-session",
      "oai-client-build-number": "fixture-build",
      "oai-client-version": "fixture-version",
      "user-agent": "fixture-agent",
      "oai-language": "en-US",
      "accept-language": "en-US",
    },
  };
}
Deno.test("setup imports copied request headers and filters out captured challenges", () => {
  const v = fixture();
  const raw = [
    ":authority: chatgpt.com",
    ":method: GET",
    ":path: /backend-api/models",
    `authorization: Bearer ${v.accessToken}`,
    `cookie: ${v.cookie}`,
    ...Object.entries(v.headers).map(([k, x]) => `${k}: ${x}`),
    "openai-sentinel-proof-token: NEVER_PERSIST_THIS",
    "x-openai-target-path: /backend-api/models",
  ].join("\r\n");
  const parsed = parseSessionImport(raw);
  if (JSON.stringify(parsed) !== JSON.stringify(v)) {
    throw new Error("Import changed the session or retained challenge data");
  }
  const pretty = parseSessionImport(JSON.stringify(v, null, 2));
  if (pretty.accessToken !== v.accessToken) {
    throw new Error("Pretty JSON import failed");
  }
  for (
    const input of [
      "curl 'SECRET'",
      "{SECRET",
      raw.replace("chatgpt.com", "example.com"),
    ]
  ) {
    let failed = false;
    try {
      parseSessionImport(input);
    } catch (e) {
      failed = true;
      if (String(e).includes("SECRET")) throw new Error("Import leaked input");
    }
    if (!failed) throw new Error("Invalid import accepted");
  }
});
Deno.test("portable auth storage survives a fresh loader and invalid imports preserve the old session", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.chmod(dir, 0o700);
  const url = pathToFileURL(dir + "/");
  try {
    await importWebSession(JSON.stringify(fixture()), url);
    const before = await Deno.readTextFile(new URL(".env", url));
    if ((await loadWebSession(url)).accessToken !== fixture().accessToken) {
      throw new Error("Portable auth load failed");
    }
    const mode = (await Deno.stat(new URL(".env", url))).mode;
    if (mode !== null && (mode & 0o077) !== 0) {
      throw new Error("Public auth file");
    }
    try {
      await importWebSession("invalid", url);
    } catch {}
    if (await Deno.readTextFile(new URL(".env", url)) !== before) {
      throw new Error("Invalid import destroyed credentials");
    }
    if (stateDirectory(dir).href !== url.href) {
      throw new Error("Explicit state path changed");
    }
    let rejected = false;
    try {
      stateDirectory("relative-path");
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("CWD-dependent path accepted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
