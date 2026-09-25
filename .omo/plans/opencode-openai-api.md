# 🏗 Execution Plan — OpenCode-compatible OpenAI API

> Translation of `docs/plan.md` (handoff) into an actionable, ordered build plan for a greenfield project. Source of truth for spikes/rationale stays in `docs/plan.md` (§3–§5).
>
> **Stack (locked):** Node.js + TypeScript + Fastify + OpenAI SDK (types/schemas), Docker-native. **Core = `opencode run` CLI** (`child_process`), never the OpenCode HTTP endpoint.
>
> Status: **Complete (P1–P9).** Verified: `tsc -p tsconfig.json --noEmit` clean; `npx vitest run` green and 36/36 with `INTEGRATION=1` (real `opencode` calls); `docker compose up --build` serves `/v1/models` and a working `chat.completion`.

---

## 0. Context & key facts

| Item | Value | Source |
|---|---|---|
| Goal | OpenAI-compatible HTTP API consuming OpenCode free models via CLI | §1 |
| Why CLI | HTTP endpoint only frees models for OpenCode Herency users | §2 |
| Free models | `opencode/mimo-v2.6-flash-free`, `space-bunny-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `ling-3.0-flash-fin-free`, `muse-spark-1.3-contributor-free`, `opencode-go/qwen3.8-flash` (+ other `opencode-go/*`), `deepseek/deepseek-flash` | §3.3 |
| History design | **prompt-embed** (inject whole history as instruction; last msg = question). Not `--continue` (no recall) | §4, §3.5/§3.6 |
| Response content | concat of **all** `text` events (tool events ignored) | §4 |
| Streaming | **buffered** in MVP — one `text` event per step (no token streaming) | §3.4, §4 |
| Freshness caveat | Spikes were run with `opencode 1.18.31` — pin that version in Docker | §3 intro |

---

## 1. Definition of Done (acceptance)

The API is complete when **all** are true:

- [x] Docker container exposes an OpenAI-compatible server (default `http://localhost:3000`).
- [x] `GET /v1/models` lists only curated `-free` models.
- [x] `POST /v1/chat/completions` (`stream:false`) returns a valid `chat.completion` with `choices[0].message.content` and `finish_reason`.
- [x] `POST /v1/chat/completions` (`stream:true`) returns `text/event-stream` ending in `data: [DONE]`.
- [x] Invalid `model` not in allowlist → `404`. Invalid body → `400`. Upstream/model error → `500`.
- [x] `temperature`/`variant`/`max_tokens` are **not** surfaced as hard params (MVP); `free`-only is enforced at the wrapper layer.
- [x] `README.md` documents setup, Docker run, curl + SDK usage, and the known limitations.

---

## 2. Work breakdown (ordered)

Estimated per phase (units ≈ 1 developer-day each; P1–P4 can run in parallel since interfaces are fixed).

| # | Phase | Files | Effort | DoD |
|---|---|---|---|---|
| P1 | Scaffold & deps | `package.json`, `tsconfig.json`, `.env.example`, `Dockerfile`, `docker-compose.yml` | 🟨 | Clean `npm ci`; `npm run build` compiles; types/lint OK |
| P2 | Config module | `src/config/index.ts` | 🟨 | Unit tests pass |
| P3 | OpenCode runner | `src/lib/opencode/runner.ts` | 🟥 (riskiest) | Integration test on `-free` model |
| P4 | Prompt-embed composer | `src/lib/opencode/compose.ts` | 🟨 | Unit test passes |
| P5 | OpenAI format layer | `src/lib/openai-format/index.ts` | 🟨 | Schema/Shapes match §5 |
| P6 | Routes | `src/routes/models.ts`, `src/routes/chat.ts` | 🟨 | curl happy-path + error-cases pass |
| P7 | Server | `src/server.ts` | 🟩 | Server boots & routes resolve |
| P8 | Packaging & docs | `README.md`, finalize `Dockerfile`/compose | 🟩 | `docker compose up` boots & works |
| P9 | Verification & edge cases | (tests + manual) | 🟩 | All edge cases handled; limitations documented |

---

### P1 — Scaffold & dependencies

**Goal:** project shell that builds, types, lints, and containers cleanly.

**Steps:**
1. `package.json` — runtime deps: `fastify` (v5), `@openai/sdk`, `dotenv`. Dev deps: `typescript`, `tsx` (or `ts-node`), `nodemon`, `vitest`, `@types/node`, `@types/node-fetch` (if needed). Scripts: `dev`, `build`, `start`, `test`, `lint`(optional).
2. `tsconfig.json` — `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `outDir: dist`, `strict: true`, `esModuleInterop`.
3. `.env.example` — `OPENCODE_BIN`, `PORT=3000`, `HOST=0.0.0.0` (FREE_MODELS optional; see P2).
4. `Dockerfile` — `node:20-alpine`, copy deps+src, `npm ci`, `npm run build`, `EXPOSE 3000`, healthcheck on `/v1/models`.
5. `docker-compose.yml` — build `.` → service `opencode-api`, map `3000:3000`, healthcheck, restart: unless-stopped.

**Pitfall:** `@openai/sdk` types for `chat.completion` are the contract — keep the response builder aligned, but don't create a hard runtime dep you can't control. Use it for **shapes/types**, implement serialization yourself.

---

### P2 — Config module (`src/config/index.ts`)

**Goal:** single source of truth for the binary path, the free allowlist, and model resolution/validation.

**Steps:**
1. `OPENCODE_BIN` resolution: env override → `npx -y opencode` fallback → path in `.env`/`.env.example`/PATH.
2. `FREE_MODELS`: curated allowlist array (exact `provider/model` strings from §3.3). **No** `*`-glob in MVP (a guarded glob is v2).
3. `listModels()`: return `[{ id, object: "model", owned_by: "opencode" }]` in OpenAI shape (§5.1).
4. `resolveModel(id: string)`: if `id` (after normalizing `id`/`provider/model`) ∉ allowlist → throw `ModelNotFoundError`; else return normalized `provider/model`.

**DoD:** `resolveModel("mimo-v2.6-flash-free")` → OK; `resolveModel("gpt-4")` → throws clear message.

---

### P3 — OpenCode runner (`src/lib/opencode/runner.ts`) — ⚠️ riskiest

**Goal:** spawn `opencode run --format json`, stream events, and reduce them to a single `RunResult`. This is where CLI fragility lives.

**Steps (continue the §7 skeleton):**
1. Build args: `['run', '--format', 'json', '-m', model]`. If `variant` provided → `--variant <high|minimal>`.
2. **Prompt delivery (⚠️ spike):** pass the composed prompt via **stdin**, not argv, to avoid `ARG_MAX` on long history. Verify opencode reads stdin before committing.
3. `spawn(binary, args, { input: prompt, env, shell:false, timeout... })`.
4. **Event buffer:** accumulate stdout into a string buffer; split on `\n`; `JSON.parse` each line; `for (const ev of lines) { handler(ev) }`. (Chunk boundaries — handle multi-buffer line splits.)
5. Handlers:
   - `type === "text"` → push `part.text` to `chunks` and `content`.
   - `type === "step_finish"` → capture `reason`, `tokens` → `usage`, `cost`.
   - `type === "tool_use"` → increment `toolCalls`.
   - `type === "error"` → `error = describeError(ev)` (handles `{error:{data:{message,ref}}}` and fallbacks).
   - `type === "step_start"` → capture `sessionID`.
6. `RunResult`: `{ content, chunks, finish_reason, usage, sessionId, error, toolCalls }`.
7. Timeout: `setTimeout` → kill child, mark `error = "timeout"` (killable error, expose to upstream).

**⚠️ Spike BEFORE coding P3:**
- `echo "oi" | opencode run --format json -m opencode/mimo-v2.6-flash-free` → does opencode read prompt from **stdin**? Does it support `--stdin`/`-i`? (Not tested in §3 — spikes passed prompt as argv.)
- Does the container/runtime have network to `models.dev` (no Herency needed)?
- Confirm error-event shape against a real failure.

**DoD:** run a `-free` model, assert `content` non-empty, `finish_reason === "stop"`, `usage.prompt_tokens` > 0, and a forced bad prompt yields `error` (not a thrown exception).

---

### P4 — Prompt-embed composer (`src/lib/opencode/compose.ts`)

**Goal:** turn the OpenAI `messages[]` into the single prompt string for `opencode run`, per the prompt-embed lock (§4).

**Steps:**
1. Map roles: `system`/`developer`/`user` → natural language labels (don't send raw `role:` tokens the model doesn't understand); `assistant`/`tool` → attributed quotes with role tags.
2. Compose:
   ```
   You are an expert assistant. Below is a conversation with a user.
   Reply to the final message. Do not reference that this is a conversation.
   Conversation:
   <role>: <content>
   ...
   Question: <content of LAST message>
   ```
3. Encode as the prompt passed to `runner.runOnce`.

**DoD:** composed string contains every `messages` entry once + the last message after `Question:`.

---

### P5 — OpenAI format layer (`src/lib/openai-format/index.ts`)

**Goal:** translation from `RunResult` → OpenAI-shaped responses and errors.

**Steps:**
1. Types: `CompletionChoice`, `ChatCompletion`, `Usage`, etc. (import from `@openai/sdk` for alignment).
2. `toOpenAIErrorBody(err)`:
   - 400/422 (validation) → `{ error: { message, type: "invalid_request_error", param: null } }`.
   - 404 (unknown model) → `{ error: { message, type: "server_error", code: "opencode_error", param: null } }`.
   - Upstream opencode error → `{ error: { message, type: "server_error", code: "opencode_error" } }`.
3. `buildCompletion(result, model)`:
   - `id: "chatcmpl-" + uuid4`, `object: "chat.completion"`, `created: Date.now()`, `model`,
   - `choices[0]: { index: 0, message: { role: "assistant", content }, finish_reason }`,
   - `usage: { prompt_tokens, completion_tokens, total_tokens }` (or omit if null).
4. SSE helper: `data: <json>\n\n` + final `data: [DONE]\n\n`. **One chunk per step** (limitation, §3.4).

**DoD:** `buildCompletion` output matches OpenAI `chat.completion` fields; `toOpenAIErrorBody` maps the four status classes correctly.

---

### P6 — Routes

**`src/routes/models.ts`**
1. `GET /v1/models` → 200 `listModels()`.

**`src/routes/chat.ts`** — `POST /v1/chat/completions`
1. Validate body (Fastify schema): `model` (string, required), `messages` (array, min 1), optional `temperature`/`max_tokens`/`stream`. Reject → **400**.
2. `resolveModel(model)` → **404** if unknown (free-list gate).
3. Compose prompt (P4) with history + last message as question.
4. **Non-stream** (`stream` falsy): `runOnce(prompt)` → 200 `buildCompletion(result, model)`; set optional header `x-opencode-session-id`.
5. **Stream** (`stream: true`): `runOnce(prompt)` → emit ONE SSE event with the full step delta, then `[DONE]`; close socket. Set `Content-Type: text/event-stream`.
6. Errors → 500 via `toOpenAIErrorBody` (never leak raw opencode internals).

**DoD:** 
- `curl -s` chat → 200 + assistant content. 
- Body missing `messages` → 400. `model: "gpt-4"` → 404. Stream variant ends with `[DONE]`.

---

### P7 — Server (`src/server.ts`)

**Goal:** Fastify host wiring routes + global error mapping.

**Steps:**
1. `Fastify({ logger, ajv })`, `app.register(routes.models)`, `app.register(routes.chat)`.
2. Global `setErrorHandler` mapping Fastify error → `toOpenAIErrorBody` (400/404/500 shapes).
3. `listen({ port, host })` from `.env`.

**DoD:** `npm run dev` boots; `GET /v1/models` returns data.

---

### P8 — Packaging & docs

**Goal:** a Docker-ready repo a user can run in 3 minutes.
1. `README.md` — overview, requirements, `docker compose up`, curl + SDK (openai-node / LangChain) config, and the honest limitations (no token streaming, no cross-turn recall, temp via anchor v2 only).
2. Verify `OPENCODE_BIN`/network path works inside the container.

**DoD:** `docker compose up --build` → container healthy → all endpoints exercised via curl.

---

### P9 — Verification & edge cases

**Goal:** prove robustness and document the rest.
- Long history via stdin (no argv overflow).
- `tool_use` events present but ignored in `content`.
- Model genuinely errors → 500 (upstream), not a crash.
- Missing binary (`opencode`) → clean error, not a stack trace.
- `stream:true` with an error mid-step.
- Parse resilience: a single malformed JSON line doesn't abort the stream.

**DoD:** every case yields the intended status/body; limitations explicitly listed in README.

---

## 3. Critical path & parallelism

```
P1 (scaffold) ──► P2 (config) ──► P3 (runner, ⚠ spike first) ─┐
                                                            ├──► P5 (format) ──► P6 (routes) ──► P7 (server) ──► P8 ──► P9
                                                          (P4/P5 can run parallel to P3; P4 feeds P3)
```
- **Spikes must precede P3/P4** (stdin input, error shape) — they gate the technically riskiest code.
- **Parallelizable early:** P1 ↔ P2 ↔ P3-adapter contract ↔ P4 ↔ P5, since interfaces are frozen in §4/§7.

---

## 4. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| CLI reads prompt only from argv (not stdin) | High | **Spike P3** to confirm stdin/`--stdin` before coding; isolate in `runner.ts` so a CLI change is a local swap |
| Free models / `models.dev` availability (Herency rules) | Medium | Curated allowlist at wrapper (P2); verify container network to `models.dev`; document that free tiers may change |
| Event schema drift across `opencode` versions | Medium | Pin `opencode` version in Docker; keep parser behind `runner.ts` |
| SSE not token-level (one chunk per step) | Certain | Document as known limitation; token anchoring for temp is v2-only |
| Long-history argv overflow | High | Stdin input (verify spike); never build the prompt as a single argv |
| Secret leakage (opencode internals in error) | Low | All errors through `toOpenAIErrorBody` |

---

## 5. Open questions (to confirm before/during implementation)

- **Free model set stability:** does `models.dev` keep the `-free` tiers (§3.3)? Re-validate before shipping.
- **CLI stdin confirmed?** (spike gap in §3 — prompt was always argv there.)
- **Auth in container:** does `opencode run` need OpenCode auth/creds, and where does the container's PATH/source come from (Docker env, `npx` fetch)?
- **Variant/temperature strategy:** keep non-exposed (MVP), anchor-in-prompt is v2 — confirm scope boundary.
- **`docs/plan.md` §12 (handoffs):** referenced as "read before implementation" but not visible in the current file — surface its confirmations (user, billing/security, in-flight work).

---

## 6. Quick verification commands

```bash
# Models
curl -s http://localhost:3000/v1/models

# Chat (non-stream)
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Olá, quem é você?"}],"stream":false}'

# Chat (stream) — include -i to see headers + SSE
curl -si http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Traduza para o inglês."}],"stream":true}'

# Errors
curl -s -i http://localhost:3000/v1/chat/completions -H 'content-type: application/json' -d '{"model":"gpt-4"}'   # → 404
```

---

*Prepared from `docs/plan.md`. Architecture decisions locked in §4 of that doc are treated as non-negotiable unless the user opts to reopen them.*
