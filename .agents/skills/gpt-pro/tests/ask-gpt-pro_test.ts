import {
  answerForMessage,
  completedAnswer,
  parseSseText,
  redactSensitiveText,
} from "../scripts/ask-gpt-pro.ts";

Deno.test("background answer must be final, complete, and belong to the requested turn", () => {
  const conversation = {
    current_node: "answer",
    mapping: {
      prompt: {
        parent: null,
        message: { id: "requested", author: { role: "user" } },
      },
      answer: {
        parent: "prompt",
        message: {
          author: { role: "assistant" },
          channel: "final",
          status: "finished_successfully",
          end_turn: true,
          content: { content_type: "text", parts: ["The answer"] },
        },
      },
    },
  };
  if (answerForMessage(conversation, "requested") !== "The answer") {
    throw new Error("Matching answer was lost");
  }
  if (answerForMessage(conversation, "different") !== undefined) {
    throw new Error("Returned an answer for another prompt");
  }
  conversation.mapping.answer.message.status = "in_progress";
  if (answerForMessage(conversation, "requested") !== undefined) {
    throw new Error("Returned an incomplete answer");
  }
  conversation.mapping.answer.message.status = "finished_successfully";
  conversation.mapping.answer.message.channel = "commentary";
  if (answerForMessage(conversation, "requested") !== undefined) {
    throw new Error("Returned commentary as the answer");
  }
});

Deno.test("completedAnswer rejects background handoffs and truncated streams", () => {
  for (
    const [raw, expected] of [
      [
        'data: {"type":"stream_handoff"}\n\ndata: [DONE]\n\n',
        "background stream",
      ],
      ['data: {"o":"append","v":"Partial answer"}\n\n', "before completion"],
    ]
  ) {
    let message = "";
    try {
      completedAnswer(parseSseText(raw));
    } catch (error) {
      message = (error as Error).message;
    }
    if (!message.includes(expected)) throw new Error(`Expected ${expected}`);
  }
  const answer = completedAnswer(parseSseText(
    'data: {"o":"append","v":"Complete answer"}\n\ndata: [DONE]\n\n',
  ));
  if (answer !== "Complete answer") {
    throw new Error("Completed answer was lost");
  }
});

Deno.test("parseSseText collects assistant message parts and terminal marker", () => {
  const fixture = [
    "event: delta_encoding",
    'data: "v1"',
    "",
    "event: delta",
    'data: {"v":{"message":{"id":"user-1","author":{"role":"user"},"content":{"parts":["ignore me"]}}}}',
    "",
    "event: delta",
    'data: {"v":{"message":{"id":"assistant-1","author":{"role":"assistant"},"content":{"parts":["Hello "]}}},"c":0}',
    "",
    "event: delta",
    'data: {"v":{"message":{"id":"assistant-1","author":{"role":"assistant"},"content":{"parts":["Hello world"]}}},"c":1}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const parsed = parseSseText(fixture);
  if (parsed.text !== "Hello world") {
    throw new Error(`unexpected text: ${parsed.text}`);
  }
  if (!parsed.terminal) throw new Error("SSE terminal marker was not detected");
  if (!parsed.eventTypes.includes("delta_encoding")) {
    throw new Error("event type was not retained");
  }
});

Deno.test("parseSseText supports append deltas", () => {
  const parsed = parseSseText(
    'event: delta\ndata: {"o":"append","v":"one"}\n\n' +
      'event: delta\ndata: {"o":"append","v":" two"}\n\n' +
      "data: [DONE]\n\n",
  );
  if (parsed.text !== "one two") {
    throw new Error(`unexpected append text: ${parsed.text}`);
  }
});

Deno.test("redactSensitiveText removes auth and long token values", () => {
  const secret = "a".repeat(220);
  const redacted = redactSensitiveText(
    `Authorization: Bearer ${secret}\nopenai-sentinel-proof-token: ${secret}`,
  );
  if (redacted.includes(secret)) {
    throw new Error("secret remained in redacted output");
  }
  if (!redacted.includes("<redacted>")) {
    throw new Error("redaction marker missing");
  }
});
