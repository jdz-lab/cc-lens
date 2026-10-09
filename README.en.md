# cc-lens

> Add the Claude Code client fingerprint to any Anthropic / OpenAI compatible client, forward to your AI relay platform, with a built-in request dashboard. **Zero dependency, single command.**

English | [简体中文](./README.md)

## What is this

Many AI relay platforms (new-api / one-api and derivatives) fingerprint incoming requests and **only allow requests from the Claude Code client**. If you want to spend your relay quota from Qoder, Cline, Cherry Studio or any other tool, you are out of luck.

cc-lens is a lightweight local proxy that does two things:

1. **Fingerprint rewriting** — adds the 5 client traits of real Claude Code traffic to your requests before forwarding them (traits obtained by analyzing real Claude Code traffic)
2. **Request observability** — a built-in web dashboard showing which app sent what, when, to which model, and how many tokens

Supported client formats:

- **Anthropic native** (`/v1/messages`): Qoder, Cline, Roo Code, Continue, Claude Code itself…
- **OpenAI compatible** (`/v1/chat/completions`): converted to Anthropic format on the way in, responses (including streaming SSE) converted back — works with Cherry Studio, Chatbox, Open WebUI, script SDKs, etc.

## Quick start

Requires Node.js ≥ 18. No npm dependencies.

```bash
git clone https://github.com/<your-username>/cc-lens.git
cd cc-lens
node cc-lens.js --upstream https://your-relay-address
```

Once started:

- Dashboard: `http://127.0.0.1:8787/`
- Point your client's API base URL to `http://127.0.0.1:8787` (OpenAI-compatible clients: `http://127.0.0.1:8787/v1`)
- Use your relay API token as the key — cc-lens passes it through untouched

| Option | Env var | Default | Description |
|--------|---------|---------|-------------|
| `--upstream` | `CCLENS_UPSTREAM` | (required) | Relay platform base URL |
| `--port` | `CCLENS_PORT` | `8787` | Listen port |
| `--data-dir` | `CCLENS_DATA` | `./data` | Request log directory |

## Dashboard

![Dashboard](docs/dashboard.png)

- Stat cards: today's requests, success rate, token usage, active apps
- Per-app distribution and a 24h request timeline
- Live request table: time, source app, model, status, latency, tokens, masked key; expandable UA & error details
- Pushed in real time via SSE, persisted to `data/requests.jsonl`

## What it injects

For every `/v1/messages` request, cc-lens adds 5 traits of the real Claude Code client:

| # | Where | What |
|---|-------|------|
| 1 | Header `User-Agent` | `claude-cli/x.x.x (external, cli)` |
| 2 | Header `x-app` | `cli` |
| 3 | Header `anthropic-beta` | adds `claude-code-20250219` |
| 4 | Body `system[0]` | `x-anthropic-billing-header: ...` block |
| 5 | Body `metadata.user_id` | JSON string with device_id / session_id |

When a platform upgrades its detection, usually only the constants at the top of `lib/fingerprint.js` need updating.

## Privacy & Security

- cc-lens runs entirely locally; request content never touches any third party
- API keys are masked in records and dashboard (first 6 + last 4 chars); request bodies are never persisted
- Do not expose the dashboard port to the public internet

## Disclaimer

This project is for personal use and learning on relay platforms you are authorized to use. Read and follow your platform's terms of service; the user is responsible for any account consequences.

## License

[MIT](./LICENSE)
