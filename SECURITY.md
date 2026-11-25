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
  - the text of your prompt, up to 10,000 characters;
  - the shell command, search pattern or patch being run;
  - after a tool runs, its output, up to 10,000 characters.
- **Context:**
  - session id and timestamp;
  - which sub-agent made the call, when one did (the chain of agents that led to an action is
    recorded by Reva itself; the plugin sends no hop chain and no conversation history);
  - the surface (`cli`, `ide-<editor>`, `Copilot Desktop`) and the operating system;
  - the model Copilot used for that call;
  - your operating system's own machine id (on Windows the `MachineGuid`), or none if it
    cannot be read — never a made-up one;
  - how many sessions are active on this machine.

### Sent once per turn, when Copilot finishes it

A short best-effort request that closes the turn's trace in Reva so it can write the trace
summary (`POST /pdp/ai/access/v1/ai/trace/summarize`, from the `agentStop` hook):

- the trace id and your session id;
- **the assistant's final reply, up to 16 KiB, only if Copilot includes it in the hook input.**
  Copilot's `agentStop` input carries a path to its transcript rather than the reply, so
  today the request holds the two ids alone. The plugin never opens the transcript file.

It uses your Reva token and nothing else. If it fails, nothing happens: it never blocks
Copilot, and it is skipped for the rest of a session once Reva has rejected the token (401).

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
| `turns/` | The current turn's trace id, turn number and timestamps. Never your prompt: it is sent to Reva and not stored here |
| `spawns/`, `subagents/` | How many sub-agents this turn, and which session each sub-agent belongs to |
| `active-sessions/` | Session ids and when each was last seen |
| `rtg-circuit-breaker/` | Sessions where Reva rejected the token (see below) |
| `machine-id` | Your operating system's machine id, saved after it is first read |
| `agent-models.json`, `entity-types/` | Small caches |
| `reva-debug.log` | Only with `REVA_DEBUG=1`; contains prompts and commands |

A `hops/` folder left by an earlier version is no longer used or read; delete it. Likewise, a
file in `turns/` written by an earlier version may still hold the first 2,000 characters of a
prompt: nothing reads it, and the session's next turn overwrites it, or you can delete the
folder. Nothing is
written to your repositories. Delete the folder to remove all of it.

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
| The end-of-turn summarize request fails or Reva is unreachable | ignored — it never blocks |

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
