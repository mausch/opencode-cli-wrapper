import { describe, it, expect } from "vitest";
import { reduceEvents, runOnce } from "../src/lib/opencode/runner.js";
import type { RunParams, RunResult } from "../src/lib/opencode/runner.js";

describe("reduceEvents", () => {
  it("concatenates text events and maps the real opencode token payload", () => {
    const events: unknown[] = [
      { type: "step_start", sessionID: "ses_1" },
      { type: "text", sessionID: "ses_1", part: { type: "text", text: "Hello " } },
      { type: "text", sessionID: "ses_1", part: { type: "text", text: "World" } },
      { type: "tool_use", sessionID: "ses_1" },
      {
        type: "step_finish",
        sessionID: "ses_1",
        part: {
          type: "step_finish",
          reason: "stop",
          tokens: { total: 32892, input: 250, output: 2, reasoning: 0, cache: { write: 0, read: 32640 } },
        },
      },
    ];

    const res = reduceEvents(events);

    expect(res.content).toBe("Hello World");
    expect(res.chunks).toEqual(["Hello ", "World"]);
    expect(res.finish_reason).toBe("stop");
    expect(res.usage).toEqual({ prompt_tokens: 32890, completion_tokens: 2, total_tokens: 32892 });
    expect(res.sessionId).toBe("ses_1");
    expect(res.error).toBeNull();
    expect(res.toolCalls).toBe(1);
  });

  it("parses error events into an error string and finish_reason error", () => {
    const events: unknown[] = [
      { type: "step_start", sessionID: "ses_2" },
      { type: "error", error: { data: { message: "boom", ref: "R1" } } },
    ];

    const res = reduceEvents(events);

    expect(res.error).toBe("boom (R1)");
    expect(res.finish_reason).toBe("error");
  });

  it("falls back to stop when there is no step_finish and no error", () => {
    const events: unknown[] = [
      { type: "step_start", sessionID: "ses_3" },
      { type: "text", sessionID: "ses_3", part: { type: "text", text: "abc" } },
    ];

    const res = reduceEvents(events);

    expect(res.content).toBe("abc");
    expect(res.finish_reason).toBe("stop");
  });

  it("ignores malformed and unknown events without aborting", () => {
    const events: unknown[] = [null, 42, "nope", { type: "unknown" }, { type: "text", part: { text: "ok" } }];

    const res = reduceEvents(events);

    expect(res.content).toBe("ok");
    expect(res.finish_reason).toBe("stop");
    expect(res.error).toBeNull();
    expect(res.usage).toBeNull();
  });
});

const itIntegration = process.env.INTEGRATION === "1" ? it : it.skip;

itIntegration(
  "runs a free model end-to-end through the CLI",
  async () => {
    const params: RunParams = {
      model: "deepseek/deepseek-flash",
      prompt: "Responda apenas com a palavra: ok",
      timeoutMs: 90_000,
    };

    const res: RunResult = await runOnce(params, {});

    expect(res.error).toBeNull();
    expect(res.content.length).toBeGreaterThan(0);
    expect(res.finish_reason).toBeTruthy();
    expect(res.usage).not.toBeNull();
    if (res.usage) {
      expect(res.usage.prompt_tokens).toBeGreaterThan(0);
    }
  },
  120_000,
);
