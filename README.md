# OpenCode CLI Wrapper

Use OpenCode models through the OpenAI API you already know.

[![GHCR image](https://img.shields.io/badge/GHCR-available-blue?style=flat&logo=docker)](https://github.com/medeiroshudson/opencode-cli-wrapper/pkgs/container/opencode-cli-wrapper)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)

## What is this?

OpenCode CLI Wrapper exposes the models available through the OpenCode CLI as a standard
OpenAI-compatible API. Existing OpenAI clients and tools can connect to it without changes.
Run the API in a container and keep using the models and workflows you already have.

## Features

- OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions` endpoints
- Server-sent events (SSE) for step-by-step streaming
- Works with existing OpenAI SDKs and compatible tools
- Free models available out of the box
- Container-first setup with a published GHCR image

## Quick start

Run the published image. Your host OpenCode files are shared with the container through
read-only mounts, while writable state stays in Docker volumes, so your host setup is never
modified.

```bash
docker run --rm \
  -p 3000:3000 \
  --user root -e HOME=/home/node \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-state:/home/node/.local/state \
  -v "$HOME/.config/opencode:/home/node/.config/opencode:ro" \
  -v "$HOME/.cache/opencode:/home/node/.cache/opencode:ro" \
  -v "$HOME/.local/share/opencode/auth.json:/home/node/.local/share/opencode/auth.json:ro" \
  ghcr.io/medeiroshudson/opencode-cli-wrapper:latest
```

The API is available at `http://localhost:3000`. Run `opencode` on your host at least once so
its configuration and authentication file exist. Without them, listing and validating models
still works, but model requests fail upstream.

## Usage

List available models:

```bash
curl http://localhost:3000/v1/models
```

```json
{
  "object": "list",
  "data": [{ "id": "mimo-v2.6-flash-free", "object": "model", "owned_by": "opencode" }]
}
```

Send a chat completion:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek/deepseek-flash","messages":[{"role":"user","content":"Say hello"}]}'
```

```json
{
  "object": "chat.completion",
  "choices": [{ "message": { "role": "assistant", "content": "Hello!" } }]
}
```

Use the OpenAI SDK by pointing its `baseURL` at the local API:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "not-needed-for-free-models",
});

const response = await client.chat.completions.create({
  model: "deepseek/deepseek-flash",
  messages: [{ role: "user", content: "Say hello" }],
});

console.log(response.choices[0]?.message.content);
```

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `OPENCODE_BIN` | `opencode` | OpenCode CLI command or path |
| `OPENCODE_TIMEOUT_MS` | `120000` | Timeout for a chat request, in milliseconds |
| `OPENCODE_MODELS_TTL_MS` | `300000` | How long to cache the model list, in milliseconds |
| `OPENCODE_MODELS_TIMEOUT_MS` | `30000` | Timeout for reading the model list, in milliseconds |
| `PORT` | `3000` | API port |
| `HOST` | `0.0.0.0` | Address the API listens on |
| `OPENCODE_PROXY_URL` | unset | Apply one proxy URL to both HTTP and HTTPS outbound requests |
| `OPENCODE_NO_PROXY` | loopback addresses | Override the proxy bypass list |

## Outbound proxy

Only the spawned `opencode run` CLI makes outbound requests. The CLI's Bun runtime honors
standard HTTP proxy environment variables natively. The wrapper adds `OPENCODE_PROXY_URL` and
`OPENCODE_NO_PROXY` for simpler configuration.

| Variable | Precedence and behavior |
|---|---|
| `OPENCODE_PROXY_URL` | Highest precedence; sets both `HTTP_PROXY` and `HTTPS_PROXY` to the same URL. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` | Native per-scheme variables; `ALL_PROXY` is the fallback when a scheme-specific proxy is absent. |
| `OPENCODE_NO_PROXY` | Takes precedence over `NO_PROXY`. |
| `NO_PROXY` | Native bypass list; when a proxy is configured it defaults to `localhost,127.0.0.1,::1` so loopback requests stay local. |
| `NODE_EXTRA_CA_CERTS` | Optional Node/Bun extra CA certificate file passed to the CLI. |

For local development, set a single proxy URL:

```bash
OPENCODE_PROXY_URL=http://127.0.0.1:8080 npm run dev
```

For Docker with a proxy running on the host:

```bash
OPENCODE_PROXY_URL=http://host.docker.internal:8080 docker compose up
```

SOCKS5 proxies are not supported by Bun. Proxy configuration through `opencode.json` is also
unavailable; upstream PR #10856 closed without merging, so configure proxies with environment
variables only.

## How it works

For each request, the wrapper translates the API call into an OpenCode CLI run. It passes the
conversation as a single prompt, then returns the CLI's response in the OpenAI format. When
streaming is enabled, SSE delivers the response step by step.

## Requirements

Docker, and an OpenCode CLI login on the host for authenticated models.

## License

MIT. See the [LICENSE](LICENSE) file.
