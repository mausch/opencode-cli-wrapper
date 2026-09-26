# 📄 HANDOFF — API OpenAI-compatible sobre OpenCode (free models via CLI)

> Documento consolidado do levantamento (spikes) e do detalhamento técnico. Ponto de partida para o desenvolvedor/agente. Leia a **Seção 12** (handoffs) no fim para o que precisa ser confirmado antes/de durante a implementação.

---

## 1. 🎯 Objetivo

Fornecer uma **API HTTP OpenAI-compatible** (`/v1/chat/completions`, `/v1/models`, SSE) que consome os **modelos gratuitos do OpenCode** pela **CLI oficial** (`child_process`), sem depender do endpoint HTTP do OpenCode (que restringe free models aos usuários do Herency).

O cliente usa SDKs OpenAI (openai-node, LangChain, `curl`, etc.) apontando para nossa API. Por baixo, cada requisição vira um `opencode run` com a conversa injetada como prompt.

---

## 2. 🧭 Contexto (por que CLI e não HTTP)

- O endpoint HTTP do OpenCode **só libera free models para o Herency** do OpenCode.
- A **CLI** (`opencode run`) roda free models **open-weight** para qualquer um, via `models.dev`.
- Decisão: **CLI como core** (sem violar a regra do OpenCode). Stack: **Node.js + TypeScript + Fastify + OpenAI SDK (para types/schemas)**. Tudo em **Docker**.

---

## 3. 🔬 Resultado dos spikes (evidências experimentais)

Tudo o abaixo foi verificado localmente com `opencode 1.18.31`. Incluo comando → saída → conclusão para o dev entender o **porquê** de cada decisão.

### 3.1 Interface da CLI
```bash
opencode run [message..]
```
Flags relevantes:
- `-m, --model` — modelo no formato `provider/model` (ex.: `opencode/mimo-v2.6-flash-free`)
- `--format` — `default` (TUI) ou **`json` (raw JSON events)** ← **é nossa fonte de dados**
- `-c, --continue`, `-s, --session` — continuação de sessão (ver §3.4)
- `--variant` — reasoning effort (`high`/`minimal`)

### 3.2 Protocolo de eventos JSON (`--format json`)
Sessão real (free model `mimo-v2.6-flash-free`):
```json
{"type":"step_start","sessionID":"ses_...","part":{"type":"step-start"}}
{"type":"text","part":{"type":"text","text":"oi, tudo bem?","time":{"start":...,"end":...}}}
{"type":"step_finish","reason":"stop","tokens":{"total":32539,"input":32518,"output":7,"reasoning":14,"cache":{"write":0,"read":0}},"cost":0}
```
Eventos observados: `step_start`, `text`, `step_finish`, `tool_use`, `error`.
- **`text`** → conteúdo gerado (`part.text`) ← **resposta**
- **`step_finish`** → `reason` (`stop` / `tool-calls`) e `tokens.*`/`cost`
- **`error`** → `{error:{name,data:{message, ref}}}`
- `sessionID` aparece em **todos** os eventos.

### 3.3 Free models disponíveis (models.dev)
Modelos candidatos (os `-free` são os gratuitos):
```
opencode/mimo-v2.6-flash-free
opencode/space-bunny-free
opencode/nemotron-3-ultra-free
opencode/nemotron-3.5-lightning-free
opencode/ling-3.0-flash-fin-free
opencode/muse-spark-1.3-contributor-free
opencode-go/qwen3.8-flash   (e outros opencode-go/*)
```

### 3.4 Teste 1 — Streaming → **NÃO é token-a-token**
```bash
opencode run --format json -m opencode/mimo-v2.6-flash-free "poema de 8 versos..." 2>&1 | grep -c '"type":"text"'   # → 1
```
**Conclusão:** um único evento `text` por `step`. **Não há streaming por token.** MVP = retorno único; SSE entrega o chunk do step inteiro (limitação conhecida).

### 3.5 Teste 2 — Conversa multi-turn → **o modelo NÃO lembra entre turns**
```bash
opencode run "...Meu nome é Hudson e eu bebo café com leite..."          # → "Prazer, Hudson! ☕"
opencode run -s <SID> "...O que eu gosto de beber?"                      # → "Não sei — não encontrei nada..."
```
**Conclusão:** sessões **não fazem recall** de conversa. **Não usar `--continue`** como mecanismo de histórico.

### 3.6 Teste 3 — Prompt-embed → **VALIDADO** ✅
Ao injetar o histórico na mesma instrução do `run` e pedir texto sem ferramentas:
- O modelo **respondeu em texto**, **usou o contexto** ("café") e terminou com `finish_reason: "stop"`, **sem tool calls**.
- **Decisão lock: design = prompt-embed.**

---

## 4. ✅ Decisões de arquitetura (lock)

| Decisão | Valor | Por quê |
|---|---|---|
| Design | **prompt-embed** (não sessão) | Teste 2: sem recall; Teste 3: funciona |
| Core | `child_process.spawn(opencode run --format json -m <free> "<prompt>")` | CLI roda free models sem Herency |
| Estado | nenhum (a sessão é devolvida só como observabilidade) | sem recall entre turns |
| `messages` OpenAI | histórico todo → injetado como instrução do `run`; **última msg = pergunta** | entrega contexto em um único turno |
| Conteúdo da resposta | concat de **todos** eventos `type:"text"` | agêntico: texto vem após tool rounds |
| Tool events | **ignorados** no conteúdo; só surfaceamos `text` | risco de agenticidade mitigado |
| `finish_reason` | `reason` do **último** `step_finish` | é o que traz o texto final |
| Streaming | **buffer** no MVP; SSE chunk do step inteiro | Teste 1: 1 evento |
|溫度/`temperature`/`max_tokens` | não exposto diretamente na CLI | passar como ancoragem no prompt (v2) |
| Free-only | allowlist curada no `config` | garante "free only" na camada do wrapper |

---

## 5. 📐 Contratos de API (schemas OpenAI-compatible)

### 5.1 `GET /v1/models`
```json
{ "object":"list", "data":[ {"id":"mimo-v2.6-flash-free","object":"model","owned_by":"opencode"} ] }
```

### 5.2 `POST /v1/chat/completions` — não-stream
Request (subconjunto OpenAI):
```json
{
  "model": "mimo-v2.6-flash-free",
  "messages": [{"role":"user","content":"Olá, quem é você?"},
               {"role":"user","content":"e o que bebo?"}],
  "temperature": 0.7,
  "stream": false
}
```
Response:
```json
{
  "id":"chatcmpl-...", "object":"chat.completion", "created": 1712345678,
  "model":"mimo-v2.6-flash-free",
  "choices":[{"index":0,"message":{"role":"assistant","content":"..."},"finish_reason":"stop"}],
  "usage":{"prompt_tokens":N,"completion_tokens":N,"total_tokens":N}
}
```
Header opcional: `x-opencode-session-id`.

### 5.3 `POST /v1/chat/completions` — stream (`stream:true`)
`Content-Type: text/event-stream` (e o mesmo body acima):
```
data: {"id":"chatcmpl-..","object":"chat.completion.chunk","created":1712345678,"model":"mimo-v2.6-flash-free","choices":[{"index":0,"delta":{"content":"..."},"finish_reason":null}]}

data: [DONE]
```

### 5.4 Erros
- Body inválido → `400` `{error:{message,type:"invalid_request_error",param:null}}`
- Erro do OpenCode/modelo não conhecido → `500` (ou `404` se `model` não estiver na free-list) `{error:{message,type:"server_error",code:"opencode_error",param:null}}`

---

## 6. 🗂 Estrutura de pastas
```
src/
  config/index.ts        # OPENCODE_BIN, FREE_MODELS, listModels(), resolveModel()
  lib/
    openai-format/index.ts   # types (da SDK) + toOpenAIErrorBody() + buildCompletion() + SSE
    opencode/
      runner.ts          # spawn + parser dos eventos JSON
      compose.ts         # prompt-embed (histórico → instrução)
  routes/models.ts
  routes/chat.ts
  server.ts
Dockerfile
docker-compose.yml
tsconfig.json
package.json
README.md
.env.example
```

---

## 7. 🧩 Código esperado (esqueleto do núcleo)

**`src/lib/opencode/runner.ts`** — parse e execução:
```ts
import { spawn } from 'node:child_process';

export interface RunParams { model: string; prompt: string; variant?: string; timeoutMs?: number; }
export interface RunResult {
  content: string; chunks: string[]; finish_reason: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  sessionId: string | null; error: string | null; toolCalls: number;
}

function describeError(ev: any): string {
  const e = ev.error ?? {};
  return e.data?.message ?? e.message ?? ev.message ?? 'Unknown error';
}

export function runOnce(params: RunParams): Promise<RunResult> {
  const args = ['run', '--format', 'json', '-m', params.model, params.prompt];
  if (params.variant) args.push('--variant
