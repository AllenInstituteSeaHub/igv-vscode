import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ControlServer, defaultEndpoint, tokensEqual } from '../../src/agent/ControlServer';
import { CliError, ControlClient, discover } from '../../src/agent/client';
import { chooseInstance, instancesDir, listInstances, removeInstance, writeInstance } from '../../src/agent/registry';
import { installOnPath, posixLauncher, windowsLauncher, writeLaunchers } from '../../src/agent/CliInstaller';
import { RpcError } from '../../src/shared/rpc';
import type { InstanceRecord } from '../../src/agent/protocol';

let home: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'igv-ctl-'));
  env = { IGV_VSCODE_HOME: home, XDG_RUNTIME_DIR: home };
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const log = () => undefined;
type Handler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function makeServer(id: string, handler: Handler = async (method, params) => ({ method, params })) {
  return new ControlServer({ handler, log, endpoint: defaultEndpoint(id, env) }, id);
}

async function rejection(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected rejection');
}

async function record(server: ControlServer, id: string, folders: string[], lastActiveAt: string, pid = process.pid): Promise<InstanceRecord> {
  const rec: InstanceRecord = { id, endpoint: server.endpoint, token: server.token, pid, workspaceFolders: folders, startedAt: lastActiveAt, lastActiveAt, version: '0', host: 'desktop' };
  await writeInstance(rec, env);
  return rec;
}

describe('ControlServer + ControlClient', () => {
  it('answers JSON-RPC over the socket, enforces the token, maps errors', async () => {
    const server = makeServer('s1', async (method, params) => {
      if (method === 'ping') return { ok: true, ...params };
      if (method === 'boom') throw new RpcError('FILE_NOT_FOUND', 'nope', { hint: 'create it' });
      throw new RpcError('INTERNAL', `unknown method "${method}"`);
    });
    await server.start();
    try {
      expect(statSync(server.endpoint).mode & 0o777).toBe(0o600);
      const client = new ControlClient({ endpoint: server.endpoint, token: server.token, source: 'env' });
      expect(await client.request('ping', { x: 1 })).toEqual({ ok: true, x: 1 });
      const err = await rejection(client.request('boom'));
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(2);
      expect(err.data).toMatchObject({ code: 'FILE_NOT_FOUND', hint: 'create it', rpcCode: -32000 });
      const unknown = await rejection(client.request('nope'));
      expect(unknown.data?.rpcCode).toBe(-32601);
      client.close();

      const bad = new ControlClient({ endpoint: server.endpoint, token: 'wrong', source: 'env' });
      const unauthorized = await rejection(bad.request('ping'));
      expect(unauthorized.exitCode).toBe(3);
      expect(unauthorized.data).toMatchObject({ code: 'UNAUTHORIZED', rpcCode: -32001 });
      bad.close();

      // Raw framing: parse error and invalid request.
      expect((await server.handleLine('{not json')).error?.code).toBe(-32700);
      expect((await server.handleLine(JSON.stringify({ id: 1, method: 'ping' }))).error?.code).toBe(-32600);
      expect(tokensEqual(undefined, 'x')).toBe(false);
      expect(tokensEqual('abc', 'abc')).toBe(true);
      expect(tokensEqual('abcd', 'abc')).toBe(false);
    } finally {
      await server.stop();
    }
    expect(existsSync(server.endpoint)).toBe(false);
  });

  it('times out requests and reports a closed connection', async () => {
    const server = makeServer('slow', () => new Promise(() => undefined));
    await server.start();
    try {
      const client = new ControlClient({ endpoint: server.endpoint, token: server.token, source: 'env' }, { timeoutMs: 200 });
      const err = await rejection(client.request('hang'));
      expect(err.exitCode).toBe(4);
      client.close();
    } finally {
      await server.stop();
    }
    const dead = new ControlClient({ endpoint: join(home, 'nothing.sock'), token: 't', source: 'env' }, { timeoutMs: 500 });
    const err = await rejection(dead.request('ping'));
    expect(err.exitCode).toBe(3);
  });
});

describe('instance registry and discovery', () => {
  it('writes 0600 records, prunes dead pids, and chooses by cwd then recency', async () => {
    const a = makeServer('aaaa');
    const b = makeServer('bbbb');
    await a.start();
    await b.start();
    try {
      const recA = await record(a, 'aaaa', [join(home, 'projA')], '2026-01-01T00:00:00Z');
      const recB = await record(b, 'bbbb', [join(home, 'projB'), join(home, 'projB', 'nested')], '2026-02-01T00:00:00Z');
      await record(a, 'dead', ['/x'], '2026-03-01T00:00:00Z', 999_999_999);
      writeFileSync(join(instancesDir(env), 'junk.json'), '{bad');
      expect(statSync(join(instancesDir(env), 'aaaa.json')).mode & 0o777).toBe(0o600);

      const live = await listInstances(env);
      expect(live.map((i) => i.id).sort()).toEqual(['aaaa', 'bbbb']);
      expect(existsSync(join(instancesDir(env), 'dead.json'))).toBe(false);
      expect(existsSync(join(instancesDir(env), 'junk.json'))).toBe(false);

      expect(chooseInstance(live, join(home, 'projA', 'sub'))?.id).toBe('aaaa');
      expect(chooseInstance(live, join(home, 'projB', 'nested', 'deep'))?.id).toBe('bbbb');
      expect(chooseInstance(live, '/elsewhere')?.id).toBe('bbbb'); // most recent
      expect(chooseInstance(live, '/elsewhere', 'aa')?.id).toBe('aaaa'); // explicit prefix
      expect(chooseInstance(live, '/elsewhere', 'zz')).toBeUndefined();

      // discover(): cwd selection, verified by ping.
      const d = await discover({ cwd: join(home, 'projA'), env });
      expect(d).toMatchObject({ id: 'aaaa', endpoint: a.endpoint, token: a.token, source: 'registry' });
      const d2 = await discover({ cwd: '/elsewhere', env });
      expect(d2.id).toBe('bbbb');
      // Environment variables win when present.
      const d3 = await discover({ cwd: '/elsewhere', env: { ...env, IGV_VSCODE_ENDPOINT: a.endpoint, IGV_VSCODE_TOKEN: a.token } });
      expect(d3).toMatchObject({ source: 'env', endpoint: a.endpoint });
      // Explicit instance bypasses env.
      const d4 = await discover({ cwd: '/elsewhere', env: { ...env, IGV_VSCODE_ENDPOINT: a.endpoint, IGV_VSCODE_TOKEN: a.token }, instance: 'bbbb' });
      expect(d4.id).toBe('bbbb');
      const missing = await rejection(discover({ cwd: '/x', env, instance: 'zzzz' }));
      expect(missing.exitCode).toBe(3);

      // An unreachable registry entry is skipped in favour of a live one.
      await b.stop();
      const d5 = await discover({ cwd: '/elsewhere', env });
      expect(d5.id).toBe('aaaa');
      await removeInstance('bbbb', env);
      await removeInstance('aaaa', env);
      expect(await listInstances(env)).toEqual([]);
      void recA;
      void recB;
    } finally {
      await a.stop();
      await b.stop().catch(() => undefined);
    }
    const none = await rejection(discover({ cwd: '/x', env }));
    expect(none.exitCode).toBe(3);
    expect(none.message).toMatch(/No running VS Code/);
  });
});

describe('CliInstaller', () => {
  it('writes launchers with the runtime path baked in and symlinks into ~/.local/bin', async () => {
    const bin = join(home, 'bin');
    const l = await writeLaunchers(bin, '/Apps/Code Helper (Plugin)', '/ext/dist/cli.js');
    const sh = readFileSync(l.posix, 'utf8');
    expect(sh).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/Apps/Code Helper (Plugin)' '/ext/dist/cli.js' "$@"`);
    expect(statSync(l.posix).mode & 0o111).toBeTruthy();
    expect(readFileSync(l.windows, 'utf8')).toContain('"/Apps/Code Helper (Plugin)" "/ext/dist/cli.js" %*');
    expect(posixLauncher("/it's/node", '/c.js')).toContain(`'/it'\\''s/node'`);
    expect(windowsLauncher('C:\\node.exe', 'C:\\cli.js')).toContain('set ELECTRON_RUN_AS_NODE=1');
    const fakeHome = join(home, 'fakehome');
    const r = await installOnPath(l, fakeHome, 'darwin');
    expect(r.installed).toBe(true);
    expect(readlinkSync(join(fakeHome, '.local', 'bin', 'igv-vscode'))).toBe(l.posix);
    const again = await installOnPath(l, fakeHome, 'darwin');
    expect(again.installed).toBe(true);
    const win = await installOnPath(l, fakeHome, 'win32');
    expect(win.installed).toBe(false);
    expect(win.message).toContain(bin);
  });
});
