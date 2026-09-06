import {
  ChatSession,
  conversationBody,
  SentinelHarness,
} from "../scripts/ask-gpt-pro.ts";

// Synthetic SDK surface; no saved SDK, challenge, or account data is bundled.
const sdk = `
if (document.cookie.includes("PRIVATE_AUTH_FIXTURE")) throw new Error("SDK can read HttpOnly credentials");
document.cookie = "__Secure-next-auth.session-token=overwritten";
class O {
  getRequirementsToken() { return "fixture-requirements-proof"; }
  _generateAnswerAsync() { throw new Error("Low-level answer lacks protocol framing"); }
  getEnforcementToken(requirements) {
    if (requirements.proofofwork.seed !== "fixture-seed" || requirements.proofofwork.difficulty !== "fixture-difficulty") throw new Error("Requirements were lost");
    return "gAAAAABfixture-enforcement-proof~S";
  }
}
var E=new O;
function D(requirements, proof) {
  if (proof !== "fixture-requirements-proof") throw new Error("Wrong bound proof");
}
function Rn() { throw new Error("Unexpected Turnstile execution"); }
var _n="undefined"!=typeof globalThis?globalThis:this;
if (window.top === window) document.body.appendChild(document.createElement("iframe"));
`;

Deno.test("Sentinel finalization sends the SDK enforcement token, not its raw answer", async () => {
  const original = globalThis.fetch;
  let step = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (
      !request.headers.get("cookie")?.includes(
        "__Secure-next-auth.session-token=PRIVATE_AUTH_FIXTURE",
      )
    ) throw new Error("SDK changed the HTTP authentication cookie");
    const expected = [
      "/backend-api/sentinel/sdk.js",
      "/sentinel/fixture/sdk.js",
      "/backend-api/sentinel/chat-requirements/prepare",
      "/backend-api/sentinel/chat-requirements/finalize",
    ];
    if (new URL(request.url).pathname !== expected[step++]) {
      throw new Error("Unexpected request order");
    }
    if (step === 1) {
      return new Response('"https://chatgpt.com/sentinel/fixture/sdk.js"');
    }
    if (step === 2) return new Response(sdk);
    const body = await request.json();
    if (step === 3) {
      if (body.p !== "fixture-requirements-proof") {
        throw new Error("Wrong prepare proof");
      }
      return Response.json({
        prepare_token: "fixture-prepare",
        proofofwork: {
          required: true,
          seed: "fixture-seed",
          difficulty: "fixture-difficulty",
        },
        turnstile: { required: false },
      });
    }
    if (
      body.prepare_token !== "fixture-prepare" ||
      body.proofofwork !== "gAAAAABfixture-enforcement-proof~S"
    ) throw new Error("Finalization lost protocol framing or binding");
    return Response.json({ token: "fixture-finalized-token" });
  };
  try {
    const session = new ChatSession({
      accessToken: "fixture-token",
      cookie:
        "oai-did=fixture; __Secure-next-auth.session-token=PRIVATE_AUTH_FIXTURE",
      headers: {
        "oai-device-id": "fixture",
        "oai-session-id": "fixture-session",
        "user-agent": "fixture-agent",
      },
    });
    const harness = await SentinelHarness.create(session);
    const result = await harness.chatRequirements();
    if (result.proof !== "gAAAAABfixture-enforcement-proof~S" || step !== 4) {
      throw new Error("Submission proof differs from finalized proof");
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("conversation uses the browser's timezone-offset sign", () => {
  const original = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = () => 240;
  try {
    if (
      conversationBody("fixture-prompt", "fixture-message")
        .timezone_offset_min !== 240
    ) throw new Error("Timezone offset sign was reversed");
  } finally {
    Date.prototype.getTimezoneOffset = original;
  }
});
