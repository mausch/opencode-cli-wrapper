// PHASE P3 — opencode CLI runner.
// Spawns `opencode run --format json -m <model>`, feeds the prompt via stdin,
// and reduces the NDJSON event stream into a single RunResult.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { getTimeoutMs, resolveOpencodeBin } from "../../config/index.js";

export interface RunParams {
  model: string;
  prompt: string;
  variant?: string;
  timeoutMs?: number;
}

export interface RunUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface RunResult {
  content: string;
  chunks: string[];
  finish_reason: string;
  usage: RunUsage | null;
  sessionId: string | null;
  error: string | null;
  toolCalls: number;
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null ? (value as Rec) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Real `step_finish` token payload: { total, input, output, reasoning, cache: { read, write } }.
// OpenAI's prompt_tokens includes cached tokens; completion_tokens includes reasoning.
function mapUsage(tokensRaw: unknown): RunUsage | null {
  const tokens = asRecord(tokensRaw);
  if (!tokens) return null;
  const cache = asRecord(tokens.cache);
  const prompt = asNumber(tokens.input) + (cache ? asNumber(cache.read) + asNumber(cache.write) : 0);
  const completion = asNumber(tokens.output) + asNumber(tokens.reasoning);
  const total = typeof tokens.total === "number" && Number.isFinite(tokens.total) ? tokens.total : prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function describeError(ev: Rec): string {
  const error = asRecord(ev.error);
  const data = error ? asRecord(error.data) : null;
  const dataMessage = data ? asString(data.message) : null;
  if (dataMessage) {
    const ref = data ? asString(data.ref) : null;
    return ref ? `${dataMessage} (${ref})` : dataMessage;
  }
  const errorMessage = error ? asString(error.message) : null;
  if (errorMessage) return errorMessage;
  return asString(ev.message) ?? "Unknown error";
}

export function reduceEvents(events: unknown[]): RunResult {
  let content = "";
  const chunks: string[] = [];
  let sessionId: string | null = null;
  let error: string | null = null;
  let finishReason = "";
  let toolCalls = 0;
  let usage: RunUsage | null = null;

  for (const raw of events) {
    const ev = asRecord(raw);
    if (!ev) continue;

    const eventSessionId = asString(ev.sessionID);
    if (eventSessionId) sessionId = eventSessionId;

    const type = asString(ev.type) ?? asString(ev.event) ?? "";
    const part = asRecord(ev.part) ?? {};

    switch (type) {
      case "text": {
        const text = asString(part.text) ?? asString(ev.text) ?? "";
        content += text;
        chunks.push(text);
        break;
      }
      case "step_finish": {
        const reason = asString(part.reason) ?? asString(ev.reason);
        if (reason) finishReason = reason;
        const mapped = mapUsage(part.tokens ?? ev.tokens);
        if (mapped) usage = mapped;
        break;
      }
      case "tool_use":
        toolCalls += 1;
        break;
      case "error":
        error = describeError(ev);
        break;
      default:
        // step_start and unknown event types carry no response content.
        break;
    }
  }

  if (error) finishReason = "error";
  else if (!finishReason) finishReason = "stop";

  return { content, chunks, finish_reason: finishReason, usage, sessionId, error, toolCalls };
}

export async function runOnce(params: RunParams, env: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  const bin = resolveOpencodeBin(env);
  const args: string[] = ["run", "--format", "json", "-m", params.model];
  if (params.variant) args.push("--variant", params.variant);

  return new Promise<RunResult>((resolve) => {
    const events: unknown[] = [];
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      const reduced = reduceEvents(events);
      let error = reduced.error;
      if (!error && timedOut) error = "timeout";
      if (!error && typeof child.exitCode === "number" && child.exitCode !== 0) {
        const stderr = stderrBuf.trim();
        if (stderr) error = stderr.slice(0, 2000);
      }
      resolve({ ...reduced, error });
    };

    const child: ChildProcess = spawn(bin, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited; nothing left to kill.
      }
      settle();
    }, params.timeoutMs ?? getTimeoutMs(env));

    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        stdoutBuf += data.toString("utf8");
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            events.push(JSON.parse(trimmed));
          } catch {
            // A single malformed line must not abort the stream.
          }
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        stderrBuf += data.toString("utf8");
      });
    }

    child.on("close", () => {
      const trailing = stdoutBuf.trim();
      if (trailing) {
        try {
          events.push(JSON.parse(trailing));
        } catch {
          // Trailing partial line that never completed; ignore.
        }
        stdoutBuf = "";
      }
      settle();
    });

    child.on("error", (err: Error) => {
      events.push({ type: "error", error: { data: { message: err.message } } });
      settle();
    });

    if (!child.stdin) {
      events.push({ type: "error", error: { data: { message: `failed to open stdin for '${bin}'` } } });
      settle();
      return;
    }

    // Never let an EPIPE on stdin become an unhandled error.
    child.stdin.on("error", () => {
      // The child closed stdin early; the prompt was still accepted.
    });
    child.stdin.end(params.prompt);
  });
}
