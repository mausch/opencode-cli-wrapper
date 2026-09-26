import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { resolveOpencodeBin } from "../../config/index.js";

export interface CatalogEntry {
  readonly canonical: string;
  readonly provider: string;
  readonly id: string;
  readonly limits: ModelLimits | null;
}

export interface ModelLimits {
  readonly context: number | null;
  readonly input: number | null;
  readonly output: number | null;
}

interface CatalogCache {
  readonly entries: CatalogEntry[];
  readonly fetchedAt: number;
}

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_MODELS_TIMEOUT_MS = 30_000;

let catalogCache: CatalogCache | null = null;
let refreshPromise: Promise<CatalogEntry[]> | null = null;
let catalogGeneration = 0;

export class CatalogError extends Error {
  override name = "CatalogError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, CatalogError.prototype);
  }
}

export function getModelsTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.OPENCODE_MODELS_TTL_MS;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TTL_MS;
}

export function getModelsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.OPENCODE_MODELS_TIMEOUT_MS;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MODELS_TIMEOUT_MS;
}

export function parseModelsOutput(stdout: string): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  for (const line of stdout.split("\n")) {
    const canonical = line.trim();
    const separator = canonical.indexOf("/");
    if (separator <= 0 || separator !== canonical.lastIndexOf("/")) continue;
    const provider = canonical.slice(0, separator);
    const id = canonical.slice(separator + 1);
    if (id.length === 0) continue;
    entries.set(canonical, { canonical, provider, id, limits: null });
  }
  return [...entries.values()].sort((left, right) => left.canonical.localeCompare(right.canonical));
}

function readRawModelBlock(lines: readonly string[], start: number): { readonly json: string; readonly next: number } | null {
  if (lines[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let json = "";
  for (let lineIndex = start; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined) return null;
    json += `${line}\n`;
    for (const character of line) {
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    if (depth === 0) return { json, next: lineIndex + 1 };
  }
  return null;
}

function readLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseVerboseModelsOutput(stdout: string): CatalogEntry[] {
  const lines = stdout.split("\n");
  const entries = new Map<string, CatalogEntry>();
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]?.trim() ?? "";
    const block = readRawModelBlock(lines, index + 1);
    if (block) {
      index = block.next - 1;
      try {
        const parsed: unknown = JSON.parse(block.json);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        const record = parsed as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.providerID !== "string") continue;
        const limit = typeof record.limit === "object" && record.limit !== null && !Array.isArray(record.limit)
          ? record.limit as Record<string, unknown>
          : {};
        const canonical = `${record.providerID}/${record.id}`;
        entries.set(canonical, {
          canonical,
          provider: record.providerID,
          id: record.id,
          limits: {
            context: readLimit(limit.context),
            input: readLimit(limit.input),
            output: readLimit(limit.output),
          },
        });
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      continue;
    }
    const separator = header.indexOf("/");
    if (separator <= 0 || separator !== header.lastIndexOf("/")) continue;
    const id = header.slice(separator + 1);
    if (id.length === 0) continue;
    entries.set(header, { canonical: header, provider: header.slice(0, separator), id, limits: null });
  }
  return [...entries.values()].sort((left, right) => left.canonical.localeCompare(right.canonical));
}

type ModelsRunResult =
  | { readonly status: "ok"; readonly stdout: string }
  | { readonly status: "exit" }
  | { readonly status: "error" };

function runModels(bin: string, env: NodeJS.ProcessEnv, args: readonly string[]): Promise<ModelsRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: ModelsRunResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const child: ChildProcess = spawn(bin, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.on("error", () => finish({ status: "error" }));
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;
      finish(code === 0 ? { status: "ok", stdout } : { status: "exit" });
    });
    timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      finish({ status: "error" });
    }, getModelsTimeoutMs(env));
  });
}

async function readCatalog(bin: string, env: NodeJS.ProcessEnv): Promise<CatalogEntry[]> {
  const verbose = await runModels(bin, env, ["models", "--verbose"]);
  if (verbose.status === "ok") return parseVerboseModelsOutput(verbose.stdout);
  if (verbose.status === "error") throw new CatalogError("Unable to read model catalog");
  const plain = await runModels(bin, env, ["models"]);
  if (plain.status !== "ok") throw new CatalogError("Unable to read model catalog");
  return parseModelsOutput(plain.stdout);
}

export async function getCatalog(env: NodeJS.ProcessEnv = process.env): Promise<CatalogEntry[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < getModelsTtlMs(env)) return catalogCache.entries;
  if (!refreshPromise) {
    const generation = catalogGeneration;
    refreshPromise = readCatalog(resolveOpencodeBin(env), env)
      .then((entries) => {
        if (generation === catalogGeneration) catalogCache = { entries, fetchedAt: Date.now() };
        return entries;
      })
      .catch((cause: unknown) => {
        if (catalogCache) return catalogCache.entries;
        if (cause instanceof CatalogError) throw cause;
        throw new CatalogError("Unable to read model catalog");
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export function resetCatalogCache(): void {
  catalogGeneration += 1;
  catalogCache = null;
  refreshPromise = null;
}
