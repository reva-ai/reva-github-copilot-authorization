# Desktop compatibility: CLI, Desktop app and VS Code Chat

This plugin governs the GitHub Copilot agent wherever it runs on your machine: the Copilot
CLI, the GitHub Copilot desktop app and VS Code Copilot Chat. This page states which
surfaces are governed, how the plugin tells them apart, what happens where it does not run,
and how that is verified.

## Which surfaces are governed

| Surface | Governed | `sessionEntryPoint` |
|---|---|---|
| Copilot CLI in a terminal | yes | `cli` |
| Copilot CLI in an editor's integrated terminal | yes | `ide-<editor>`, e.g. `ide-vscode` |
| GitHub Copilot desktop app | yes | `Copilot Desktop` |
| VS Code Copilot Chat (agent mode, **Copilot** session target) | yes | `ide-vscode` |
| VS Code Chat with the Claude or Codex session target | **no** | — |
| Copilot on github.com and the cloud coding agent | **no** | — |

All governed surfaces use the same installed plugin and the same `~/.copilot/settings.json`.
VS Code Copilot Chat runs the plugin only when the chat's **Session Target** is **Copilot** —
the same runtime and hook format as the CLI.

VS Code finds plugins the Copilot CLI has installed (those under
`~/.copilot/installed-plugins/`), so install from the marketplace as in
[INSTALL.md](INSTALL.md), then reload the VS Code window and start a new chat. A plugin
registered as a local-folder marketplace in `~/.copilot/settings.json` is loaded in place by
the CLI and is not copied there, so VS Code does not see it; for a local checkout, use
**Chat: Install Plugin from Source** or the `chat.pluginLocations` setting instead. Register
the plugin one way only — two copies run every hook twice.

## How the distinction is made

The decision uses **host runtime markers only** — the environment and the process that
started the hook, never tool names, never workspace paths. See
[`src/identity.ts`](../src/identity.ts).

The signals, in this precedence:

1. **The desktop app's own client id.** The app sets `COPILOT_MCP_CIMD_CLIENT_ID_URL` to
   `https://github.com/copilot/desktop/client-metadata.json`, or
   `GITHUB_COPILOT_INTEGRATION_ID` to `copilot-developer-app`. Either one means
   `Copilot Desktop`.
2. **An editor's terminal.** `TERM_PROGRAM=vscode`, `VSCODE_GIT_IPC_HANDLE` or
   `VSCODE_CODE_CACHE_PATH` means `ide-<editor>`. The editor is named from its own user-data
   folder (`Code`, `Code - Insiders`, `Cursor`, `Windsurf`), or `ide` when nothing names it.
3. **An editor that started the hook.** VS Code Copilot Chat puts no editor markers in the
   environment, so the hook's parent processes are checked for a known editor (`Code.exe`,
   `Code - Insiders.exe`, `Cursor.exe`, `Windsurf.exe`, or their macOS and Linux
   equivalents) — `ide-<editor>`. This runs once per session, on the first prompt or tool
   call, and the answer is kept for the rest of the session.
4. **`REVA_SESSION_ENTRYPOINT`**, accepted only when none of the above is present.
5. Otherwise `cli`.

Two consequences follow, and both are tested:

- **A surface that names itself wins.** The desktop app reports `Copilot Desktop` even with
  editor markers or `REVA_SESSION_ENTRYPOINT` in its environment.


## What a hook does on an excluded surface

Nothing runs. Copilot on github.com and the cloud coding agent run on GitHub's servers and
never load plugins from your machine, so there is no hook to call and no request reaches
Reva. The same holds for VS Code cloud sessions and for VS Code Chat on the Claude or Codex
session target. The plugin has no exclusion list: every surface that loads it is governed.

## Verification matrix

[`test/sessionEntrypoint.test.ts`](../test/sessionEntrypoint.test.ts) asserts:

| Dimension | Values |
|---|---|
| Desktop app | the desktop client URL, the `copilot-developer-app` integration id |
| Editors | VS Code, Code - Insiders, Cursor, Windsurf, on Windows, macOS and Linux paths, and from the executable name |
| Editor without a name | `ide` |
| Editor from parent processes | the VS Code Copilot Chat chain → `ide-vscode`; the desktop app and a terminal CLI chain → no editor; looked up once per session; skipped at session start |
| Other terminals | Apple Terminal, iTerm, tmux, WezTerm, none → `cli` |
| Precedence | the desktop app over editor markers and `REVA_SESSION_ENTRYPOINT`; an editor (environment or parent process) over `REVA_SESSION_ENTRYPOINT` |

On top of that, the hook tests drive the real hook entry points as subprocesses against a
local stand-in for Reva and check that a 200 allows and a 403 denies, and the configuration
tests check that a missing `REVA_AUTH_TOKEN` or agent id is rejected.

## Rollout

An older installed copy keeps running its own older code, so confirm the installed version
before concluding that a surface is reported correctly.

```bash
copilot plugin list
copilot plugin update reva-security@reva-plugins
```

Start a fresh session afterwards — configuration and plugin code are read at session start.
Restart the desktop app, and reload the VS Code window.
