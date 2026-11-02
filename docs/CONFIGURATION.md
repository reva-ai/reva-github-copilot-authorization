# Configuration

The plugin reads the settings below. Only `REVA_AUTH_TOKEN` is required in practice; the rest
have working defaults, and the last three exist for tests and for the plugin's own detached
child process rather than for you to set.

Set `auth_token` in the `env` block of `~/.copilot/settings.json`. Copilot does not pass that block
to hooks, so the plugin reads the file itself, and the same settings apply in the Copilot
CLI, the desktop app and VS Code Copilot Chat. A plain `REVA_*` environment variable **takes priority** when
both are present, which is what makes local development and the mock-RTG workflow possible
without reinstalling.


| Variable | Required | Default | Purpose |
|---|---|---|---|
| `REVA_AUTH_TOKEN` | **yes** | — | Authenticates every request: RTG evaluation and session-start ingestion. |
| `REVA_AGENT_ID` | **conditionally** | your Copilot account id | The agent's Cedar identity. Resolved automatically from your Copilot sign-in. **Required explicitly when it cannot be resolved** — see below. |
| `REVA_HOST` | no | `api.reva.ai` | Your Reva tenant's API host. |
| `REVA_USER_EMAIL` | no | your public GitHub email | The user's identity. Set it when your GitHub email is private — Copilot's sign-in cannot read a private address, and without one the plugin falls back to your OS username. It must be the address your token belongs to. |
| `REVA_DEBUG` | no | off | Set to `1` to log each decision to stderr and append it, timestamped, to `reva-debug.log` in the plugin's data directory (`~/.copilot-governance/` if the host gives the plugin none). |
| `REVA_MODEL_CONTEXT` | no | off | Set to `1` to add the model Copilot ran to every request's context. Enable it only once your Reva schema declares `model`; before that, every request is rejected as a schema violation. |
| `REVA_PDP_TIMEOUT_MS` | no | `25000` | Timeout for an evaluation call. On timeout the plugin fails **closed** — the action is blocked. Environment only. |
| `REVA_INGESTION_TIMEOUT_MS` | no | `5000` | Timeout for session-start ingestion. Deliberately much shorter — ingestion is best-effort and never gates an action. Environment only. |
| `REVA_SESSION_ENTRYPOINT` | no | detected | Names the surface when nothing else identifies it — see [DESKTOP-COMPATIBILITY.md](DESKTOP-COMPATIBILITY.md). Environment only. |
| `REVA_COPILOT_CONFIG_PATH` | no | `~/.copilot/config.json` | Overrides where the plugin reads your Copilot sign-in from. Intended for tests. |
| `REVA_SESSION_CWD` | no | the hook's own cwd | Set by the plugin when it spawns its detached MCP-discovery child. Not intended to be set by hand. |
| `REVA_INVOKED_MCP_SERVER` | no | — | Set by the plugin on that same child to name the MCP server whose invocation triggered the ingestion. Not intended to be set by hand. |

## If your Copilot account id cannot be resolved

Read this section if the plugin cannot work out your agent id.

The plugin derives the agent's identity from your Copilot account, using the sign-in Copilot
already stored: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` when set, otherwise the
OS credential store (Windows Credential Manager, macOS Keychain, or `secret-tool` on Linux).
If none of those is readable, it asks the GitHub CLI (`gh`) instead, but only when `gh` is
signed in as the same account. It looks this up once and saves it, until you sign in as a
different account. If you have never signed in to Copilot on this machine, or the macOS
Keychain prompt was denied, there is no account to read — and the plugin deliberately does
**not** substitute a machine id or a random value, because an invented identity would be
meaningless to a policy.

The result is that the plugin **fails closed and blocks every action** with:

```
Reva governance is not configured — missing: REVA_AGENT_ID (could not resolve the Copilot
account id — run `gh auth login` as the same account Copilot uses, or set REVA_AGENT_ID in
settings.json or the environment)
```

Sign in to Copilot with `/login` (on macOS, allow the Keychain prompt) or run
`gh auth login` as the same account, or set `REVA_AGENT_ID` explicitly to a stable
identifier for this agent and make sure the matching entity exists in your Reva tenant.

## Hosts and transport

`REVA_HOST` accepts a bare host (`api.example.reva.ai`) or one with a scheme, which is
stripped. Trailing slashes are removed. Paths are fixed in code:

- evaluation: `/pdp/v2/ai/evaluation`
- ingestion: `/ingestion/v2`

The scheme is **HTTPS for every host** except `localhost`, `127.0.0.1` and `[::1]`, which
use plain HTTP so a local mock RTG works. This cannot be overridden for a remote host.

## What blocks and what does not

A short version of the table in [SECURITY.md](../SECURITY.md#what-blocks-and-what-does-not):

| Condition | Outcome |
|---|---|
| Policy denies (403) | **blocked** |
| Guardrails return `conditional_allow` | Copilot **asks** you |
| Reva unreachable, times out, or errors (5xx, 404, 424, 429) | **blocked, every action** — fails closed |
| Token rejected (401) | **passes through for the rest of that session** — fails open |
| Payload too large (413) | **passes through** — fails open |
| `REVA_AUTH_TOKEN` or `REVA_AGENT_ID` missing | **blocked, every action** — fails closed |

Governance holds through a Reva-side outage: an unreachable or erroring RTG blocks rather
than silently letting actions through. The exceptions are a rejected token (401), which
passes through for the rest of that session because it usually means a principal that is
not provisioned yet, and an oversized payload (413), which concerns one request only. A
401 latches that session open with no retry; a new session calls the RTG again. A
misconfiguration must never silently permit everything while appearing to govern.

## Policies

Policies are authored and managed in Reva, not here — this plugin only enforces what your
organization has configured. Rules can be scoped to any governed action and to specific
resources, from "no shell commands anywhere" to "file writes only inside this repository".
See your Reva console.
