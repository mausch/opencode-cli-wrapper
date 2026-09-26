import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { CatalogError, getCatalog, parseModelsOutput, resetCatalogCache } from "../src/lib/opencode/models.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const FIXTURE_MODELS_STDOUT = `
opencode/space-bunny-free
opencode/mimo-v2.6-flash-free
opencode-go/space-bunny-free
anthropic/claude-sonnet
opencode/space-bunny-free
malformed
provider/too/many/slashes

`;

const spawnMock = vi.mocked(spawn);

function mockSpawnOutput(stdout: string): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as ChildProcess;
    const output = new PassThrough();
    Object.assign(child, { stdout: output, stderr: new PassThrough(), stdin: null, exitCode: 0 });
    queueMicrotask(() => {
      output.end(stdout);
      child.emit("close", 0);
    });
    return child;
  });
}

function mockSpawnError(message: string): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: null, exitCode: null });
    queueMicrotask(() => child.emit("error", new Error(message)));
    return child;
  });
}

function mockSpawnHang(): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitCode: null,
      killed: false,
      kill: vi.fn(() => true),
    });
    return child;
  });
}

describe("parseModelsOutput", () => {
  it("drops blanks and malformed lines, maps valid ids, deduplicates, and sorts canonically", () => {
    const entries = parseModelsOutput(FIXTURE_MODELS_STDOUT);

    expect(entries).toEqual([
      { canonical: "anthropic/claude-sonnet", provider: "anthropic", id: "claude-sonnet" },
      { canonical: "opencode-go/space-bunny-free", provider: "opencode-go", id: "space-bunny-free" },
      { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free" },
      { canonical: "opencode/space-bunny-free", provider: "opencode", id: "space-bunny-free" },
    ]);
  });
});

describe("getCatalog", () => {
  beforeEach(() => {
    resetCatalogCache();
    spawnMock.mockReset();
    vi.useRealTimers();
  });

  it("reuses the catalog within its TTL and passes the supplied environment to spawn", async () => {
    mockSpawnOutput(FIXTURE_MODELS_STDOUT);
    const env = { OPENCODE_BIN: "/custom/opencode", OPENCODE_MODELS_TTL_MS: "300000" };

    await getCatalog(env);
    await getCatalog(env);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("/custom/opencode", ["models"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  });

  it("shares one refresh between concurrent callers", async () => {
    mockSpawnOutput(FIXTURE_MODELS_STDOUT);

    const catalogs = await Promise.all([getCatalog({}), getCatalog({})]);

    expect(catalogs[0]).toEqual(catalogs[1]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("returns the prior catalog when a refresh fails", async () => {
    vi.useFakeTimers();
    mockSpawnOutput(FIXTURE_MODELS_STDOUT);
    const env = { OPENCODE_MODELS_TTL_MS: "1" };
    const warmCatalog = await getCatalog(env);
    vi.advanceTimersByTime(1);
    mockSpawnError("missing binary");

    await expect(getCatalog(env)).resolves.toEqual(warmCatalog);
  });

  it("throws CatalogError when a cold catalog cannot be loaded", async () => {
    mockSpawnError("missing binary");

    await expect(getCatalog({})).rejects.toBeInstanceOf(CatalogError);
  });

  it("rejects a cold catalog when the CLI never settles before its timeout", async () => {
    vi.useFakeTimers();
    mockSpawnHang();

    const catalog = getCatalog({ OPENCODE_MODELS_TIMEOUT_MS: "50" });
    const result = expect(catalog).rejects.toBeInstanceOf(CatalogError);
    await vi.advanceTimersByTimeAsync(50);

    await result;
  });

  it("returns the stale catalog when a refresh CLI never settles before its timeout", async () => {
    vi.useFakeTimers();
    mockSpawnOutput(FIXTURE_MODELS_STDOUT);
    const env = { OPENCODE_MODELS_TTL_MS: "1", OPENCODE_MODELS_TIMEOUT_MS: "50" };
    const warmCatalog = await getCatalog(env);
    vi.advanceTimersByTime(1);
    mockSpawnHang();

    const catalog = getCatalog(env);
    const result = expect(catalog).resolves.toEqual(warmCatalog);
    await vi.advanceTimersByTimeAsync(50);

    await result;
  });

  it("does not cache a refresh that completes after reset", async () => {
    let finishRefresh: (() => void) | undefined;
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      const output = new PassThrough();
      Object.assign(child, { stdout: output, stderr: new PassThrough(), stdin: null, exitCode: 0 });
      finishRefresh = () => {
        output.end("stale/pre-reset");
        child.emit("close", 0);
      };
      return child;
    });
    mockSpawnOutput("fresh/post-reset");

    const pendingCatalog = getCatalog({});
    resetCatalogCache();
    finishRefresh?.();
    await pendingCatalog;
    const nextCatalog = await getCatalog({});

    expect(nextCatalog.map((entry) => entry.canonical)).toEqual(["fresh/post-reset"]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
