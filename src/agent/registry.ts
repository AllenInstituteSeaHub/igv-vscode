/**
 * Instance registry (spec §6.2): one JSON file per running extension host in
 * ~/.igv-vscode/instances/, mode 0600, so CLIs started outside an integrated
 * terminal can find a VS Code window. No `vscode` dependency.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { InstanceRecord } from './protocol';

export function igvHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.IGV_VSCODE_HOME?.trim() || path.join(os.homedir(), '.igv-vscode');
}

export function instancesDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(igvHomeDir(env), 'instances');
}

export async function writeInstance(record: InstanceRecord, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = instancesDir(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${record.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
  return file;
}

export async function touchInstance(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = path.join(instancesDir(env), `${id}.json`);
  try {
    const rec = JSON.parse(await fs.readFile(file, 'utf8')) as InstanceRecord;
    rec.lastActiveAt = new Date().toISOString();
    await writeInstance(rec, env);
  } catch {
    // instance file gone; nothing to touch
  }
}

export async function removeInstance(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await fs.rm(path.join(instancesDir(env), `${id}.json`), { force: true });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** All registry entries, pruning files whose process is dead. */
export async function listInstances(env: NodeJS.ProcessEnv = process.env, prune = true): Promise<InstanceRecord[]> {
  const dir = instancesDir(env);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: InstanceRecord[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(dir, n);
    try {
      const rec = JSON.parse(await fs.readFile(file, 'utf8')) as InstanceRecord;
      if (!rec || typeof rec.endpoint !== 'string' || typeof rec.token !== 'string') throw new Error('malformed');
      if (prune && !pidAlive(rec.pid)) {
        await fs.rm(file, { force: true });
        continue;
      }
      out.push(rec);
    } catch {
      if (prune) await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }
  return out;
}

/**
 * Pick the instance for a CLI invocation (spec §6.2): explicit `--instance`,
 * else the one whose workspace folder contains `cwd`, else the most recently
 * active.
 */
export function chooseInstance(instances: InstanceRecord[], cwd: string, explicit?: string): InstanceRecord | undefined {
  if (explicit) return instances.find((i) => i.id === explicit || i.id.startsWith(explicit));
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  const c = norm(cwd);
  const containing = instances.filter((i) =>
    i.workspaceFolders.some((f) => {
      const nf = norm(f);
      return c === nf || c.startsWith(nf + path.sep);
    }),
  );
  const byRecent = (a: InstanceRecord, b: InstanceRecord) => b.lastActiveAt.localeCompare(a.lastActiveAt);
  if (containing.length > 0) {
    // Deepest matching folder wins, then most recent.
    containing.sort((a, b) => {
      const depth = (i: InstanceRecord) => Math.max(...i.workspaceFolders.filter((f) => c === norm(f) || c.startsWith(norm(f) + path.sep)).map((f) => norm(f).length));
      return depth(b) - depth(a) || byRecent(a, b);
    });
    return containing[0];
  }
  return [...instances].sort(byRecent)[0];
}
