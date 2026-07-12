# Docmost Keychain MCP proxy

`docmost-keychain-proxy.cjs` lets Codex use the production Docmost MCP without
putting its bearer Token in `config.toml`, a script, or the global login-session
environment.

The proxy reads the `Docmost MCP Codex Canary` / `zeyu.wang` generic password
from macOS Keychain when it starts, validates the remote `tools/list`, then
exposes the same tools to Codex over stdio. Requests are forwarded only to the
fixed `https://docs.wzyonline.com/mcp` endpoint. Redirects are rejected so the
Token cannot be forwarded to another origin.

Register it as a stdio server from the repository root:

```bash
codex mcp remove docmost
codex mcp add docmost -- node "$PWD/ops/mcp/docmost-keychain-proxy.cjs"
```

Restart Codex Desktop after changing MCP registration. Rotating the Token only
requires updating the same Keychain item and restarting the task; no Codex
configuration change is needed.
