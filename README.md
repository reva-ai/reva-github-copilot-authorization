# Reva Security for GitHub Copilot

Reva Security checks every action GitHub Copilot's agent takes on your machine against your
organisation's policies in Reva **before it runs**: shell commands, file reads and edits,
searches, MCP tool calls, and sub-agents. Allowed actions run as normal, denied ones are
blocked, and sensitive ones can ask you first. Every decision is recorded in Reva.

It works in the **Copilot CLI**, the **GitHub Copilot desktop app**, and **VS Code Copilot
Chat**.

Plugin `reva-security`, from the `reva-plugins` marketplace.

## Quick start

```bash
copilot plugin marketplace add https://github.com/reva-ai/reva-github-copilot-authorization
copilot plugin install reva-security@reva-plugins
```

Add your Reva token to `~/.copilot/settings.json`:

```json
{
  "env": {
    "REVA_AUTH_TOKEN": "<your Reva token>",
    "REVA_HOST": "<your tenant host, if not api.reva.ai>"
  }
}
```

Start a new `copilot` session and ask it to do something that uses a tool, such as
`list the files in this folder`. The action appears in your Reva decision log.

## What it governs

| Copilot tool | Reva action |
|---|---|
| `bash`, `powershell` | `executeBash`, one check per file or folder the command touches |
| `view` | `read` |
| `create` | `write` |
| `edit` | `edit` |
| `apply_patch` | `write` or `edit` for each file in the patch; deletes count as `write` |
| `glob` | `glob` |
| `grep`, `rg` | `grep` |
| `task` (sub-agents) | `spawn` |
| MCP tools and anything else | `invokeTool` |

Your prompts are evaluated as `invokeAgent`. Every request also tells Reva which surface the
session runs on (`cli`, `ide-<editor>`, `Copilot Desktop`), the model in use, and the chain of
agents that led to the action.

## What blocks, and what doesn't

| Condition | Outcome |
|---|---|
| Policy denies | **blocked** |
| Policy allows with conditions | Copilot **asks** you |
| Reva unreachable, times out or errors | **blocked**, fails closed |
| Token rejected (401) | passes through for the rest of that session |
| Plugin not configured | **blocked, every action** |

Details in [Configuration](docs/CONFIGURATION.md#what-blocks-and-what-does-not).

## Development

```bash
npm install     # also builds dist/
npm test
npm run mock-rtg   # local stand-in for Reva, on localhost:8787
```

The hooks run the compiled files in `dist/src/`, which are committed. Run `npm run build` and
commit `dist/src/` with every source change.

## Documentation

| Page | What it covers |
|---|---|
| [Install](docs/INSTALL.md) | Requirements, install, team rollout (including enterprise managed settings), updating, uninstalling |
| [Desktop compatibility](docs/DESKTOP-COMPATIBILITY.md) | Copilot CLI, the desktop app and VS Code Copilot Chat; the Copilot session target and how VS Code finds the plugin |
| [Configuration](docs/CONFIGURATION.md) | Every setting, where each is read from (`settings.json` or environment), your identity, and what blocks |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | The debug log, common problems, VS Code checks, and known limitations |
| [Security](SECURITY.md) | What is sent and kept, credentials, failure behaviour |
