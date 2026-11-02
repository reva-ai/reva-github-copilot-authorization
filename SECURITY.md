# Security

This page explains what the plugin sends to Reva, what it keeps on your machine, how it
handles credentials, and when it blocks or lets actions through.

## What it sends and what it keeps

### Sent to your Reva tenant, on every governed action

- **Who:** your Copilot account id (the agent) and your email (the user).
- **What:** the action (`read`, `write`, `edit`, `executeBash`, `glob`, `grep`, `spawn`,
  `invokeTool`, `invokeAgent`) and its target: a file or folder path (relative to the
  repository when inside one, otherwise the full path), a tool name, or an MCP server.
- **Content:**
  - the text of your prompt;
  - the shell command, search pattern or patch being run;
  - after a tool runs, its output, up to 10,000 characters.
- **Context:**
  - session id and timestamp;
  - the chain of agents and sub-agents that led to the action;
  - the surface (`cli`, `ide-<editor>`, `Copilot Desktop`) and the operating system;
  - your operating system's own machine id (on Windows the `MachineGuid`), or none if it
    cannot be read — never a made-up one;
  - how many sessions are active on this machine.

### Sent once per session, to register you in Reva's directory

- your email and Copilot account id;
- your machine id and operating system;
- the models Copilot uses;
- the names of your MCP servers, and the URL of HTTP MCP servers.

The command, arguments and environment of local MCP servers are never read.

### Kept on your machine

In `~/.copilot/plugin-data/reva-plugins/reva-security/`:

| File or folder | Contents |
|---|---|
| `copilot-account.json` | Your Copilot login, host, account id and public email |
| `turns/` | The current turn's prompt (first 2,000 characters) and trace ids |
| `hops/`, `spawns/`, `subagents/` | Which agent started which, and how many sub-agents this turn |
| `active-sessions/` | Session ids and when each was last seen |
| `rtg-circuit-breaker/` | Sessions where Reva rejected the token (see below) |
| `machine-id` | Your operating system's machine id, saved after it is first read |
| `agent-models.json`, `entity-types/` | Small caches |
| `reva-debug.log` | Only with `REVA_DEBUG=1`; contains prompts and commands |

Nothing is written to your repositories. Delete the folder to remove all of it.

## Credentials

**Your Reva token** is stored in plain text in `~/.copilot/settings.json`. Treat that file as
a secret: do not commit it, share it, or paste its contents into a chat. Rotate the token in
Reva if it is ever exposed.

**Your GitHub sign-in.** To find your Copilot account id and email, the plugin reads the
token Copilot stored when you signed in. That token is held in memory for one lookup, sent
only to the GitHub host you signed in to, and **never** written to disk, logged or sent to
Reva. The lookup happens once per sign-in; the result is saved in `copilot-account.json`.

## What blocks and what does not

| Condition | Outcome |
|---|---|
| Policy denies (403) | **blocked** |
| Policy allows with conditions (`conditional_allow`) | Copilot **asks** you |
| Reva unreachable, times out, or errors (5xx, 404, 424, 429) | **blocked**, fails closed |
| Token rejected (401) | **passes through for the rest of that session**, fails open |
| Request too large (413) | **passes through** for that one request |
| Plugin not configured (token or agent id missing) | **blocked, every action** |
| Unexpected error inside the plugin | **blocked** |

The plugin blocks before a tool runs. After-the-fact checks are recorded but cannot undo a
tool that already ran.

**The one gap to monitor is a 401.** After a rejected token, that session continues without
checks until it ends. Watch for `401` in your Reva logs, and start a new session after fixing
the token or email.

**Commands that act through code** (for example .NET file APIs, `Invoke-Expression`,
`eval`, an inline script passed to `python -c`) always ask you, even if your policy would
allow them, because their real effect cannot be read from the command line alone.

## Reporting a vulnerability

Email **info@reva.ai** with "SECURITY" in the subject. Please do not open a public issue for
security problems.
