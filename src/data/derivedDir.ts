/**
 * Where generated artifacts (indexes, bgzipped copies, subsamples) go
 * (spec §5.2): next to the source when its directory is writable, otherwise
 * in `derivedDir` under a folder keyed by a hash of the source path, size
 * and mtime. On CodeOcean `/data` is read-only, so the fallback matters.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function isWritableDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return false;
    await fs.access(dir, fs.constants.W_OK);
    // W_OK can lie on some mounts: try a real write.
    const probe = path.join(dir, `.igv-write-test-${process.pid}-${Date.now()}`);
    await fs.writeFile(probe, '');
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

export async function sourceKey(sourcePath: string): Promise<string> {
  const st = await fs.stat(sourcePath);
  return createHash('sha1').update(`${path.resolve(sourcePath)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
}

export interface DerivedLocation {
  /** Directory where artifacts for this source should be written. */
  dir: string;
  /** True when `dir` is the source's own directory. */
  nextToSource: boolean;
}

export async function derivedLocation(sourcePath: string, derivedDir: string): Promise<DerivedLocation> {
  const srcDir = path.dirname(path.resolve(sourcePath));
  if (await isWritableDir(srcDir)) return { dir: srcDir, nextToSource: true };
  const dir = path.join(derivedDir, await sourceKey(sourcePath));
  await fs.mkdir(dir, { recursive: true });
  return { dir, nextToSource: false };
}

/** Path for an artifact derived from `sourcePath`: `<dir>/<basename><suffix>`. */
export async function derivedPath(sourcePath: string, suffix: string, derivedDir: string): Promise<{ path: string; nextToSource: boolean }> {
  const loc = await derivedLocation(sourcePath, derivedDir);
  return { path: path.join(loc.dir, path.basename(sourcePath) + suffix), nextToSource: loc.nextToSource };
}

/** Existing derived artifact for a source, if any (checked next to the source and in the derived dir). */
export async function findDerived(sourcePath: string, suffix: string, derivedDir: string): Promise<string | undefined> {
  const candidates = [path.resolve(sourcePath) + suffix, path.join(derivedDir, await sourceKey(sourcePath).catch(() => 'x'), path.basename(sourcePath) + suffix)];
  for (const c of candidates) {
    try {
      const st = await fs.stat(c);
      if (st.isFile() && st.size > 0) return c;
    } catch {
      // next
    }
  }
  return undefined;
}
