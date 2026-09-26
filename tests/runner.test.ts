import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { reduceEvents, runOnce } from "../src/lib/opencode/runner.js";
import type { RunParams, RunResult } from "../src/lib/opencode/runner.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);

function mockSpawnClose(): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    Object.assign(child, { stdin, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: 0 });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
}

describe("runOnce spawn environment", () => {
  beforeEach(() => spawnMock.mockReset());

  it("passes a caller-supplied API key to spawn without putting it in the result error", async () => {
    mockSpawnClose();
    const env = { OPENCODE_API_KEY: "t" };

    const result = await runOnce({ model: "provider/model", prompt: "hello", timeoutMs: 1000 }, env);

    expect(spawnMock).toHaveBeenCalledWith("opencode", ["run", "--format", "json", "-m", "provider/model"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    expect(result.error).toBeNull();
  });

  it("passes an environment without an API key when auth is not supplied", async () => {
    mockSpawnClose();

    await runOnce({ model: "provider/model", prompt: "hello", timeoutMs: 1000 }, {});

    expect(spawnMock).toHaveBeenCalledWith("opencode", ["run", "--format", "json", "-m", "provider/model"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
    });
  });

  it("keeps the supplied API key out of errors derived from stderr", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as ChildProcess;
      const stderr = new PassThrough();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr, exitCode: 1 });
      queueMicrotask(() => {
        stderr.end("upstream failure");
        child.emit("close", 1);
      });
      return child;
    });
    const env = { OPENCODE_API_KEY: "unique-secret-token" };

    const result = await runOnce({ model: "provider/model", prompt: "hello", timeoutMs: 1000 }, env);

    expect(result.error).toBe("upstream failure");
    expect(result.error).not.toContain(env.OPENCODE_API_KEY);
  });
});

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
    vi.doUnmock("node:child_process");
    vi.resetModules();
    const { runOnce: runWithRealSpawn } = await import("../src/lib/opencode/runner.js");
    const res: RunResult = await runWithRealSpawn(
      {
        model: "opencode/mimo-v2.6-flash-free",
        prompt: "Responda apenas com a palavra: ok",
        timeoutMs: 90_000,
      },
      {},
    );

    expect(res.error).toBeNull();
    expect(res.content.length).toBeGreaterThan(0);
    expect(res.finish_reason).toBeTruthy();
    expect(res.usage?.prompt_tokens).toBeGreaterThan(0);
  },
  120_000,
);
