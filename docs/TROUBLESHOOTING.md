# Troubleshooting

Start here — in `~/.copilot/settings.json`:

```json
{ "env": { "REVA_DEBUG": "1" } }
```

Start a new session. Every hook then logs the action it mapped, the decision it received and
the reason, to `reva-debug.log` in the plugin's data directory:

```bash
tail -f ~/.copilot/plugin-data/reva-plugins/reva-security/reva-debug.log
```

On Windows: `Get-Content "$env:USERPROFILE\.copilot\plugin-data\reva-plugins\reva-security\reva-debug.log" -Wait`.
If that file never appears, look in `~/.copilot-governance/reva-debug.log`, where the log goes
when the host gives the plugin no data directory. Almost everything below is diagnosable from
that output.

## Every action is blocked

The plugin fails closed on **misconfiguration**, and also when Reva cannot give an answer.
Three causes, in order of likelihood:

**`REVA_AUTH_TOKEN` is not set.** With debug on you will see
`Reva governance is not configured — missing: REVA_AUTH_TOKEN`. Add it to
`~/.copilot/settings.json` — see [INSTALL.md](INSTALL.md#individual-install).

**`REVA_AGENT_ID` cannot be resolved.** You will see
`missing: REVA_AGENT_ID (could not resolve the Copilot account id …)`. This affects anyone
not signed in to Copilot on this machine, or who denied the macOS Keychain prompt. Sign in
with `/login` or run `gh auth login` as the same account, or set `REVA_AGENT_ID`
explicitly — see
[CONFIGURATION.md](CONFIGURATION.md#if-your-copilot-account-id-cannot-be-resolved).

**Your policy genuinely denies it.** The block reason names the policy decision rather than
a configuration problem. Check the decision log in your Reva console.

## Nothing appears to be governed

The plugin fails **closed** when Reva cannot give an answer, so an outage shows up as
everything being blocked, not as ungoverned work. Two cases still pass through silently: a
rejected token (401), for the rest of that session, and an oversized payload (413). With
`REVA_DEBUG=1`, a pass-through logs a reason such as
`Reva authorization unavailable (UNAUTHORIZED) — failing open for this request`.

Check in this order:

1. **Is `node` on your PATH?** Every hook shells out to it. `node -v` in the same shell
   Copilot launched from.
2. **Is the host right?** `REVA_HOST` defaults to `api.reva.ai`. If your tenant is
   elsewhere, every call fails — and, failing closed, every action is blocked.
3. **Is the token still valid, and is the user right?** A 401 fails open by design, and
   latches that session open — RTG is not called again until a new session starts. Check
   the `invokeAgent as …` line in the log: if it shows your OS username or the wrong email
   instead of the address your token belongs to, set `REVA_USER_EMAIL`. Restarting the
   session is how a repaired token or email is picked up.
4. **Did you start a new session?** Configuration is read at session start. In the desktop
   app, restart it; in VS Code, reload the window and start a new chat.
5. **In VS Code, is the plugin loaded at all?** The chat's Session Target must be
   **Copilot**, and the plugin must be one VS Code can find — installed under
   `~/.copilot/installed-plugins/`, not only registered as a local-folder marketplace. Type
   `/hooks` in the chat and check that the five `reva-security` hooks are listed. If no
   new session id appears in `reva-debug.log`, the hooks are not running — see
   [DESKTOP-COMPATIBILITY.md](DESKTOP-COMPATIBILITY.md#which-surfaces-are-governed).

## `dist/src/...js` not found

The hooks execute compiled JavaScript from `dist/src/`, which is committed. If it is
missing, you have a partial checkout or a modified install:

```bash
npm ci && npm run build
```

## Copilot hangs on a tool call

An evaluation call can take up to `REVA_PDP_TIMEOUT_MS` (default 25 s) before the plugin
gives up and blocks the action. The `preToolUse` and `postToolUse` hooks are themselves
capped at 45 s by `hooks/hooks.json`.

If calls are routinely slow, lower `REVA_PDP_TIMEOUT_MS` — you are trading a longer stall
for a sooner block on a slow link. It is read from the process environment only, not from
`settings.json`.

## Session start is slow

Session-start ingestion is best-effort and capped separately at
`REVA_INGESTION_TIMEOUT_MS` (default 5 s). It never blocks a session from starting; a
failure is logged under `REVA_DEBUG=1` and otherwise ignored.

The first session after you sign in to Copilot also looks up your account id once, which
can take a few seconds; later sessions read the saved value. On a brand-new install there
can be a brief window before you are fully provisioned in Reva's directory, during which
policies referencing you may not match as expected.

## A file outside a repository is denied unexpectedly

Resource ids are repository-relative — `my-repo/src/index.ts` — so one policy works on every
machine. When the file is **not** inside a git repository, or lies outside the repository
root, the plugin falls back to the **absolute path**. A policy written against a
repo-relative pattern will not match that, so the action may be denied by a catch-all rule.

## MCP servers are not showing up in Reva

Only **HTTP** MCP servers are registered with their URL. Stdio servers are registered by
name only: their entry has no base URL, and the plugin will not invent one. Their `command`,
`args` and `env` are never read, which is also why credentials in a stdio server's `env`
block never leave your machine.

## Known limitations

- Prompts are evaluated, but Copilot cannot always stop a prompt from a hook — real
  enforcement is on tool calls.
- Shell command targeting is a best-effort heuristic, not a full shell parser. Common
  patterns resolve correctly; unusual constructs fall back to a broader resource than the
  command's actual target.
- A shell command that names more than 10 distinct paths is denied rather than evaluated
  partially — split it into smaller commands. An `apply_patch` whose patch names no file
  is denied too, because its target cannot be authorized.
- Copilot names MCP tools `<server>-<tool>`; these are evaluated as a generic `invokeTool`
  on that tool name, without the MCP server as their parent.
- In VS Code Copilot Chat, tools that only exist in VS Code are evaluated as a generic
  `invokeTool`.
- Directory registration happens in the background at session start and is best-effort.

## Still stuck

Open an issue at
<https://github.com/reva-ai/reva-github-copilot-authorization/issues> with your
`REVA_DEBUG=1` output. **Redact the transmitted content first** — debug output includes
prompt and command text.

For anything security-sensitive, email **info@reva.ai** with "SECURITY" in the subject
rather than opening a public issue.
