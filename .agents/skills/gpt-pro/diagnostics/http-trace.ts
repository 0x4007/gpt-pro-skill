// Diagnostic-only fetch boundary. Never import this from the shipped helper.
// Records contain credentials and prompts: keep the parent directory Git-ignored.
export async function createHttpTrace(parent: string, transport = fetch) {
  const directory = await Deno.makeTempDir({ dir: parent, prefix: "http-" });
  await Deno.chmod(directory, 0o700);
  const started = performance.now();
  const pending: Promise<void>[] = [];
  let sequence = 0;

  async function record(name: string, value: unknown): Promise<void> {
    await Deno.writeTextFile(
      `${directory}/${name}.json`,
      JSON.stringify(value, null, 2),
      { mode: 0o600, createNew: true },
    );
  }

  const tracedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const id = String(++sequence).padStart(4, "0");
    const capturedAtMs = performance.now() - started;
    await record(`${id}-request`, {
      capturedAt: new Date().toISOString(),
      capturedAtMs,
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: await request.clone().text(),
      redirect: request.redirect,
      credentials: request.credentials,
    });
    const sentAtMs = performance.now() - started;
    let response: Response;
    try {
      // Exactly one transport call. Rejected submissions must never be retried.
      response = await transport(request);
    } catch (error) {
      await record(`${id}-error`, {
        sentAtMs,
        failedAtMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const headersAtMs = performance.now() - started;
    const copy = response.clone();
    // Consume the copy concurrently so tracing does not delay SSE delivery.
    // Settle failures now to avoid an unhandled rejection during a long stream.
    pending.push((async () => {
      let body: string | undefined;
      let bodyError: string | undefined;
      try {
        body = await copy.text();
      } catch (error) {
        bodyError = error instanceof Error ? error.message : String(error);
      }
      await record(`${id}-response`, {
        sentAtMs,
        headersAtMs,
        completedAtMs: performance.now() - started,
        url: response.url,
        status: response.status,
        headers: [...response.headers],
        setCookie: response.headers.getSetCookie(),
        redirected: response.redirected,
        body,
        bodyError,
      });
    })());
    // Attach a handler immediately; close() still reports the original failure.
    pending.at(-1)!.catch(() => {});
    return response;
  };

  return {
    directory,
    fetch: tracedFetch,
    async close() {
      const results = await Promise.allSettled(pending);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("HTTP trace could not be persisted completely");
      }
    },
  };
}
