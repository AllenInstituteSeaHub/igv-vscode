import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolDetector, whichOnPath } from '../../src/tools/ToolDetector';
import { derivedLocation, derivedPath, findDerived, isWritableDir } from '../../src/data/derivedDir';
import { formatCommand, quoteArg, subsampleOutputName, tabixPresetFor } from '../../src/tools/jobs';
import type { RpcError } from '../../src/shared/rpc';

const isWindows = process.platform === 'win32';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'igv-tools-'));
  const fake = join(dir, 'samtools');
  writeFileSync(fake, '#!/bin/sh\necho "samtools 9.9-fake"\n');
  chmodSync(fake, 0o755);
  writeFileSync(join(dir, 'notexec'), '');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(isWindows)('ToolDetector', () => {
  it('finds executables on a given PATH and reads the version', async () => {
    const d = new ToolDetector({ env: { PATH: `${dir}` } });
    const t = await d.find('samtools');
    expect(t?.path).toBe(join(dir, 'samtools'));
    expect(t?.version).toBe('samtools 9.9-fake');
    expect(await d.find('tabix')).toBeUndefined();
    expect(await whichOnPath('notexec', { PATH: dir })).toBeUndefined();
  });
  it('prefers configured paths and throws TOOL_MISSING with an install hint', async () => {
    const d = new ToolDetector({ env: { PATH: '/nonexistent' }, configuredPaths: () => ({ samtools: join(dir, 'samtools') }) });
    expect((await d.find('samtools'))?.path).toBe(join(dir, 'samtools'));
    let err: RpcError | undefined;
    try {
      await d.require('tabix', 'index the file');
    } catch (e) {
      err = e as RpcError;
    }
    expect(err?.code).toBe('TOOL_MISSING');
    expect((err?.data as { hint: string }).hint).toMatch(/htslib/);
    const all = await d.detectAll();
    expect(all.samtools?.path).toBeDefined();
    expect(all.bgzip).toBeUndefined();
  });
});

describe.skipIf(isWindows)('derivedDir', () => {
  it('uses the source directory when writable, otherwise a hashed folder under derivedDir', async () => {
    const src = join(dir, 'x.bam');
    writeFileSync(src, 'bam');
    expect(await isWritableDir(dir)).toBe(true);
    expect(await isWritableDir(join(dir, 'nope'))).toBe(false);
    const loc = await derivedLocation(src, join(dir, 'derived'));
    expect(loc).toEqual({ dir, nextToSource: true });
    const p = await derivedPath(src, '.bai', join(dir, 'derived'));
    expect(p.path).toBe(`${src}.bai`);
    expect(await findDerived(src, '.bai', join(dir, 'derived'))).toBeUndefined();
    writeFileSync(`${src}.bai`, 'idx');
    expect(await findDerived(src, '.bai', join(dir, 'derived'))).toBe(`${src}.bai`);
  });
});

describe('job helpers', () => {
  it('formats commands safely and names subsample outputs', () => {
    expect(quoteArg('/a/b.bam')).toBe('/a/b.bam');
    expect(quoteArg("it's here")).toBe(`'it'\\''s here'`);
    expect(formatCommand('samtools', ['index', '/d/x y.bam'])).toBe("samtools index '/d/x y.bam'");
    expect(tabixPresetFor('vcf')).toBe('vcf');
    expect(tabixPresetFor('gff3')).toBe('gff');
    expect(tabixPresetFor('bed')).toBe('bed');
    expect(subsampleOutputName('/d/tumor.bam', 0.1)).toBe('tumor.subsample10pct.bam');
    expect(subsampleOutputName('/d/tumor.bam', 0.025, 'chr1:1-1000')).toBe('tumor.subsample2.5pct.chr1_1-1000.bam');
  });
});
