import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { loadConfig, resolveConfiguredAgentId, urlFromHost } from '../src/config';
import { readCopilotSettingsReva } from '../src/copilotSettings';

function tempSettings(contents: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-copilot-settings-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, contents, 'utf8');
  return { dir, file };
}

const emptySettings = () => tempSettings('{}');

describe('loadConfig', () => {
  it('builds urls from host', () => {
    assert.equal(urlFromHost('api.reva.ai', '/pdp/v2/ai/evaluation'), 'https://api.reva.ai/pdp/v2/ai/evaluation');
    assert.equal(urlFromHost('localhost:8787', '/ingestion/v2'), 'http://localhost:8787/ingestion/v2');
  });

  it('requires auth token when settings and env are empty', () => {
    const { file } = emptySettings();
    assert.throws(() => loadConfig({}, file), /REVA_AUTH_TOKEN/);
  });

  it('requires agent id when none resolved', () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "try { require('./dist/src/config').loadConfig({ REVA_AUTH_TOKEN: 't' }, '/nonexistent/settings.json'); process.exit(2); } catch (e) { process.stderr.write(String(e.message)); process.exit(1); }",
      ],
      {
        cwd: path.join(__dirname, '..', '..'),
        env: {
          REVA_AUTH_TOKEN: 't',
          PATH: path.dirname(process.execPath),
          REVA_COPILOT_CONFIG_PATH: '/nonexistent/reva-governance-test/config.json',
          HOME: '/nonexistent/reva-governance-test-home',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /REVA_AGENT_ID/);
  });

  it('loads with explicit agent id from env', () => {
    const { file } = emptySettings();
    const cfg = loadConfig(
      {
        REVA_AUTH_TOKEN: 'tok',
        REVA_AGENT_ID: 'agent-1',
        REVA_HOST: 'localhost:8787',
      },
      file,
    );
    assert.equal(cfg.authorization, 'tok');
    assert.equal(cfg.agentId, 'agent-1');
    assert.match(cfg.rtgUrl, /^http:\/\/localhost:8787\//);
  });

  it('reads REVA_AUTH_TOKEN and REVA_HOST from settings.json when env is unset', () => {
    const { file } = tempSettings(
      JSON.stringify({ REVA_AUTH_TOKEN: 'from-settings', REVA_AGENT_ID: 'agent-s', REVA_HOST: 'localhost:9999' }),
    );
    const cfg = loadConfig({}, file);
    assert.equal(cfg.authorization, 'from-settings');
    assert.equal(cfg.agentId, 'agent-s');
    // Copilot does not inject settings.env into hooks, so the host is read
    // from settings.json itself.
    assert.equal(cfg.rtgUrl, 'http://localhost:9999/pdp/v2/ai/evaluation');
  });

  it('prefers settings.json over env for token/agentId; process REVA_HOST still wins', () => {
    const { file } = tempSettings(
      JSON.stringify({ REVA_AUTH_TOKEN: 'settings-tok', REVA_AGENT_ID: 'agent-s', REVA_HOST: 'localhost:9999' }),
    );
    const cfg = loadConfig(
      {
        REVA_AUTH_TOKEN: 'env-tok',
        REVA_AGENT_ID: 'agent-e',
        REVA_HOST: 'localhost:8787',
      },
      file,
    );
    assert.equal(cfg.authorization, 'settings-tok');
    assert.equal(cfg.agentId, 'agent-s');
    assert.equal(cfg.rtgUrl, 'http://localhost:8787/pdp/v2/ai/evaluation');
  });

  it('uses settings REVA_HOST when process env is unset', () => {
    const { file } = tempSettings(
      JSON.stringify({
        env: { REVA_AUTH_TOKEN: 'tok', REVA_AGENT_ID: 'a', REVA_HOST: 'api.example.reva.ai' },
      }),
    );
    const cfg = loadConfig({}, file);
    assert.equal(cfg.rtgUrl, 'https://api.example.reva.ai/pdp/v2/ai/evaluation');
  });

  it('host defaults to api.reva.ai when neither env nor settings set REVA_HOST', () => {
    const { file } = tempSettings(JSON.stringify({ REVA_AUTH_TOKEN: 'tok', REVA_AGENT_ID: 'a' }));
    const cfg = loadConfig({}, file);
    assert.equal(cfg.rtgUrl, 'https://api.reva.ai/pdp/v2/ai/evaluation');
  });

  it('falls back to env when settings has no token', () => {
    const { file } = tempSettings(JSON.stringify({ theme: 'github' }));
    const cfg = loadConfig({ REVA_AUTH_TOKEN: 'env-tok', REVA_AGENT_ID: 'agent-e' }, file);
    assert.equal(cfg.authorization, 'env-tok');
  });

});

describe('readCopilotSettingsReva', () => {
  it('accepts nested reva object and JSONC comments', () => {
    const { file } = tempSettings(`{
      // comment
      "reva": {
        "authToken": "nested-tok",
        "host": "localhost:8787"
      }
    }`);
    const parsed = readCopilotSettingsReva(file);
    assert.equal(parsed.authToken, 'nested-tok');
    assert.equal(parsed.host, 'localhost:8787');
  });

  it('reads REVA_AUTH_TOKEN from settings.env', () => {
    const { file } = tempSettings(
      JSON.stringify({ env: { REVA_AUTH_TOKEN: 'from-env-block', REVA_DEBUG: '1' } }),
    );
    const parsed = readCopilotSettingsReva(file);
    assert.equal(parsed.authToken, 'from-env-block');
    assert.equal(parsed.debug, true);
  });

  it('prefers settings.env over top-level REVA_AUTH_TOKEN', () => {
    const { file } = tempSettings(
      JSON.stringify({
        REVA_AUTH_TOKEN: 'top-level',
        env: { REVA_AUTH_TOKEN: 'env-block' },
      }),
    );
    assert.equal(readCopilotSettingsReva(file).authToken, 'env-block');
  });

  it('reads REVA_USER_EMAIL from settings.env', () => {
    const { file } = tempSettings(
      JSON.stringify({ env: { REVA_USER_EMAIL: 'person@gmail.com' } }),
    );
    assert.equal(readCopilotSettingsReva(file).userEmail, 'person@gmail.com');
  });
});

describe('resolveConfiguredAgentId (shared by every hook, sessionStart/sessionEnd included)', () => {
  it('settings.json REVA_AGENT_ID wins over the environment', () => {
    const { file } = tempSettings(JSON.stringify({ env: { REVA_AGENT_ID: 'from-settings' } }));
    assert.equal(resolveConfiguredAgentId({ REVA_AGENT_ID: 'from-env' }, file), 'from-settings');
  });

  it('falls back to the environment when settings.json has none', () => {
    const { file } = emptySettings();
    assert.equal(resolveConfiguredAgentId({ REVA_AGENT_ID: ' from-env ' }, file), 'from-env');
  });
});
