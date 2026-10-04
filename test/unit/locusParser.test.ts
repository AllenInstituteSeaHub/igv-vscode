import { describe, expect, it } from 'vitest';
import { cigarReferenceLength, firstDataLine, parseLocusFromText } from '../../src/ui/locusParser';

describe('parseLocusFromText', () => {
  it('parses explicit loci with and without commas, ranges and single positions', () => {
    expect(parseLocusFromText('chr17:7,668,402-7,687,550')).toEqual({ kind: 'locus', locus: 'chr17:7,668,402-7,687,550', source: 'explicit' });
    expect(parseLocusFromText('  chr1:1000-2000  ')).toEqual({ kind: 'locus', locus: 'chr1:1,000-2,000', source: 'explicit' });
    expect(parseLocusFromText('chrX:123456')).toEqual({ kind: 'locus', locus: 'chrX:123,456', source: 'explicit' });
    expect(parseLocusFromText('NC_001133.9:1-500')).toMatchObject({ kind: 'locus', locus: 'NC_001133.9:1-500' });
    expect(parseLocusFromText('chr2:5000-1000')).toMatchObject({ locus: 'chr2:1,000-1,000' }); // end < start clamps
  });

  it('parses a VCF data line into a ±50 bp window', () => {
    const line = 'chrS\t1000000\tplanted_snp\tA\tC\t50\tPASS\tDP=47\tGT\t0/1';
    expect(parseLocusFromText(line)).toEqual({ kind: 'locus', locus: 'chrS:999,950-1,000,050', source: 'vcf' });
    expect(parseLocusFromText('chr1\t30\t.\tG\t<DEL>\t.\t.\tSVTYPE=DEL')).toMatchObject({ locus: 'chr1:1-80', source: 'vcf' });
  });

  it('parses BED lines (0-based start → 1-based)', () => {
    expect(parseLocusFromText('chrS\t999500\t1000500\tgene8\t0\t+')).toEqual({ kind: 'locus', locus: 'chrS:999,501-1,000,500', source: 'bed' });
    expect(parseLocusFromText('chr1 100 200')).toMatchObject({ locus: 'chr1:101-200', source: 'bed' });
  });

  it('parses GFF/GTF lines (columns 1, 4, 5)', () => {
    const gff = 'chrS\tfixture\tgene\t999501\t1000500\t.\t+\t.\tID=gene8;Name=gene8';
    expect(parseLocusFromText(gff)).toEqual({ kind: 'locus', locus: 'chrS:999,501-1,000,500', source: 'gff' });
    const gtf = 'chr1\tHAVANA\texon\t11869\t12227\t.\t+\t.\tgene_id "ENSG00000223972"; transcript_id "ENST00000456328";';
    expect(parseLocusFromText(gtf)).toMatchObject({ locus: 'chr1:11,869-12,227', source: 'gff' });
  });

  it('parses SAM lines (RNAME, POS, CIGAR span)', () => {
    const sam = 'read1\t0\tchrT\t1001\t60\t100M\t*\t0\t0\t' + 'A'.repeat(100) + '\t' + 'I'.repeat(100) + '\tRG:Z:rg1';
    expect(parseLocusFromText(sam)).toEqual({ kind: 'locus', locus: 'chrT:1,001-1,100', source: 'sam' });
    const spliced = 'r\t16\tchr1\t100\t255\t10M500N10M\t*\t0\t0\tACGTACGTACGTACGTACGT\t*';
    expect(parseLocusFromText(spliced)).toMatchObject({ locus: 'chr1:100-619' });
  });

  it('treats a bare name as a search term', () => {
    expect(parseLocusFromText('TP53')).toEqual({ kind: 'search', term: 'TP53' });
    expect(parseLocusFromText('  BRCA1 ')).toEqual({ kind: 'search', term: 'BRCA1' });
    expect(parseLocusFromText('gene8')).toEqual({ kind: 'search', term: 'gene8' });
  });

  it('skips comment and header lines and reports unparseable input', () => {
    expect(firstDataLine('#comment\n\n@SQ\tSN:chr1\nchr1:1-10\n')).toBe('chr1:1-10');
    expect(parseLocusFromText('##fileformat=VCFv4.2\n#CHROM\tPOS\nchr1\t500\t.\tA\tT\t.\t.\t.')).toMatchObject({ source: 'vcf' });
    expect(parseLocusFromText('   \n# only comments')).toMatchObject({ kind: 'none' });
    expect(parseLocusFromText('this is not a locus at all')).toMatchObject({ kind: 'none' });
    expect(parseLocusFromText('12345')).toMatchObject({ kind: 'none' });
  });

  it('cigarReferenceLength handles M/D/N/=/X and ignores I/S/H', () => {
    expect(cigarReferenceLength('100M')).toBe(100);
    expect(cigarReferenceLength('5S90M5S')).toBe(90);
    expect(cigarReferenceLength('10M2I10M3D10M')).toBe(33);
    expect(cigarReferenceLength('*')).toBe(0);
    expect(cigarReferenceLength('garbage')).toBe(0);
  });
});
