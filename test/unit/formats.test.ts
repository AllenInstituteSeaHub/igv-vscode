import { describe, expect, it } from 'vitest';
import { baseName, indexCandidates, inferFormat, isIndexName, stripCompression } from '../../src/data/formats';

describe('inferFormat', () => {
  const cases: [string, string, string, boolean][] = [
    ['tumor.bam', 'alignment', 'bam', false],
    ['/abs/dir/Sample.CRAM', 'alignment', 'cram', false],
    ['cov.bw', 'wig', 'bigwig', false],
    ['cov.bigWig', 'wig', 'bigwig', false],
    ['x.wig', 'wig', 'wig', false],
    ['x.bedgraph', 'wig', 'bedgraph', false],
    ['x.bdg.gz', 'wig', 'bedgraph', true],
    ['x.tdf', 'wig', 'tdf', false],
    ['x.bb', 'annotation', 'bigbed', false],
    ['peaks.bed', 'annotation', 'bed', false],
    ['peaks.bed.gz', 'annotation', 'bed', true],
    ['p.narrowPeak', 'annotation', 'narrowPeak', false],
    ['p.broadPeak.gz', 'annotation', 'broadPeak', true],
    ['genes.gff3', 'annotation', 'gff3', false],
    ['genes.gff', 'annotation', 'gff', false],
    ['genes.gtf.gz', 'annotation', 'gtf', true],
    ['calls.vcf', 'variant', 'vcf', false],
    ['calls.vcf.gz', 'variant', 'vcf', true],
    ['https://host/path/calls.vcf.gz?token=abc', 'variant', 'vcf', true],
    ['cn.seg', 'seg', 'seg', false],
    ['m.maf', 'mut', 'mut', false],
    ['x.bedpe', 'interact', 'bedpe', false],
    ['x.gwas', 'gwas', 'gwas', false],
    ['x.qtl.tsv', 'qtl', 'qtl', false],
    ['x.bp', 'arc', 'bp', false],
  ];
  for (const [name, type, format, compressed] of cases) {
    it(`${name} → ${type}/${format}`, () => {
      const info = inferFormat(name);
      expect(info.kind).toBe('track');
      expect(info.type).toBe(type);
      expect(info.format).toBe(format);
      expect(info.compressed).toBe(compressed);
    });
  }

  it('classifies references and sessions', () => {
    expect(inferFormat('ref.fa')).toMatchObject({ kind: 'reference', format: 'fasta' });
    expect(inferFormat('ref.fasta.gz')).toMatchObject({ kind: 'reference', format: 'fasta', compressed: true });
    expect(inferFormat('ref.fna')).toMatchObject({ kind: 'reference' });
    expect(inferFormat('hg38.2bit')).toMatchObject({ kind: 'reference', format: '2bit', selfIndexed: true });
    expect(inferFormat('analysis.igv.json')).toMatchObject({ kind: 'session' });
  });

  it('marks SAM, XML and unknown extensions unsupported with hints', () => {
    expect(inferFormat('x.sam')).toMatchObject({ kind: 'unsupported', format: 'sam' });
    expect(inferFormat('x.sam').hint).toMatch(/samtools view -b/);
    expect(inferFormat('session.xml').kind).toBe('unsupported');
    const u = inferFormat('weird.xyz');
    expect(u.kind).toBe('unsupported');
    expect(u.hint).toMatch(/\.xyz/);
    expect(inferFormat('noext').hint).toMatch(/no extension/);
  });

  it('flags self-indexed, indexable and reference-needing formats', () => {
    expect(inferFormat('x.bw').selfIndexed).toBe(true);
    expect(inferFormat('x.bam').indexable).toBe(true);
    expect(inferFormat('x.cram').needsReference).toBe(true);
    expect(inferFormat('x.seg').indexable).toBe(false);
  });
});

describe('index discovery helpers', () => {
  it('lists BAM candidates in order', () => {
    expect(indexCandidates('/d/x.bam')).toEqual(['/d/x.bam.bai', '/d/x.bai', '/d/x.bam.csi']);
  });
  it('lists CRAM, tabix and FASTA candidates', () => {
    expect(indexCandidates('/d/x.cram')).toEqual(['/d/x.cram.crai', '/d/x.crai']);
    expect(indexCandidates('/d/x.vcf.gz')).toEqual(['/d/x.vcf.gz.tbi', '/d/x.vcf.gz.csi']);
    expect(indexCandidates('/d/x.bed.gz')).toEqual(['/d/x.bed.gz.tbi', '/d/x.bed.gz.csi']);
    expect(indexCandidates('/d/ref.fa')).toEqual(['/d/ref.fa.fai']);
    expect(indexCandidates('https://h/x.bam')).toEqual(['https://h/x.bam.bai', 'https://h/x.bai', 'https://h/x.bam.csi']);
    expect(indexCandidates('/d/x.bw')).toEqual([]);
  });
  it('recognises index names', () => {
    expect(isIndexName('x.bam.bai')).toBe(true);
    expect(isIndexName('x.vcf.gz.tbi')).toBe(true);
    expect(isIndexName('x.bam')).toBe(false);
  });
  it('baseName and stripCompression handle URLs and Windows paths', () => {
    expect(baseName('C:\\data\\X.BAM')).toBe('x.bam');
    expect(baseName('https://h/p/x.bed.gz?x=1#frag')).toBe('x.bed.gz');
    expect(stripCompression('x.bed.bgz')).toEqual(['x.bed', true]);
    expect(stripCompression('x.bed')).toEqual(['x.bed', false]);
  });
});
