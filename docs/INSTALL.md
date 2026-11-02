# Installing

## Requirements

- **GitHub Copilot CLI**, signed in with `/login`.
- **Node.js 18 or later**, with `node` on your `PATH`. Every hook runs as a short-lived
  `node` process, so if `node` is not resolvable the plugin cannot run at all.
- A **Reva auth token** for your tenant, and your tenant's **API host** unless you are on
  the default `api.reva.ai`.

No build step is needed. Compiled JavaScript is committed to the repository, and the hooks
run it directly.

## Individual install

```bash
copilot plugin marketplace add https://github.com/reva-ai/reva-github-copilot-authorization
copilot plugin install reva-security@reva-plugins
```

Then add your token to `~/.copilot/settings.json`:

```json
{
  "env": {
    "REVA_AUTH_TOKEN": "<your token>"
  }
}
```

Start a new `copilot` session afterwards — configuration is read at session start, not live.
In the desktop app, restart it; in VS Code, reload the window and start a new chat on the
**Copilot** session target — see [DESKTOP-COMPATIBILITY.md](DESKTOP-COMPATIBILITY.md).

`settings.json` is a plaintext file. Keep it private, and never commit it or copy it into a
repository.

If your tenant is not on `api.reva.ai`, add the host in the same block:

```json
{
  "env": {
    "REVA_AUTH_TOKEN": "<your token>",
    "REVA_HOST": "api.example.reva.ai"
  }
}
```

`REVA_HOST` in the environment overrides the value in `settings.json` — see
[CONFIGURATION.md](CONFIGURATION.md).

## Team rollout

Deploy to everyone in your workspace without each person editing their settings.

**1. Store your workspace token in your organization's secrets manager**, exposed to each
workstation as the environment variable `REVA_AUTH_TOKEN`. Keep it there — not in a shared
config file — so it stays under your secrets manager's own access controls. Set `REVA_HOST`
the same way if you are not on the default host.

**2. Run the install on every workstation**, from your device-management or onboarding
script:

```bash
copilot plugin marketplace add https://github.com/reva-ai/reva-github-copilot-authorization
copilot plugin install reva-security@reva-plugins
```

Members get the plugin in their next session. Because `REVA_AUTH_TOKEN` is already in their
environment from step 1, nobody has to enter a token.

On GitHub Enterprise, you can require the plugin instead of scripting the install: add it
to your enterprise's `managed-settings.json` (see
[Managing plugin marketplaces and plugins with enterprise-managed settings](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/use-managed-settings/manage-plugin-marketplaces-and-plugins)).
Managed settings reach the Copilot CLI, the desktop app and VS Code, and take precedence
over member preferences:

```json
{
  "extraKnownMarketplaces": {
    "reva-plugins": {
      "source": { "source": "github", "repo": "reva-ai/reva-github-copilot-authorization" }
    }
  },
  "enabledPlugins": { "reva-security@reva-plugins": true }
}
```

Members need read access to the marketplace repository. The token still comes from step 1.

**Before you roll this out to a team, read
[SECURITY.md](../SECURITY.md#what-it-sends-and-what-it-keeps).** The plugin transmits prompt
text, shell commands and tool output to your Reva tenant, and your developers are entitled
to know that.

## Updating your token

- **Set in `~/.copilot/settings.json`**: edit the value there. No reinstall needed.
- **Set as an environment variable**: update it at the source — your shell profile or your
  secrets manager. No reinstall needed.

Either way, start a fresh session afterwards.

## Uninstalling

```bash
copilot plugin uninstall reva-security@reva-plugins
```

Local state (turn caches, spawn counters, the active-session list, your saved account id)
lives in `~/.copilot/plugin-data/reva-plugins/reva-security/`. Delete that folder to remove
it, along with `~/.copilot-governance/` if it exists — the debug log is written there when
the host gives the plugin no data directory. Nothing was written to your repositories.
