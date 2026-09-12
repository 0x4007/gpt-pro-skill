import { assertRecord, type JsonObject, MODEL, MODEL_RESPONSE_CONTRACTS, objectValue } from "./shared.ts";

interface ParsedSse {
  text: string;
  terminal: boolean;
  eventTypes: string[];
  conversationId?: string;
}

export function completedAnswer(parsed: ParsedSse): string {
  if (parsed.eventTypes.includes("stream_handoff")) {
    throw new Error("Conversation handed off to a background stream; retrieve the answer from the conversation instead of resubmitting the prompt.");
  }
  if (!parsed.terminal) {
    throw new Error("Conversation stream ended before completion; do not resubmit the prompt automatically.");
  }
  if (!parsed.text.trim()) {
    throw new Error("Conversation stream ended without assistant text");
  }
  return parsed.text;
}

/** Joins the text parts of an assistant message, ignoring any non-string entries. */
function messagePartsText(message: JsonObject): string {
  const rawParts = objectValue(message.content)?.parts;
  const parts: unknown[] = Array.isArray(rawParts) ? rawParts : [];
  return parts.filter((part) => typeof part === "string").join("");
}

/** A mapping node counts only when it is a finished, final-turn assistant message. */
function completedAssistantMessage(node: JsonObject): JsonObject | undefined {
  const message = objectValue(node.message);
  if (!message) return undefined;
  if (objectValue(message.author)?.role !== "assistant") return undefined;
  if (message.channel !== "final" || message.status !== "finished_successfully" || message.end_turn !== true) return undefined;
  const content = objectValue(message.content);
  if (content?.content_type !== "text" || !Array.isArray(content.parts)) return undefined;
  const modelSlug = objectValue(message.metadata)?.model_slug;
  if (modelSlug && modelSlug !== MODEL) return undefined;
  return message;
}

/** Walks parent links until the prompt message, then returns the answer text for that prompt. */
function answerTextForPrompt(mapping: JsonObject, node: JsonObject, message: JsonObject, messageId: string): string | undefined {
  const visited = new Set<string>();
  let parent = node.parent;
  while (typeof parent === "string" && !visited.has(parent)) {
    visited.add(parent);
    const ancestor = objectValue(mapping[parent]);
    if (!ancestor) break;
    const ancestorMessage = objectValue(ancestor.message);
    if (objectValue(ancestorMessage?.author)?.role === "user") {
      if (ancestorMessage?.id !== messageId) return undefined;
      const text = messagePartsText(message);
      return text.trim() ? text : undefined;
    }
    parent = ancestor.parent;
  }
  return undefined;
}

export function answerForMessage(conversation: JsonObject, messageId: string): string | undefined {
  const mapping = assertRecord(conversation.mapping, "Conversation mapping");
  const answers = new Set<string>();
  for (const node of Object.values(mapping)) {
    const record = objectValue(node);
    const message = record === undefined ? undefined : completedAssistantMessage(record);
    if (!record || !message) continue;
    const text = answerTextForPrompt(mapping, record, message, messageId);
    if (text !== undefined) answers.add(text);
  }
  return answers.size === 1 ? [...answers][0] : undefined;
}

function appendAssistantValue(value: JsonObject, messages: Map<string, string>, fallback: { value: string }): void {
  const fromStream = objectValue(objectValue(value.v)?.message);
  const message = fromStream ?? objectValue(value.message);
  if (message) {
    const role = objectValue(message.author)?.role;
    const parts = objectValue(message.content)?.parts;
    if (role === "assistant" && Array.isArray(parts)) {
      const text = messagePartsText(message);
      const id = typeof message.id === "string" ? message.id : `message-${String(messages.size)}`;
      messages.set(id, text);
    }
  }
  if (value.o === "append" && typeof value.v === "string") {
    fallback.value += value.v;
  }
}

export function parseSseText(raw: string): ParsedSse {
  const messages = new Map<string, string>();
  const fallback = { value: "" };
  const eventTypes: string[] = [];
  let event = "message";
  let dataLines: string[] = [];
  let terminal = false;
  let conversationId: string | undefined;

  function flush(): void {
    if (dataLines.length === 0) {
      event = "message";
      return;
    }
    const data = dataLines.join("\n");
    if (event !== "message") eventTypes.push(event);
    if (data === "[DONE]") {
      terminal = true;
    } else {
      try {
        const parsed = JSON.parse(data) as JsonObject;
        if (typeof parsed.conversation_id === "string") {
          conversationId = parsed.conversation_id;
        }
        if (parsed.type === "stream_handoff" || parsed.type === "conversation_detail_metadata") {
          eventTypes.push(parsed.type);
        }
        appendAssistantValue(parsed, messages, fallback);
      } catch {}
    }
    event = "message";
    dataLines = [];
  }
  for (const line of raw.replaceAll("\r\n", "\n").split("\n")) {
    if (line === "") {
      flush();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();

  const text = messages.size > 0 ? [...messages.values()].join("\n") : fallback.value;
  return { text, terminal, eventTypes, conversationId };
}

export function conversationBody(prompt: string, messageId: string): JsonObject {
  return {
    action: "next",
    messages: [
      {
        id: messageId,
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content: { content_type: "text", parts: [prompt] },
        metadata: {
          selected_sources: [],
          serialization_metadata: { custom_symbol_offsets: [] },
          submission_mode: "manual_send",
        },
      },
    ],
    parent_message_id: "client-created-root",
    model: MODEL,
    client_prepare_state: "sent",
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    conversation_mode: { kind: "primary_assistant" },
    enable_message_followups: true,
    system_hints: [],
    model_response_contracts: MODEL_RESPONSE_CONTRACTS,
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_contextual_info: {
      is_dark_mode: true,
      time_since_loaded: 0,
      page_height: 1581,
      page_width: 1505,
      pixel_ratio: 2,
      screen_height: 2160,
      screen_width: 3840,
      app_name: "chatgpt.com",
      has_web_push_capabilities: true,
      web_push_notification_permission: "default",
    },
    paragen_cot_summary_display_override: "allow",
    force_parallel_switch: "auto",
    thinking_effort: "standard",
    local_function_names: ["local.continue_in_work"],
  };
}
