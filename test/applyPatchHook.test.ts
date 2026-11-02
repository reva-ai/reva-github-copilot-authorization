import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// Real compiled PreToolUse entrypoint, real subprocess, local stand-in RTG.
const AUTHORIZE = path.join(__dirname, '..', 'src', 'authorize.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO = path.basename(REPO_ROOT);

type Decide = (body: any) => { status: number; json: any };

async function withRtg(decide: Decide, fn: (host: string, bodies: any[]) => Promise<void>): Promise<void> {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.url?.includes('/ai/evaluation')) {
        const body = JSON.parse(data);
        bodies.push(body);
        const { status, json } = decide(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(`127.0.0.1:${(server.address() as AddressInfo).port}`, bodies);
  } finally {
    server.close();
  }
}

function runAuthorize(payload: object, host: string, dataDir: string, home: string): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AUTHORIZE], {
      env: {
        PATH: process.env.PATH || '',
        HOME: home,
        USERPROFILE: home,
        REVA_HOST: host,
        REVA_AUTH_TOKEN: 'test-token',
        REVA_AGENT_ID: 'dev',
        REVA_USER_EMAIL: 'dev@example.com',
        COPILOT_PLUGIN_DATA: dataDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function withDirs(fn: (dataDir: string, home: string) => Promise<void>): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-patch-hook-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-patch-hook-home-'));
  try {
    await fn(dataDir, home);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const allow: Decide = () => ({ status: 200, json: { decision: true } });

const DELETE_PATCH = '*** Begin Patch\n*** Delete File: tests/test.js\n*** End Patch\n';

test('live Copilot apply_patch delete: one write request on the exact file, raw patch as transmission', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(allow, async (host, bodies) => {
      const r = await runAuthorize({ sessionId: 's1', cwd: REPO_ROOT, toolName: 'apply_patch', toolArgs: DELETE_PATCH }, host, dataDir, home);
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).permissionDecision, 'allow');
      assert.equal(bodies.length, 1);
      const b = bodies[0];
      assert.equal(b.action.name, 'write');
      assert.equal(b.resource.type, 'File');
      assert.equal(b.resource.id, `${REPO}/tests/test.js`);
      assert.equal(b.context.command, undefined, 'write context carries no command');
      assert.equal(b.transmission.userQuery, DELETE_PATCH.trim());
    });
  });
});

test('a policy denying the deleted file blocks the patch', async () => {
  await withDirs(async (dataDir, home) => {
    const denyTests: Decide = (body) =>
      body.resource.id.startsWith(`${REPO}/tests/`) ? { status: 403, json: {} } : { status: 200, json: { decision: true } };
    await withRtg(denyTests, async (host) => {
      const r = await runAuthorize({ sessionId: 's2', cwd: REPO_ROOT, toolName: 'apply_patch', toolArgs: DELETE_PATCH }, host, dataDir, home);
      assert.equal(JSON.parse(r.stdout).permissionDecision, 'deny');
    });
  });
});

test('multi-file patch: every file evaluated, one denied file denies the whole call and is named', async () => {
  await withDirs(async (dataDir, home) => {
    const denyTests: Decide = (body) =>
      body.resource.id.startsWith(`${REPO}/tests/`) ? { status: 403, json: {} } : { status: 200, json: { decision: true } };
    const multi = '*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/old.ts\n@@\n-a\n+b\n*** Delete File: tests/test.js\n*** End Patch\n';
    await withRtg(denyTests, async (host, bodies) => {
      const r = await runAuthorize({ sessionId: 's3', cwd: REPO_ROOT, toolName: 'apply_patch', toolArgs: multi }, host, dataDir, home);
      assert.deepEqual(
        bodies.map((b) => [b.action.name, b.resource.id]).sort(),
        [
          ['edit', `${REPO}/src/old.ts`],
          ['write', `${REPO}/src/new.ts`],
          ['write', `${REPO}/tests/test.js`],
        ],
      );
      const out = JSON.parse(r.stdout);
      assert.equal(out.permissionDecision, 'deny');
      assert.match(out.permissionDecisionReason, /tests\/test\.js/);
    });
  });
});

test('an unreadable patch is denied without calling Reva', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(allow, async (host, bodies) => {
      const r = await runAuthorize({ sessionId: 's4', cwd: REPO_ROOT, toolName: 'apply_patch', toolArgs: 'garbage' }, host, dataDir, home);
      assert.equal(JSON.parse(r.stdout).permissionDecision, 'deny');
      assert.equal(bodies.length, 0);
    });
  });
});

test('a powershell delete is unchanged: one executeBash with the raw command', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(allow, async (host, bodies) => {
      await runAuthorize(
        { sessionId: 's5', cwd: REPO_ROOT, toolName: 'powershell', toolArgs: { command: 'Remove-Item tests\\test.js' } },
        host,
        dataDir,
        home,
      );
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].action.name, 'executeBash');
      assert.equal(bodies[0].context.command, 'Remove-Item tests\\test.js');
    });
  });
});

// A folder deleted through a .NET call that no command pattern matches: a
// first-token heuristic would report the resource as
// File:D:\Microsoft.VisualBasic; — so no path policy could match either.
function incidentCommand(drivers: string): string {
  return (
    'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${drivers}','OnlyErrorDialogs','SendToRecycleBin'); ` +
    `Test-Path ${drivers}`
  );
}

test('incident: a path policy on the folder now denies the .NET delete', async () => {
  await withDirs(async (dataDir, home) => {
    const drivers = path.join(dataDir, 'Drivers');
    fs.mkdirSync(drivers);
    const protectDrivers: Decide = (body) =>
      body.resource.id === drivers ? { status: 403, json: {} } : { status: 200, json: { decision: true } };
    await withRtg(protectDrivers, async (host, bodies) => {
      const r = await runAuthorize(
        { sessionId: 's6', cwd: dataDir, toolName: 'powershell', toolArgs: { command: incidentCommand(drivers) } },
        host,
        dataDir,
        home,
      );
      assert.deepEqual(bodies.map((b) => [b.action.name, b.resource.type, b.resource.id]), [['executeBash', 'Directory', drivers]]);
      assert.equal(bodies[0].context.command, incidentCommand(drivers), 'the raw command is sent unchanged');
      assert.equal(JSON.parse(r.stdout).permissionDecision, 'deny');
      assert.ok(fs.existsSync(drivers));
    });
  });
});

test('incident: with no matching policy, the .NET delete is still asked about, not silently allowed', async () => {
  await withDirs(async (dataDir, home) => {
    const drivers = path.join(dataDir, 'Drivers');
    fs.mkdirSync(drivers);
    await withRtg(allow, async (host) => {
      const r = await runAuthorize(
        { sessionId: 's7', cwd: dataDir, toolName: 'powershell', toolArgs: { command: incidentCommand(drivers) } },
        host,
        dataDir,
        home,
      );
      const out = JSON.parse(r.stdout);
      assert.equal(out.permissionDecision, 'ask');
      assert.match(out.permissionDecisionReason, /Add-Type/);
    });
  });
});

test('an ordinary PowerShell listing is still a plain allow', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(allow, async (host) => {
      const r = await runAuthorize(
        {
          sessionId: 's8',
          cwd: dataDir,
          toolName: 'powershell',
          toolArgs: { command: 'Get-ChildItem -Force -ErrorAction SilentlyContinue | Select-Object Mode,Name | Format-Table -AutoSize' },
        },
        host,
        dataDir,
        home,
      );
      assert.equal(JSON.parse(r.stdout).permissionDecision, 'allow');
    });
  });
});
