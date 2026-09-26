# 🌐 Execution Plan — Proxies outbound para a chamada `opencode`

> Worktree isolada: `/Users/medeiroshudson/Documents/Development/opencode-openai-proxy` (branch `feat/outbound-proxy`).
> Base: `main @ 78c3397`. Escopo aprovado pelo usuário: **camada fina + testes + docs**.
>
> Objetivo: permitir que o tráfego outbound do `opencode run` (spawnado por esta wrapper) trafegue por proxy HTTP/HTTPS de forma **explícita, configurável, testável e documentada** — sem depender implicitamente de `process.env` e sem alterar o binário do opencode.

---

## 1. 🎯 Objetivo e não-objetivos

### Objetivo
1. Expor configuração explícita de proxy na wrapper (`OPENCODE_PROXY_URL`, `OPENCODE_NO_PROXY`, além de passthrough de `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`).
2. Garantir que essas variáveis sejam **efetivamente propagadas** ao processo filho `opencode` (hoje o `env` passado a `runOnce()` não chega ao `spawn`).
3. Default seguro de `NO_PROXY` para loopback (`localhost,127.0.0.1,::1`).
4. Cobrir com testes unitários (offline) + um teste de integração que prova a propagação.
5. Suportar proxy no Docker (passthrough via `docker compose`).
6. Documentar no `README.md` e `.env.example`.

### Não-objetivos (explícitos)
- ❌ Não modificar o opencode nem recompilar o binário.
- ❌ Não implementar proxy via **arquivo de config** do opencode (`opencode.json` → `proxy`): o PR upstream #10856 está **fechado e não mergeado**; não é confiável hoje.
- ❌ Não suportar SOCKS5 (limitação do runtime Bun 1.3.14 embutido no opencode).
- ❌ Não adicionar TLS/CA de primeira classe (`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`) — passthrough implícito via `process.env` já cobre; feature completa ficou para escopo C (não escolhido).
- ❌ Não adicionar autenticação na própria wrapper.

---

## 2. 🔬 Evidência de verificação (a crença do usuário é VERDADEIRA)

Verificado contra o binário real **`opencode 1.18.31` / Bun `1.3.14`** — exatamente a versão pinada no `Dockerfile`.

### 2.1 Prova empírica (execução real)
| Cenário | Comando (resumo) | Resultado | Tempo |
|---|---|---|---|
| Controle (sem proxy) | `env -u *_PROXY opencode run --format json -m opencode/mimo-v2.6-flash-free "PONG"` | ✅ `PONG` | 9s |
| Proxy morto | `HTTPS_PROXY=http://127.0.0.1:1 HTTP_PROXY=... opencode run ...` | ❌ `{"type":"error",...,"Cannot connect to API: Unable to connect",...,"url":"https://opencode.ai/zen/v1/chat/completions"}` | 65s |
| Proxy morto + bypass | `HTTPS_PROXY=http://127.0.0.1:1 NO_PROXY=opencode.ai,.opencode.ai opencode run ...` | ✅ `PONG` (bypass honrado) | 7s |

**Conclusão:** o opencode honra `HTTP_PROXY`/`HTTPS_PROXY` **e** `NO_PROXY` no tráfego outbound.

### 2.2 Prova no binário (strings)
`/opt/homebrew/Cellar/opencode/1.18.31/bin/opencode` (138 MB, Mach-O arm64) contém:
- `HTTP_PROXY` (11) / `http_proxy` (12), `HTTPS_PROXY` (9) / `https_proxy` (12), `ALL_PROXY` (1) / `all_proxy` (1), `NO_PROXY` (9) / `no_proxy` (11).
- Lógica de bypass: `process.env.NO_PROXY ?? process.env.no_proxy` e `no_proxy || env.NO_PROXY`, `Config(proxyUrl, keepAlive, env.no_proxy || env.NO_PROXY)`, `fetchOptions.proxy`.
- TLS/CA: `NODE_EXTRA_CA_CERTS` (2), `SSL_CERT_FILE` (1), `SSL_CERT_DIR` (1), `NODE_TLS_REJECT_UNAUTHORIZED` (6).

### 2.3 Prova upstream (sst/opencode)
- `packages/opencode/src/util/proxy-env.ts`: `const proxy = env(`${protocol}_proxy`) || env("all_proxy")`; `env()` lê minúsculo **e** maiúsculo.
- `packages/opencode/src/util/proxied.ts`: `process.env.HTTP_PROXY || process.env.HTTPS_PROXY || ...`.
- `packages/opencode/src/plugin/openai/ws.ts`: usa `ProxyEnv.getProxyForUrl` (WebSocket precisa de proxy explícito no Bun).
- Docs `network` (opencode.ai/docs/network): "OpenCode respects standard proxy environment variables" + `NODE_EXTRA_CA_CERTS`.
- **Ressalva:** PR #10856 (proxy via `opencode.json` + `proxyFetch`) → `state: closed`, `merged: false`.

### 2.4 Estado atual da wrapper (gaps reais)
- `src/lib/opencode/runner.ts:150` → `spawn(bin, args, { shell:false, stdio:[...] })` **sem `env`**: herda `process.env` (por isso proxy "funciona por acidente" quando a env do host está setada), mas o parâmetro `env` de `runOnce()` **não é repassado** — logo não há como injetar proxy vindo da config da wrapper nem testar de forma determinística.
- `src/config/index.ts` → nenhuma noção de proxy.
- `docker-compose.yml` → `environment:` sem passthrough de proxy.
- A wrapper **não faz HTTP outbound próprio** (`openai` não é importado em `src/`; grep vazio). O único tráfego outbound é o `opencode run`.

---

## 3. 🧩 Design (decisões lock)

### 3.1 Contrato de configuração (variáveis)

| Variável | Obrigatória | Default | Semântica |
|---|---|---|---|
| `OPENCODE_PROXY_URL` | não | — | URL de proxy única aplicada a **HTTP e HTTPS**. Conveniência que expande para `HTTP_PROXY` + `HTTPS_PROXY`. **Precedência máxima.** |
| `HTTP_PROXY` / `https_proxy` | não | — | Passthrough nativo (ambos os casos lidos pelo opencode). Normalizados para `HTTP_PROXY`. |
| `HTTPS_PROXY` / `https_proxy` | não | — | Passthrough nativo. Normalizado para `HTTPS_PROXY`. |
| `ALL_PROXY` / `all_proxy` | não | — | Fallback quando não há proxy específico por esquema. Normalizado para `ALL_PROXY`. |
| `OPENCODE_NO_PROXY` | não | — | Lista de bypass (comma). **Precedência sobre `NO_PROXY`.** |
| `NO_PROXY` / `no_proxy` | não | `localhost,127.0.0.1,::1` | Quando ausente, aplica o default de loopback (protege o healthcheck local e chamadas locais). |
| `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `SSL_CERT_DIR` | não | — | Passam por herança de `process.env` (fora do escopo de config explícita). |

**Regras de precedência:**
1. `OPENCODE_PROXY_URL` (se presente e não-vazio) → força `HTTP_PROXY` **e** `HTTPS_PROXY` para o mesmo valor; ignora passthrough de esquema.
2. Senão, faz passthrough de cada um dos `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (primeiro valor não-vazio entre minúsculo/maiúsculo).
3. NO_PROXY: `OPENCODE_NO_PROXY` → `NO_PROXY`/`no_proxy` → default `localhost,127.0.0.1,::1`. **Chave presente-e-vazia é respeitada** (permite desligar o bypass: `NO_PROXY=""`), diferente de ausente.
4. Nunca logar credenciais (`user:pass@`) — log mascarado.

### 3.2 Onde a configuração vira ambiente do filho
- `resolveProxyEnv(env)` → **função pura** que retorna **apenas** as chaves de proxy normalizadas (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) presentes na config. Testável sem spawn.
- `buildChildEnv(configEnv, baseEnv = process.env)` → `{ ...baseEnv, ...resolveProxyEnv(configEnv) }`.
  - Herda PATH/HOME/auth/CAs de `baseEnv` (essencial: `HOME`/auth do opencode).
  - Sobrepõe proxy vindo da config.
  - **Compatibilidade:** `runOnce(params, {})` (teste de integração atual) → `buildChildEnv({}, process.env)` = `process.env` sem chaves de proxy → continua funcionando.

### 3.3 Runner
`runOnce` passa a usar `buildChildEnv(env)` no `spawn`. `resolveOpencodeBin(env)`/`getTimeoutMs(env)` inalterados (seguem lendo `env`).

---

## 4. 🗂 Mudanças por arquivo (exaustivo)

### 4.1 `src/config/index.ts` (adicionar)
```ts
const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;

function firstValue(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = env[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Pure: env de config -> chaves de proxy normalizadas (só o que deve ser setado). */
export function resolveProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};

  const single = firstValue(env, "OPENCODE_PROXY_URL");
  if (single) {
    out.HTTP_PROXY = single;
    out.HTTPS_PROXY = single;
  } else {
    const http = firstValue(env, "HTTP_PROXY", "http_proxy");
    const https = firstValue(env, "HTTPS_PROXY", "https_proxy");
    const all = firstValue(env, "ALL_PROXY", "all_proxy");
    if (http) out.HTTP_PROXY = http;
    if (https) out.HTTPS_PROXY = https;
    if (all) out.ALL_PROXY = all;
  }

  // NO_PROXY: presença da chave (mesmo vazia) tem precedência sobre o default.
  if ("OPENCODE_NO_PROXY" in env && typeof env.OPENCODE_NO_PROXY === "string") {
    out.NO_PROXY = env.OPENCODE_NO_PROXY;
  } else if ("NO_PROXY" in env && typeof env.NO_PROXY === "string") {
    out.NO_PROXY = env.NO_PROXY;
  } else if ("no_proxy" in env && typeof env.no_proxy === "string") {
    out.NO_PROXY = env.no_proxy;
  } else {
    out.NO_PROXY = LOOPBACK_NO_PROXY;
  }

  return out;
}

/** Pure: ambiente do processo filho `opencode`. */
export function buildChildEnv(
  configEnv: NodeJS.ProcessEnv = process.env,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...baseEnv, ...resolveProxyEnv(configEnv) };
}

/** Observabilidade: config efetiva com credenciais mascaradas (para log de boot). */
export function describeProxyEnv(env: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolveProxyEnv(env);
  const mask = (u: string) => u.replace(/\/\/[^@/]+@/, "//***@");
  return PROXY_KEYS.map((k) => (resolved[k] ? `${k}=${mask(resolved[k])}` : null))
    .filter(Boolean)
    .join(" ");
}
```
> `PROXY_KEYS` usado apenas em `describeProxyEnv`.

### 4.2 `src/lib/opencode/runner.ts` (alterar)
- Import: `import { buildChildEnv, getTimeoutMs, resolveOpencodeBin } from "../../config/index.js";`
- Linha ~150: `spawn(bin, args, { shell: false, stdio: ["pipe","pipe","pipe"], env: buildChildEnv(env) })`.
- Nenhuma outra mudança no reducer/eventos.

### 4.3 `.env.example` (adicionar bloco)
```dotenv
# --- Outbound proxy (opencode CLI) ---------------------------------------
# O binário opencode (Bun) honra variáveis de proxy HTTP/HTTPS nativas.
# OPENCODE_PROXY_URL aplica a mesma URL a HTTP e HTTPS (conveniência).
# OPENCODE_PROXY_URL=http://proxy.corp:8080
#
# Ou passe as variáveis nativas diretamente:
# HTTP_PROXY=http://proxy.corp:8080
# HTTPS_PROXY=http://proxy.corp:8080
# ALL_PROXY=http://proxy.corp:8080
#
# Bypass. Se ausente, o default é "localhost,127.0.0.1,::1".
# OPENCODE_NO_PROXY=localhost,127.0.0.1,::1,.interno.corp
#
# TLS/CA (passthrough por herança de ambiente):
# NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-ca.pem
```

### 4.4 `docker-compose.yml` (alterar)
```yaml
    environment:
      PORT: "3000"
      HOST: "0.0.0.0"
      HOME: "/home/node"
      OPENCODE_BIN: "opencode"
      OPENCODE_PROXY_URL: "${OPENCODE_PROXY_URL:-}"
      HTTP_PROXY: "${HTTP_PROXY:-}"
      HTTPS_PROXY: "${HTTPS_PROXY:-}"
      ALL_PROXY: "${ALL_PROXY:-}"
      NO_PROXY: "${NO_PROXY:-localhost,127.0.0.1,::1}"
      NODE_EXTRA_CA_CERTS: "${NODE_EXTRA_CA_CERTS:-}"
    extra_hosts:
      # Permite alcançar um proxy rodando no host (Linux; no Docker Desktop já existe host.docker.internal)
      - "host.docker.internal:host-gateway"
```
> `docker-compose` interpola `${VAR}` da env do host e do arquivo `.env` do projeto.

### 4.5 `Dockerfile` (sem mudança funcional)
- Nenhuma alteração obrigatória. (O proxy é runtime.)

### 4.6 `README.md` (adicionar seção "Outbound proxy")
Conteúdo mínimo:
- O opencode já suporta proxy nativo (evidência resumida).
- Tabela de variáveis da wrapper (§3.1).
- Exemplo local: `OPENCODE_PROXY_URL=http://127.0.0.1:8080 npm run dev`.
- Exemplo Docker com proxy no host: `OPENCODE_PROXY_URL=http://host.docker.internal:8080 docker compose up`.
- Limitações: SOCKS5 não suportado (Bun); proxy via `opencode.json` indisponível (PR #10856 não mergeado).

### 4.7 `tests/config.test.ts` (adicionar `describe("resolveProxyEnv")`)
- `OPENCODE_PROXY_URL` → expande para `HTTP_PROXY` e `HTTPS_PROXY`, sem `ALL_PROXY`.
- Passthrough de `HTTPS_PROXY`/`https_proxy` (minúsculo) → normaliza para `HTTPS_PROXY`.
- `ALL_PROXY` como fallback.
- NO_PROXY default quando ausente = `localhost,127.0.0.1,::1`.
- `NO_PROXY=""` explícito → mantém vazio (respeita).
- `OPENCODE_NO_PROXY` sobrepõe `NO_PROXY`.
- Env vazia/sem proxy → retorno contém apenas `NO_PROXY` default.
- `describeProxyEnv` mascara credenciais (`http://user:pass@h` → `http://***@h`).

### 4.8 `tests/runner.test.ts` (adicionar)
- Unit: `buildChildEnv({ OPENCODE_PROXY_URL: "http://p:8080" }, { PATH: "/bin" })` → contém `HTTP_PROXY`/`HTTPS_PROXY` e `PATH`.
- Integração (gated `INTEGRATION=1`):
```ts
itIntegration("propaga proxy ao filho (proxy morto => erro de conexão)", async () => {
  const res = await runOnce(
    { model: "deepseek/deepseek-flash", prompt: "ok", timeoutMs: 90_000 },
    { ...process.env, OPENCODE_PROXY_URL: "http://127.0.0.1:1", NO_PROXY: "" },
  );
  expect(res.error).toMatch(/connect|Unable to connect|proxy/i);
}, 120_000);
```

---

## 5. 📋 Work breakdown (ordenado)

| # | Fase | Arquivos | Esforço | DoD |
|---|---|---|---|---|
| P1 | Config | `src/config/index.ts` | 🟨 | `resolveProxyEnv`/`buildChildEnv`/`describeProxyEnv` + testes unit verdes |
| P2 | Runner | `src/lib/opencode/runner.ts` | 🟨 | `spawn` recebe `env`; testes existentes verdes |
| P3 | Docker/env | `docker-compose.yml`, `.env.example` | 🟩 | Compose resolve; env documentada |
| P4 | Testes | `tests/config.test.ts`, `tests/runner.test.ts` | 🟨 | Unit 100% offline verde; integração proxy verde |
| P5 | Docs | `README.md` | 🟩 | Seção de proxy + limitações |

**Paralelização:** P1 → P2 (P2 depende de `buildChildEnv`); P3 e P5 em paralelo com P1/P2; P4 após P1/P2.

---

## 6. ✅ Definition of Done (aceitação)

- [ ] `npm run typecheck` limpo.
- [ ] `npm test` verde (offline, sem rede).
- [ ] `INTEGRATION=1 npm test` verde, incluindo o teste de propagação com proxy morto (erro de conexão).
- [ ] Manual: `OPENCODE_PROXY_URL=http://127.0.0.1:1 npm run dev` + `curl /v1/chat/completions` → **500** `{error:{code:"opencode_error"}}`; sem a var → **200**.
- [ ] Boot log mostra `describeProxyEnv()` com credenciais mascaradas (se proxy configurado).
- [ ] `docker compose up` com `OPENCODE_PROXY_URL` do host propaga o proxy ao container.
- [ ] `README.md` + `.env.example` documentam variáveis, precedência, default de `NO_PROXY` e limitações.
- [ ] Nenhuma menção a segredos de proxy em logs/erros.

---

## 7. 🧪 Comandos de verificação

```bash
# na worktree
npm ci
npm run typecheck
npm test
INTEGRATION=1 npx vitest run -t "propaga proxy"

# manual (proxy morto deve falhar; sem proxy deve funcionar)
OPENCODE_PROXY_URL=http://127.0.0.1:1 npm run dev &
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek/deepseek-flash","messages":[{"role":"user","content":"PONG"}]}'
```

---

## 8. ⚠️ Riscos & mitigações

| Risco | Prob. | Mitigação |
|---|---|---|
| Proxy do Bun é version-specific (CONNECT/HTTP) | Média | Fixar `opencode 1.18.31` (já pinado); teste de integração com proxy morto como contrato de propagação |
| SOCKS5 não suportado pelo Bun | Alta | Documentar explicitamente; sugerir conversor HTTP→SOCKS |
| `NO_PROXY` default loopback surpreender quem quer proxiar tudo | Baixa | Documentado + override via `NO_PROXY=""` ou `OPENCODE_NO_PROXY` |
| Alterar `spawn` com `env` quebrar teste que passa `{}` | Média | `buildChildEnv(config, process.env)` sempre herda `process.env` |
| Vazamento de credenciais do proxy (`user:pass@`) | Baixa | `describeProxyEnv` mascara; erro do opencode não inclui a URL do proxy |
| Proxy do host inacessível de dentro do container | Média | `extra_hosts: host.docker.internal`; documentar gateway no Linux |
| PR upstream #10856 mergear e mudar semântica | Baixa | Sem uso de config-file; só env vars (estável) |

---

## 9. ❓ Em aberto (confirmar na implementação)

- Expor `describeProxyEnv()` no log de boot do `server.ts`? (recomendado; baixo custo)
- Manter `OPENCODE_PROXY_URL` aceitando apenas `http(s)://`? (validação leve de URL — v2)
- Adicionar teste de integração contra um proxy real (mitmproxy) em CI? (opcional; fora do escopo mínimo)
