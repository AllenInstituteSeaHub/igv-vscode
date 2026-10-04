import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareSequenceNames, normalizeChromName, readFirstBamRecord, readSequenceNames, suggestInitialLocus } from '../../src/data/sequenceNames';

const FIX = resolve(__dirname, '../../test/fixtures/generated');
const have = existsSync(join(FIX, 'small.bam'));

describe('compareSequenceNames', () => {
  it('matches modulo chr prefix and case', () => {
    expect(normalizeChromName('chr1')).toBe('1');
    expect(normalizeChromName('chrM')).toBe('m');
    expect(normalizeChromName('MT')).toBe('m');
    expect(compareSequenceNames(['1', '2', 'X', 'MT'], ['chr1', 'chr2', 'chrX', 'chrM'])).toEqual({ matched: ['1', '2', 'X', 'MT'], unmatched: [] });
    expect(compareSequenceNames(['chrS', 'chrT'], ['chr1', 'chr2'])).toEqual({ matched: [], unmatched: ['chrS', 'chrT'] });
  });
});

describe.skipIf(!have)('readSequenceNames on fixtures', () => {
  it('reads BAM references with lengths from the BGZF header', async () => {
    const r = await readSequenceNames(join(FIX, 'small.bam'));
    expect(r?.names).toEqual(['chrS', 'chrT']);
    expect(r?.lengths?.get('chrS')).toBe(5_000_000);
    expect(r?.lengths?.get('chrT')).toBe(50_000);
    const big = await readSequenceNames(join(FIX, 'large.bam'));
    expect(big?.names).toEqual(['chrS', 'chrT']);
  });
  it('reads bigWig chromosome tree', async () => {
    const r = await readSequenceNames(join(FIX, 'coverage.bw'));
    expect([...(r?.names ?? [])].sort()).toEqual(['chrS', 'chrT']);
    expect(r?.lengths?.get('chrT')).toBe(50_000);
  });
  it('reads tabix names and plain text chromosomes', async () => {
    expect((await readSequenceNames(join(FIX, 'variants.vcf.gz'), join(FIX, 'variants.vcf.gz.tbi')))?.names).toEqual(['chrS']);
    expect((await readSequenceNames(join(FIX, 'variants.vcf.gz')))?.names).toEqual(['chrS']); // falls back to reading the text
    expect((await readSequenceNames(join(FIX, 'genes.bed')))?.names.sort()).toEqual(['chrS', 'chrT']);
    expect((await readSequenceNames(join(FIX, 'genes.gff3')))?.names.sort()).toEqual(['chrS', 'chrT']);
  });
  it('suggests an initial locus where the file has data, only on genome chromosomes', async () => {
    const first = await readFirstBamRecord(join(FIX, 'small.bam'));
    expect(first?.chr).toBe('chrT');
    expect(first?.length).toBe(50_000);
    const bam = await suggestInitialLocus(join(FIX, 'small.bam'), ['chrS', 'chrT']);
    expect(bam).toMatch(/^chrT:[\d,]+-[\d,]+$/);
    expect(await suggestInitialLocus(join(FIX, 'large.bam'), ['chrS', 'chrT'])).toMatch(/^chrS:/);
    expect(await suggestInitialLocus(join(FIX, 'small.bam'), ['chr1', 'chr2'])).toBeUndefined();
    expect(await suggestInitialLocus(join(FIX, 'genes.bed'), ['chrS', 'chrT'])).toMatch(/^chr[ST]:/);
    expect(await suggestInitialLocus(join(FIX, 'variants.vcf.gz'), ['chrS'])).toMatch(/^chrS:/);
    expect(await suggestInitialLocus(join(FIX, 'coverage.bw'), ['chrT'])).toMatch(/^chrT:1-20,000$/);
    expect(await suggestInitialLocus(join(FIX, 'MANIFEST.json'), ['chrS'])).toBeUndefined();
  });

  it('returns undefined for formats it does not understand', async () => {
    expect(await readSequenceNames(join(FIX, 'MANIFEST.json'))).toBeUndefined();
    expect(await readSequenceNames(join(FIX, 'nope.bam'))).toBeUndefined();
  });
});
