import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  CopilotUserRecord,
  apiBaseFor,
  formatAsUuid,
  readCopilotSignedInUser,
  readCopilotToken,
  resolveCopilotAccountEmail,
  resolveCopilotAccountId,
} from '../src/copilotAccount';

const TRACKING_ID = '0123456789abcdef0123456789abcdef';
const AS_UUID = '01234567-89ab-cdef-0123-456789abcdef';

function withDirs(fn: (dataDir: string, configPath: string) => void): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-copilot-account-data-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-copilot-account-cfg-'));
  try {
    fn(dataDir, path.join(cfgDir, 'config.json'));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
}

// Shape Copilot CLI 1.0.x writes, including its leading // comment lines.
function writeConfig(configPath: string, login: string, host = 'https://github.com'): void {
  fs.writeFileSync(
    configPath,
    `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify({
      lastLoggedInUser: { host, login },
      loggedInUsers: [{ host, login, kind: 'githubDotCom' }],
    })}`,
    'utf8',
  );
}

function fetcher(record: CopilotUserRecord | undefined): { fetch: (host: string) => CopilotUserRecord | undefined; calls: string[] } {
  const calls: string[] = [];
  return { calls, fetch: (host) => (calls.push(host), record) };
}

test('formatAsUuid formats 32 hex chars as 8-4-4-4-12 and rejects anything else', () => {
  assert.equal(formatAsUuid(TRACKING_ID), AS_UUID);
  assert.equal(formatAsUuid(TRACKING_ID.toUpperCase()), AS_UUID);
  assert.equal(formatAsUuid('12345678'), undefined);
  assert.equal(formatAsUuid(`${TRACKING_ID}00`), undefined);
  assert.equal(formatAsUuid(undefined), undefined);
});

test('readCopilotSignedInUser reads login and host from a commented config.json', () => {
  withDirs((_dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    assert.deepEqual(readCopilotSignedInUser(configPath), { host: 'https://github.com', login: 'octocat' });
  });
});

test('first resolution looks up via gh, returns a UUID and caches it', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    const f = fetcher({ login: 'octocat', analyticsTrackingId: TRACKING_ID });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), AS_UUID);
    assert.deepEqual(f.calls, ['https://github.com']);
    const cached = JSON.parse(fs.readFileSync(path.join(dataDir, 'copilot-account.json'), 'utf8'));
    assert.equal(cached.login, 'octocat');
    assert.equal(cached.analyticsTrackingId, TRACKING_ID);
  });
});

test('a cached id for the same account is used without calling gh', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: fetcher({ login: 'octocat', analyticsTrackingId: TRACKING_ID }).fetch });
    const second = fetcher(undefined);
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: second.fetch }), AS_UUID);
    assert.equal(second.calls.length, 0);
  });
});

test('signing Copilot into a different account invalidates the cache', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: fetcher({ login: 'octocat', analyticsTrackingId: TRACKING_ID }).fetch });
    writeConfig(configPath, 'someone-else');
    const other = 'aaaabbbbccccddddeeeeffff00001111';
    const f = fetcher({ login: 'someone-else', analyticsTrackingId: other });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), formatAsUuid(other));
    assert.equal(f.calls.length, 1);
  });
});

test('gh signed in as a different login than Copilot is rejected, not attributed', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    const f = fetcher({ login: 'a-different-account', analyticsTrackingId: TRACKING_ID });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), undefined);
    assert.equal(fs.existsSync(path.join(dataDir, 'copilot-account.json')), false);
  });
});

test('login comparison is case-insensitive', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    const f = fetcher({ login: 'OCTOCAT', analyticsTrackingId: TRACKING_ID });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), AS_UUID);
  });
});

test('no fallback: gh unavailable or the field missing/malformed resolves to undefined', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: fetcher(undefined).fetch }), undefined);
    assert.equal(
      resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: fetcher({ login: 'octocat' }).fetch }),
      undefined,
    );
    assert.equal(
      resolveCopilotAccountId({
        pluginDataDir: dataDir,
        configPath,
        fetch: fetcher({ login: 'octocat', analyticsTrackingId: 'not-hex' }).fetch,
      }),
      undefined,
    );
  });
});

test('not signed in to Copilot resolves to undefined without calling gh', () => {
  withDirs((dataDir, configPath) => {
    const f = fetcher({ login: 'octocat', analyticsTrackingId: TRACKING_ID });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), undefined);
    assert.equal(f.calls.length, 0);
  });
});

test('allowLookup: false uses the cache only', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    const f = fetcher({ login: 'octocat', analyticsTrackingId: TRACKING_ID });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, allowLookup: false, fetch: f.fetch }), undefined);
    assert.equal(f.calls.length, 0);
    resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: f.fetch });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, allowLookup: false, fetch: f.fetch }), AS_UUID);
  });
});

test('GitHub Enterprise: the lookup targets the configured host', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat', 'https://ghe.example.com');
    const f = fetcher({ login: 'octocat', analyticsTrackingId: TRACKING_ID });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), AS_UUID);
    assert.deepEqual(f.calls, ['https://ghe.example.com']);
  });
});

test('the public email is cached with the id; later hooks read it without a lookup', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    const f = fetcher({ login: 'octocat', analyticsTrackingId: TRACKING_ID, email: 'dev@example.com' });
    assert.deepEqual(resolveCopilotAccountEmail({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), {
      email: 'dev@example.com',
      known: true,
    });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), AS_UUID);
    const none = fetcher(undefined);
    assert.deepEqual(resolveCopilotAccountEmail({ pluginDataDir: dataDir, configPath, allowLookup: false, fetch: none.fetch }), {
      email: 'dev@example.com',
      known: true,
    });
    assert.equal(f.calls.length, 1);
    assert.equal(none.calls.length, 0);
  });
});

test('no public email is cached as known-none, so it is not looked up again', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    const f = fetcher({ login: 'octocat', analyticsTrackingId: TRACKING_ID, email: null });
    for (let i = 0; i < 2; i++) {
      const r = resolveCopilotAccountEmail({ pluginDataDir: dataDir, configPath, fetch: f.fetch });
      assert.equal(r.known, true);
      assert.equal(r.email, undefined);
    }
    assert.equal(f.calls.length, 1);
  });
});

test('a cache written before email was stored is completed by one lookup', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    fs.writeFileSync(
      path.join(dataDir, 'copilot-account.json'),
      JSON.stringify({ host: 'https://github.com', login: 'octocat', analyticsTrackingId: TRACKING_ID, resolvedAt: 'x' }),
    );
    const f = fetcher({ login: 'octocat', analyticsTrackingId: TRACKING_ID, email: 'dev@example.com' });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), AS_UUID);
    assert.equal(f.calls.length, 0, 'the id alone needs no lookup');
    assert.equal(resolveCopilotAccountEmail({ pluginDataDir: dataDir, configPath, fetch: f.fetch }).email, 'dev@example.com');
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'copilot-account.json'), 'utf8')).email, 'dev@example.com');
  });
});

test('an email request that failed is not cached as known', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    const f = fetcher({ login: 'octocat', analyticsTrackingId: TRACKING_ID });
    assert.deepEqual(resolveCopilotAccountEmail({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), { known: false });
    assert.equal(resolveCopilotAccountId({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), AS_UUID, 'the id is still cached');
  });
});

test('a different account’s email is never used', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    const f = fetcher({ login: 'someone-else', analyticsTrackingId: TRACKING_ID, email: 'other@example.com' });
    assert.deepEqual(resolveCopilotAccountEmail({ pluginDataDir: dataDir, configPath, fetch: f.fetch }), { known: false });
  });
});

test('the lookup is told which login it is for', () => {
  withDirs((dataDir, configPath) => {
    writeConfig(configPath, 'octocat');
    const logins: string[] = [];
    resolveCopilotAccountId({
      pluginDataDir: dataDir,
      configPath,
      fetch: (_host, login) => (logins.push(login), { login, analyticsTrackingId: TRACKING_ID }),
    });
    assert.deepEqual(logins, ['octocat']);
  });
});

test('apiBaseFor: github.com, GHE.com data residency, GitHub Enterprise Server', () => {
  assert.equal(apiBaseFor('https://github.com'), 'https://api.github.com');
  assert.equal(apiBaseFor('https://acme.ghe.com'), 'https://api.acme.ghe.com');
  assert.equal(apiBaseFor('https://ghe.example.com/'), 'https://ghe.example.com/api/v3');
});

test('readCopilotToken: Copilot token env vars first, in Copilot order, token-shaped only', () => {
  const who = { host: 'https://github.com', login: 'octocat' };
  assert.equal(readCopilotToken(who, { COPILOT_GITHUB_TOKEN: 'gho_a', GH_TOKEN: 'gho_b' }), 'gho_a');
  assert.equal(readCopilotToken(who, { GH_TOKEN: ' ghu_b ', GITHUB_TOKEN: 'gho_c' }), 'ghu_b');
  assert.equal(readCopilotToken(who, { COPILOT_GITHUB_TOKEN: 'not-a-token', GITHUB_TOKEN: 'github_pat_x' }), 'github_pat_x');
});
