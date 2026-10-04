/**
 * Exercises the policy end to end against the pysam-backed tool shims in
 * test/tools/bin (see test/tools/README.md). Skipped when the shims' Python
 * environment or the fixtures are missing.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TrackSpec } from '../../src/agent/protocol';
import { resolveTrack } from '../../src/data/TrackResolver';
import { LargeFilePolicy, type PolicyAnswer, type PolicyQuestion } from '../../src/tools/LargeFilePolicy';
import { ToolDetector } from '../../src/tools/ToolDetector';
import type { JobContext } from '../../src/tools/jobs';
import type { RpcError } from '../../src/shared/rpc';

const ROOT = resolve(__dirname, '../..');
const FIX = join(ROOT, 'test/fixtures/generated');
const SHIMS = join(ROOT, 'test/tools/bin');
const VENV_BIN = join(ROOT, '.venv/bin');
const haveVenv = existsSync(join(VENV_BIN, 'python3'));
const usable = process.platform !== 'win32' && existsSync(join(FIX, 'small.bam')) && existsSync(join(SHIMS, 'samtools')) && (haveVenv || process.env.CI === 'true');
const env = { PATH: `${SHIMS}:${haveVenv ? `${VENV_BIN}:` : ''}${process.env.PATH ?? '/usr/bin:/bin'}` };

let work: string;
let derived: string;
let readOnlyDir: string;
const logs: string[] = [];
let savedPath: string | undefined;

beforeAll(() => {
  if (!usable) return;
  // The shims' shebang is /usr/bin/env python3: put the venv first so spawned jobs find pysam.
  savedPath = process.env.PATH;
  process.env.PATH = env.PATH;
  work = mkdtempSync(join(tmpdir(), 'igv-policy-'));
  derived = join(work, 'derived');
  readOnlyDir = join(work, 'ro');
  mkdirSync(readOnlyDir);
  for (const f of ['noindex.bam', 'unindexed_big.bed', 'small.bam', 'small.bam.bai', 'ref.fa']) copyFileSync(join(FIX, f), join(work, f));
  copyFileSync(join(FIX, 'noindex.bam'), join(readOnlyDir, 'ro.bam'));
  chmodSync(readOnlyDir, 0o555);
});
afterAll(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  if (!work) return;
  try {
    chmodSync(readOnlyDir, 0o755);
  } catch {
    // ignore
  }
  rmSync(work, { recursive: true, force: true });
});

function makePolicy(ask?: (q: PolicyQuestion) => Promise<PolicyAnswer | undefined>, settings = { unindexedMaxBytes: 1024 }) {
  const tools = new ToolDetector({ env, cacheMs: 0 });
  return new LargeFilePolicy({
    tools,
    derivedDir: () => derived,
    resolveContext: () => ({ baseDir: work, settings }),
    log: (l) => logs.push(l),
    runJob: (_title, task) => task({ log: (l) => logs.push(l), progress: () => undefined } as JobContext),
    ask,
  });
}

async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    return e as RpcError;
  }
  throw new Error('expected rejection');
}

describe.skipIf(!usable)('LargeFilePolicy with tool shims', () => {
  it('agent mode: INDEX_REQUIRED without autoIndex, samtools index with autoIndex (next to the source)', async () => {
    const policy = makePolicy();
    const err = await rejection(policy.prepare([{ path: 'noindex.bam' }], 'agent'));
    expect(err.code).toBe('INDEX_REQUIRED');
    expect((err.data as { suggestedCommand: string }).suggestedCommand).toContain('samtools index');

    const r = await policy.prepare([{ path: 'noindex.bam', autoIndex: true }], 'agent');
    expect(r.specs[0]!.index).toBe(join(work, 'noindex.bam.bai'));
    expect(statSync(join(work, 'noindex.bam.bai')).size).toBeGreaterThan(0);
    expect(r.notes[0]).toMatch(/index written to noindex.bam.bai/);
    expect(logs.some((l) => l.includes('samtools index'))).toBe(true);
    // Now the file resolves as indexed, and a second prepare reuses the index without running anything.
    expect(resolveTrack({ path: 'noindex.bam' }, { baseDir: work, settings: { unindexedMaxBytes: 1024 } }).indexed).toBe(true);
  });

  it('writes to the derived dir when the source directory is read-only and finds it again later', async () => {
    const policy = makePolicy();
    const src = join(readOnlyDir, 'ro.bam');
    const r = await policy.prepare([{ path: src, autoIndex: true }], 'agent');
    expect(r.specs[0]!.index!.startsWith(derived)).toBe(true);
    expect(existsSync(r.specs[0]!.index!)).toBe(true);
    const again = await policy.prepare([{ path: src }], 'agent');
    expect(again.specs[0]!.index).toBe(r.specs[0]!.index);
    expect(again.notes[0]).toMatch(/previously generated/);
  });

  it('sort + bgzip + tabix for oversized text, with headers kept', async () => {
    writeFileSync(join(work, 'messy.bed'), '#comment\ntrack name=x\nchrT\t500\t600\nchrS\t10\t20\nchrS\t5\t9\n');
    const policy = makePolicy(undefined, { unindexedMaxBytes: 10 });
    const r = await policy.prepare([{ path: 'messy.bed', autoIndex: true }], 'agent');
    expect(r.specs[0]).toMatchObject({ path: join(work, 'messy.bed.gz'), index: join(work, 'messy.bed.gz.tbi') });
    const gunzip = gunzipSync(readFileSync(join(work, 'messy.bed.gz'))).toString();
    expect(gunzip).toBe('#comment\nchrS\t5\t9\nchrS\t10\t20\nchrT\t500\t600\n'); // track line dropped: tabix cannot skip it
    expect(logs.some((l) => /tabix -f -p bed/.test(l))).toBe(true);
  });

  it('interactive mode: offers actions by tool availability, honours loadAnyway and cancel', async () => {
    const seen: PolicyQuestion[] = [];
    const answers: PolicyAnswer[] = [{ action: 'loadAnyway' }, { action: 'cancel' }];
    const policy = makePolicy(async (q) => {
      seen.push(q);
      return answers.shift();
    });
    copyFileSync(join(FIX, 'noindex.bam'), join(work, 'noindex2.bam'));
    const r = await policy.prepare([{ path: 'unindexed_big.bed' }, { path: 'noindex2.bam' }], 'interactive');
    expect(seen[0]!.actions).toEqual(['compressIndex', 'loadAnyway', 'cancel']);
    expect(seen[1]!.actions).toEqual(['index', 'subsample', 'loadAnyway', 'cancel']);
    expect(r.specs).toEqual([{ path: 'unindexed_big.bed', autoIndex: false, loadAnyway: true }]);
    expect(r.notes).toEqual(['noindex2.bam: skipped']);
    expect(resolveTrack(r.specs[0]!, { baseDir: work, settings: { unindexedMaxBytes: 1024 }, ignoreSizeLimit: true }).indexed).toBe(false);
  });

  it('reports missing tools instead of offering actions, and TOOL_MISSING when autoIndex needs them', async () => {
    const noTools = new LargeFilePolicy({
      tools: new ToolDetector({ env: { PATH: '/nonexistent' }, cacheMs: 0 }),
      derivedDir: () => derived,
      resolveContext: () => ({ baseDir: work, settings: { unindexedMaxBytes: 10 } }),
      log: () => undefined,
      runJob: (_t, task) => task({ log: () => undefined } as JobContext),
      ask: async (q) => {
        expect(q.actions).toEqual(['loadAnyway', 'cancel']);
        expect(q.missingTools).toEqual(['samtools']);
        return { action: 'cancel' };
      },
    });
    writeFileSync(join(work, 'another.bam'), readFileSync(join(FIX, 'noindex.bam')));
    expect((await noTools.prepare([{ path: 'another.bam' }], 'interactive')).specs).toEqual([]);
    const err = await rejection(noTools.prepare([{ path: 'another.bam', autoIndex: true }], 'agent'));
    expect(err.code).toBe('TOOL_MISSING');
    expect((err.data as { hint: string }).hint).toMatch(/samtools/);
  });

  it('subsamples a BAM into an indexed file with a descriptive name', async () => {
    const policy = makePolicy();
    const spec: TrackSpec = { path: 'small.bam', name: 'Reads', subsample: { fraction: 0.25, seed: 7 } };
    const r = await policy.prepare([spec], 'agent');
    const out = r.specs[0]!;
    expect(out.path).toBe(join(work, 'small.subsample25pct.bam'));
    expect(out.index).toBe(`${out.path}.bai`);
    expect(out.name).toBe('Reads (subsample 25%)');
    expect(out.subsample).toBeUndefined();
    expect(existsSync(out.index!)).toBe(true);
    expect(r.notes[0]).toMatch(/subsample 25%/);
    // Target read count path uses samtools view -c first.
    const r2 = await policy.prepare([{ path: 'small.bam', subsample: { reads: 200, region: 'chrT:1-50000' } }], 'agent');
    expect(r2.specs[0]!.name).toMatch(/subsample 10%/);
    expect(logs.some((l) => l.includes('view -c'))).toBe(true);
  });

  it('indexFile handles FASTA, BAM and plain text', async () => {
    const policy = makePolicy();
    writeFileSync(join(work, 'g.fa'), readFileSync(join(FIX, 'ref.fa')));
    const fa = await policy.indexFile(join(work, 'g.fa'));
    expect(fa.outputs).toEqual([join(work, 'g.fa.fai')]);
    expect(readFileSync(join(work, 'g.fa.fai'), 'utf8')).toBe(readFileSync(join(FIX, 'ref.fa.fai'), 'utf8'));
    writeFileSync(join(work, 'plain.bed'), 'chrT\t1\t2\n');
    const txt = await policy.indexFile(join(work, 'plain.bed'));
    expect(txt.outputs).toEqual([join(work, 'plain.bed.gz'), join(work, 'plain.bed.gz.tbi')]);
    expect((await rejection(policy.indexFile(join(FIX, 'coverage.bw')))).code).toBe('UNSUPPORTED_FORMAT');
  });
});
