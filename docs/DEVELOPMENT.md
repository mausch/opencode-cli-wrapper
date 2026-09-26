# OpenCode OpenAI-Compatible API

An OpenAI-compatible HTTP API (`/v1/models`, `/v1/chat/completions`, SSE) that proxies models
reported by the OpenCode CLI. Each chat request is executed by spawning:

```
opencode run --format json -m <provider/model>
```

with the whole conversation injected as a single prompt ("prompt-embed").

> Design rationale and spike evidence: [`docs/plan.md`](docs/plan.md).
> Ordered build plan: [`.omo/plans/opencode-openai-api.md`](.omo/plans/opencode-openai-api.md).

## Why the CLI (and not the OpenCode HTTP endpoint)

The OpenCode HTTP endpoint only unlocks free models for OpenCode Herency users. The
**CLI** runs open-weight free models for anyone, so the wrapper shells out to it.

## Requirements

- Node.js >= 22 (Docker image uses `node:22-alpine`)
- The `opencode` CLI on `PATH` (pinned to `1.18.31` in Docker)

## Quick start (Docker)

```bash
docker compose up --build
```

The API is then available at `http://localhost:3000`.

### Docker: OpenCode credentials

`docker compose` already mounts the host's OpenCode CLI state so the container can reach the
free models:

- `${HOME}/.config/opencode` and `${HOME}/.cache/opencode` are mounted read-only.
- `${HOME}/.local/share/opencode/auth.json` is mounted read-only.
- OpenCode's writable state lives in the named volumes `opencode-data` / `opencode-state`, so
  your host database is never modified.

The service runs as `root` so it can write those named volumes. This assumes you have run
`opencode` on the host at least once so the config and `auth.json` exist; otherwise
`/v1/models`, validation and error mapping still work but `opencode run` fails upstream.

## Quick start (local)

```bash
npm install
cp .env.example .env
npm run dev        # or: npm run build && npm start
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_BIN` | `opencode` | Path/command of the OpenCode binary |
| `OPENCODE_TIMEOUT_MS` | `120000` | Per-request timeout for a single `opencode run` |
| `OPENCODE_MODELS_TTL_MS` | `300000` | How long to cache the discovered model catalog |
| `OPENCODE_MODELS_TIMEOUT_MS` | `30000` | Timeout for the `opencode models` catalog command |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | HTTP bind address |

## Usage

### List models

`GET /v1/models` runs `opencode models` and discovers the available catalog. Without an
`Authorization` header, the API returns only model ids ending in `-free`. When the request
includes an `Authorization` header, it returns all models reported by the CLI.

```bash
curl -s http://localhost:3000/v1/models
```

```json
{ "object": "list", "data": [{ "id": "mimo-v2.6-flash-free", "object": "model", "owned_by": "opencode" }] }
```

For authenticated requests, the API passes the header value to the spawned `opencode` process
as `OPENCODE_API_KEY`. It strips a leading `Bearer ` prefix and adds the key without changing
the host's `auth.json`.

```bash
curl -s http://localhost:3000/v1/models \
  -H 'Authorization: Bearer your-api-key'
```

### Chat completion

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek/deepseek-flash","messages":[{"role":"user","content":"Olá, quem é você?"}]}'
```

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1790375466,
  "model": "deepseek/deepseek-flash",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 32921, "completion_tokens": 9, "total_tokens": 32930 }
}
```

### Streaming

```bash
curl -sN http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek/deepseek-flash","messages":[{"role":"user","content":"Olá"}],"stream":true}'
```

Returns `text/event-stream` (`chat.completion.chunk` frames) terminated by `data: [DONE]`.

### OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: "not-needed" });

const completion = await client.chat.completions.create({
  model: "deepseek/deepseek-flash",
  messages: [{ role: "user", content: "Olá, quem é você?" }],
});
```

## Errors

| Situation | Status | `error.type` / `error.code` |
|---|---|---|
| Invalid body | `400` | `invalid_request_error` |
| Model not in the visible model catalog | `404` | `server_error` / `opencode_error` |
| Upstream/model error | `500` | `server_error` / `opencode_error` |

## Known limitations (by design)

- **No token-level streaming.** `opencode run --format json` emits a single `text` event per
  step, so SSE delivers the whole step as one chunk.
- **No cross-turn recall.** OpenCode sessions do not remember previous turns, so the entire
  `messages[]` history is embedded into one prompt on every request.
- **`temperature` / `max_tokens` are soft-anchored** into the prompt (the CLI exposes no such
  flags), so they act as hints, not guarantees.
- **Model availability may change.** The API discovers models from `opencode models` and limits
  unauthenticated requests to ids ending in `-free`.
- **No authentication.** Bind to a trusted network or add your own auth proxy.
- **Docker needs the host's OpenCode credentials.** `docker compose` mounts your host OpenCode
  config/cache/auth (read-only) and keeps writable state in named volumes. If the host has never
  run `opencode`, `opencode run` fails upstream while `/v1/models`, validation and error mapping
  still work.

## Development

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest, offline-safe
INTEGRATION=1 npm test   # also runs real `opencode` calls
npm run build       # emits dist/
```

## Architecture

```
src/
  config/index.ts              # binary resolution, catalog filtering, listModels/resolveModel
  lib/opencode/runner.ts       # spawn + NDJSON event reducer -> RunResult
  lib/opencode/compose.ts      # messages[] -> single prompt (prompt-embed)
  lib/openai-format/index.ts   # buildCompletion / SSE / toOpenAIErrorBody
  routes/models.ts             # GET /v1/models
  routes/chat.ts               # POST /v1/chat/completions
  server.ts                    # Fastify wiring + global error mapping
```
