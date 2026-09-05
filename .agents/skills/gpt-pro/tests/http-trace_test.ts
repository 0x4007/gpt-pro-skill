import { createHttpTrace } from "../diagnostics/http-trace.ts";

Deno.test("trace preserves requests, responses, cookies, timing, and private modes", async () => {
  const parent = await Deno.makeTempDir();
  try {
    let calls = 0;
    const trace = await createHttpTrace(parent, async (input) => {
      calls++;
      const request = input as Request;
      if (request.headers.get("cookie") !== "session=private") {
        throw new Error("Cookie changed at transport boundary");
      }
      if (await request.text() !== "prompt") throw new Error("Body changed");
      return new Response("data: [DONE]\n\n", {
        status: 403,
        headers: { "set-cookie": "session=rotated; Secure; HttpOnly" },
      });
    });
    const response = await trace.fetch("https://chatgpt.com/example", {
      method: "POST",
      headers: { cookie: "session=private" },
      body: "prompt",
    });
    if (
      response.status !== 403 || await response.text() !== "data: [DONE]\n\n"
    ) {
      throw new Error("Response changed");
    }
    await trace.close();
    if (calls !== 1) throw new Error("Retried rejected request");
    const request = JSON.parse(
      await Deno.readTextFile(`${trace.directory}/0001-request.json`),
    );
    const recorded = JSON.parse(
      await Deno.readTextFile(`${trace.directory}/0001-response.json`),
    );
    if (
      request.body !== "prompt" || recorded.body !== "data: [DONE]\n\n" ||
      recorded.setCookie[0] !== "session=rotated; Secure; HttpOnly" ||
      recorded.sentAtMs < request.capturedAtMs ||
      recorded.headersAtMs < recorded.sentAtMs ||
      recorded.completedAtMs < recorded.headersAtMs
    ) throw new Error("Incomplete trace");
    if (Deno.build.os !== "windows") {
      for (const name of ["0001-request.json", "0001-response.json"]) {
        const info = await Deno.stat(`${trace.directory}/${name}`);
        if ((info.mode! & 0o777) !== 0o600) {
          throw new Error("Trace is not private");
        }
      }
      const info = await Deno.stat(trace.directory);
      if ((info.mode! & 0o777) !== 0o700) {
        throw new Error("Directory is not private");
      }
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("trace preserves network failures without retry", async () => {
  const parent = await Deno.makeTempDir();
  try {
    let calls = 0;
    const failure = new Error("transport failed");
    const trace = await createHttpTrace(parent, () => {
      calls++;
      return Promise.reject(failure);
    });
    let caught: unknown;
    try {
      await trace.fetch("https://chatgpt.com/example");
    } catch (error) {
      caught = error;
    }
    await trace.close();
    if (caught !== failure || calls !== 1) throw new Error("Failure changed");
    const recorded = JSON.parse(
      await Deno.readTextFile(`${trace.directory}/0001-error.json`),
    );
    if (recorded.error !== failure.message) {
      throw new Error("Failure not recorded");
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
