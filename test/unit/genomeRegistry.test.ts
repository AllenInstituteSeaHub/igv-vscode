import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as nodeFs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GenomeRegistry, parseGenomeList, type GenomeDefaultsStore } from '../../src/genome/GenomeRegistry';

const isWindows = process.platform === 'win32';

function memoryStore(initial: { def?: string; recent?: string[] } = {}): GenomeDefaultsStore & { state: { def?: string; recent: string[] } } {
  const state = { def: initial.def, recent: initial.recent ?? [] };
  return {
    state,
    getDefaultGenome: () => state.def,
    setDefaultGenome: async (id) => { state.def = id; },
    getRecent: () => state.recent,
    setRecent: async (ids) => { state.recent = ids; },
  };
}

const sample = [
  { id: 'hg38', name: 'Human (GRCh38/hg38)', fastaURL: 'https://example.org/hg38.fa', indexURL: 'https://example.org/hg38.fa.fai' },
  { id: 'mm10', name: 'Mouse (GRCm38/mm10)', twoBitURL: 'https://example.org/mm10.2bit' },
  { id: 'sacCer3', name: 'S. cerevisiae (sacCer3)', description: "baker's yeast" },
];

describe('parseGenomeList', () => {
  it('parses an array of entries with ids and drops junk', () => {
    const list = parseGenomeList(JSON.stringify([...sample, { name: 'no id' }, 42]));
    expect(list.map((g) => g.id)).toEqual(['hg38', 'mm10', 'sacCer3']);
  });
  it('rejects invalid JSON and non-arrays', () => {
    expect(() => parseGenomeList('{')).toThrow(/not valid JSON/);
    expect(() => parseGenomeList('{"id":"x"}')).toThrow(/array/);
  });
  it('parses the real bundled list', () => {
    const list = parseGenomeList(readFileSync(join(__dirname, '../../media/genomes.json'), 'utf8'));
    expect(list.length).toBeGreaterThan(10);
    expect(list.some((g) => g.id === 'hg38')).toBe(true);
    expect(list.some((g) => g.id === 'hg19')).toBe(true);
  });
});

describe('GenomeRegistry', () => {
  it('lists and filters genomes', () => {
    const r = new GenomeRegistry(sample, memoryStore());
    expect(r.list().map((g) => g.id)).toEqual(['hg38', 'mm10', 'sacCer3']);
    expect(r.list('mouse').map((g) => g.id)).toEqual(['mm10']);
    expect(r.list('CER').map((g) => g.id)).toEqual(['sacCer3']);
    expect(r.list()[2]).toMatchObject({ source: 'bundled-list', description: "baker's yeast" });
  });

  it('resolves by id (case-insensitive) and by name, returning a copy of the reference', () => {
    const r = new GenomeRegistry(sample, memoryStore());
    const g = r.resolve('HG38');
    expect(g.id).toBe('hg38');
    expect(g.source).toBe('bundled-list');
    expect(g.reference.fastaURL).toBe('https://example.org/hg38.fa');
    g.reference.fastaURL = 'mutated';
    expect(r.resolve('hg38').reference.fastaURL).toBe('https://example.org/hg38.fa');
    expect(r.resolve('Mouse (GRCm38/mm10)').id).toBe('mm10');
  });

  it('throws GENOME_NOT_FOUND with suggestions', () => {
    const r = new GenomeRegistry(sample, memoryStore());
    try {
      r.resolve('hg3');
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'GENOME_NOT_FOUND' });
      expect((err as { data: { suggestions: string[] } }).data.suggestions).toEqual(['hg38']);
    }
    expect(() => r.resolve('zzz')).toThrow(/Unknown genome "zzz"/);
  });

  it('igvGenomeList returns independent copies', () => {
    const r = new GenomeRegistry(sample, memoryStore());
    const list = r.igvGenomeList();
    expect(list).toHaveLength(3);
    list[0]!.id = 'changed';
    expect(r.igvGenomeList()[0]!.id).toBe('hg38');
  });

  it('tracks default and recent genomes through the store', async () => {
    const store = memoryStore({ recent: ['mm10', 'unknownGenome'] });
    const r = new GenomeRegistry(sample, store);
    expect(r.getDefaultGenomeId()).toBeUndefined();
    await r.setDefaultGenomeId('hg38');
    expect(r.getDefaultGenomeId()).toBe('hg38');
    expect(r.getRecentIds()).toEqual(['mm10']);
    await r.markUsed('hg38');
    await r.markUsed('mm10');
    expect(store.state.recent).toEqual(['mm10', 'hg38', 'unknownGenome']);
    expect(r.getRecentIds()).toEqual(['mm10', 'hg38']);
  });

  it('treats a blank default as unset', () => {
    const r = new GenomeRegistry(sample, memoryStore({ def: '  ' }));
    expect(r.getDefaultGenomeId()).toBeUndefined();
  });
});

describe.skipIf(isWindows)('GenomeRegistry: custom and local references', () => {
  const fakeFs = (files: Record<string, number>) =>
    ({
      existsSync: (p: string) => p in files,
      statSync: (p: string) => {
        if (!(p in files)) throw new Error('ENOENT');
        return { size: files[p]! } as unknown as nodeFs.Stats;
      },
    }) as unknown as Pick<typeof nodeFs, 'existsSync' | 'statSync'>;

  it('adds custom genomes with local path markers and discovers the .fai', () => {
    const fs = fakeFs({ '/ws/ref/mine.fa': 100, '/ws/ref/mine.fa.fai': 10, '/ws/ann.bed': 5 });
    const r = new GenomeRegistry(sample, memoryStore(), fs);
    r.setCustomGenomes(
      [
        { id: 'mine', name: 'My genome', fastaPath: 'ref/mine.fa', tracks: [{ path: 'ann.bed', name: 'Genes' }] },
        { id: 'remote', fastaURL: 'https://x/y.fa', indexURL: 'https://x/y.fa.fai' },
        { id: 'broken' },
        { notAnId: true },
      ],
      '/ws',
    );
    expect(r.customProblems).toEqual([
      'igv.genomes.custom[2] (broken): needs fastaPath/fastaURL or twoBitPath/twoBitURL',
      'igv.genomes.custom[3]: missing "id"',
    ]);
    expect(r.list().slice(0, 2).map((g) => [g.id, g.source])).toEqual([['mine', 'custom'], ['remote', 'custom']]);
    const g = r.resolve('mine');
    expect(g.source).toBe('custom');
    expect(g.reference.fastaURL).toEqual({ __igvVscodeLocalPath: '/ws/ref/mine.fa' });
    expect(g.reference.indexURL).toEqual({ __igvVscodeLocalPath: '/ws/ref/mine.fa.fai' });
    expect(r.tracksFor('mine')).toEqual([{ path: '/ws/ann.bed', name: 'Genes' }]);
    expect(r.resolve('remote').reference.fastaURL).toBe('https://x/y.fa');
    // igvGenomeList never includes custom entries (they may carry local paths).
    expect(r.igvGenomeList().some((x) => x.id === 'mine')).toBe(false);
  });

  it('builds an ad-hoc genome from a local FASTA, 2bit, and enforces the unindexed limit', () => {
    const big = 11 * 1024 * 1024;
    const fs = fakeFs({ '/d/a.fa': 100, '/d/a.fa.fai': 1, '/d/small.fasta': 100, '/d/big.fa': big, '/d/g.2bit': 50, '/d/g.2bit.bpt': 5, '/d/z.fa.gz': 10 });
    const r = new GenomeRegistry(sample, memoryStore(), fs);
    expect(r.fromLocalFile('/d/a.fa')).toMatchObject({
      id: 'a', source: 'local-file',
      reference: { id: 'a', name: 'a.fa', fastaURL: { __igvVscodeLocalPath: '/d/a.fa' }, indexURL: { __igvVscodeLocalPath: '/d/a.fa.fai' } },
    });
    expect(r.fromLocalFile('/d/small.fasta').reference.indexed).toBe(false);
    expect(() => r.fromLocalFile('/d/big.fa')).toThrow(/no \.fai index/);
    expect(r.fromLocalFile('/d/g.2bit').reference).toMatchObject({ twoBitURL: { __igvVscodeLocalPath: '/d/g.2bit' }, twoBitBptURL: { __igvVscodeLocalPath: '/d/g.2bit.bpt' } });
    expect(() => r.fromLocalFile('/d/z.fa.gz')).toThrow(/\.fai and \.gzi/);
    expect(() => r.fromLocalFile('/d/x.bam')).toThrow(/not a FASTA/);
    expect(() => r.fromLocalFile('/d/missing.fa')).toThrow(/not found/);
  });

  it('resolve() accepts paths relative to baseDir and still reports GENOME_NOT_FOUND for junk', () => {
    const fs = fakeFs({ '/ws/ref.fa': 100, '/ws/ref.fa.fai': 1 });
    const r = new GenomeRegistry(sample, memoryStore(), fs);
    expect(r.resolve('ref.fa', '/ws').source).toBe('local-file');
    expect(r.resolve('./ref.fa', '/ws').id).toBe('ref');
    expect(() => r.resolve('missing.fa', '/ws')).toThrow(/Reference file not found/);
    expect(() => r.resolve('nothing', '/ws')).toThrow(/Unknown genome/);
  });
});
