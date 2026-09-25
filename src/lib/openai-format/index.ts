// PHASE P5 — OpenAI-compatible format layer.
// Translates a RunResult into OpenAI-shaped responses, SSE chunks, and error bodies.

import { randomUUID } from "node:crypto";

export interface RunResultLike {
  content: string;
  finish_reason: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
  sessionId?: string | null;
}

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type CompletionChoice = {
  index: number;
  message: { role: string; content: string };
  finish_reason: string | null;
};

export type ChatCompletion = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage?: Usage;
};

export type DeltaContent = { content?: string };

export type ChatCompletionChunk = {
  id: string;
  model: string;
  created: number;
  object: string;
  choices: Array<{ index: number; delta: DeltaContent; finish_reason: string | null }>;
};

export type OpenAIErrorBody = {
  message: string;
  type: string;
  code?: string;
  param: string | null;
};

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null ? (value as Rec) : null;
}

function detectStatus(err: unknown): number | null {
  const rec = asRecord(err);
  if (!rec) return null;
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  return null;
}

export function buildCompletionWithId(
  result: RunResultLike,
  model: string,
  id: string,
  created: number,
): ChatCompletion {
  const completion: ChatCompletion = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.content },
        finish_reason: result.finish_reason,
      },
    ],
  };
  if (result.usage !== null) completion.usage = result.usage;
  return completion;
}

export function buildCompletion(result: RunResultLike, model: string): ChatCompletion {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  return buildCompletionWithId(result, model, id, created);
}

export function buildChunk(
  id: string,
  model: string,
  created: number,
  delta: DeltaContent,
  finishReason: string | null,
): ChatCompletionChunk {
  return {
    id,
    model,
    created,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export function buildSseBody(content: string, model: string, finishReason: string): string {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const contentChunk = buildChunk(id, model, created, { content }, null);
  const finalChunk = buildChunk(id, model, created, {}, finishReason);
  return sseEvent(contentChunk) + sseEvent(finalChunk) + SSE_DONE;
}

export function toOpenAIErrorBody(
  err: unknown,
  status = 500,
): { status: number; body: { error: OpenAIErrorBody } } {
  const message = err instanceof Error ? err.message : String(err);
  const detected = detectStatus(err);
  const finalStatus = status === 500 && detected !== null ? detected : status;

  const error: OpenAIErrorBody =
    finalStatus === 400 || finalStatus === 422
      ? { message, type: "invalid_request_error", param: null }
      : { message, type: "server_error", code: "opencode_error", param: null };

  return { status: finalStatus, body: { error } };
}
