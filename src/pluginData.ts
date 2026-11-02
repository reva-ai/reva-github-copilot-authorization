// Copilot CLI documents ${COPILOT_PLUGIN_DATA} (also aliased as
// ${PLUGIN_DATA} / ${CLAUDE_PLUGIN_DATA} in Agent Plugins 1.0). Prefer the
// Copilot-native name; accept the aliases so a Claude-compatible install
// path still works. No home-directory fallback — without a host-blessed
// data dir there is nothing honest to write to.
export function resolvePluginDataDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.COPILOT_PLUGIN_DATA || env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || undefined;
}

export function resolvePluginRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.COPILOT_PLUGIN_ROOT || env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || undefined;
}
