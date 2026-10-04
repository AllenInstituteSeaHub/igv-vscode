/**
 * Turn an editor selection (or current line) into a locus (spec §8.2).
 * Tries, in order: explicit locus, VCF data line, BED-like, GFF/GTF, SAM,
 * bare gene or feature name. Pure function; unit tested.
 */

export type ParsedLocus =
  | { kind: 'locus'; locus: string; source: 'explicit' | 'vcf' | 'bed' | 'gff' | 'sam' }
  | { kind: 'search'; term: string }
  | { kind: 'none'; reason: string };

const CHR = String.raw`[A-Za-z0-9_.\-|]+`;
const EXPLICIT = new RegExp(String.raw`^(${CHR}):\s*([\d,]+)\s*(?:-\s*([\d,]+))?$`);
const INT = /^\d+$/;
const REF_BASES = /^[ACGTNacgtn]+$/;
/** ALT: bases, symbolic (<DEL>), breakends (N[chr2:321682[), '*' or '.', comma-separated. */
const ALT_ALLELE = /^[A-Za-z0-9.*,<>[\]:_-]+$/;
const GENE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export const VCF_WINDOW_BP = 50;

function num(s: string): number {
  return Number(s.replace(/,/g, ''));
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function locus(chr: string, start1: number, end1: number): string {
  const s = Math.max(1, Math.min(start1, end1));
  const e = Math.max(s, end1);
  return `${chr}:${fmt(s)}-${fmt(e)}`;
}

/** First non-empty, non-comment line of a selection. */
export function firstDataLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('@') || line.startsWith('track ') || line.startsWith('browser ')) continue;
    return line;
  }
  return undefined;
}

export function parseLocusFromText(text: string): ParsedLocus {
  const line = firstDataLine(text);
  if (!line) return { kind: 'none', reason: 'The selection has no data line (only blank or comment lines).' };

  const explicit = EXPLICIT.exec(line);
  if (explicit) {
    const chr = explicit[1]!;
    const start = num(explicit[2]!);
    if (explicit[3] === undefined) return { kind: 'locus', locus: `${chr}:${fmt(start)}`, source: 'explicit' };
    return { kind: 'locus', locus: locus(chr, start, num(explicit[3])), source: 'explicit' };
  }

  const tabs = line.split('\t');
  const cols = tabs.length >= 3 ? tabs : line.split(/\s+/);

  // VCF: CHROM POS ID REF ALT QUAL FILTER INFO (≥8 columns), POS integer, REF/ALT base-like.
  if (cols.length >= 8 && INT.test(cols[1]!) && REF_BASES.test(cols[3]!) && ALT_ALLELE.test(cols[4]!)) {
    const pos = Number(cols[1]);
    return { kind: 'locus', locus: locus(cols[0]!, pos - VCF_WINDOW_BP, pos + VCF_WINDOW_BP), source: 'vcf' };
  }

  // BED-like: chrom start end (0-based half-open start).
  if (cols.length >= 3 && INT.test(cols[1]!) && INT.test(cols[2]!) && Number(cols[1]) <= Number(cols[2])) {
    return { kind: 'locus', locus: locus(cols[0]!, Number(cols[1]) + 1, Number(cols[2])), source: 'bed' };
  }

  // GFF/GTF: seqid source type start end score strand phase attributes (≥8 columns; 1-based inclusive).
  if (cols.length >= 8 && INT.test(cols[3]!) && INT.test(cols[4]!) && !INT.test(cols[1]!)) {
    return { kind: 'locus', locus: locus(cols[0]!, Number(cols[3]), Number(cols[4])), source: 'gff' };
  }

  // SAM: QNAME FLAG RNAME POS MAPQ CIGAR … (≥11 columns).
  if (cols.length >= 11 && INT.test(cols[1]!) && cols[2] !== '*' && INT.test(cols[3]!)) {
    const pos = Number(cols[3]);
    const len = cigarReferenceLength(cols[5]!) || (cols[9] && cols[9] !== '*' ? cols[9].length : 100);
    return { kind: 'locus', locus: locus(cols[2]!, pos, pos + len - 1), source: 'sam' };
  }

  // Bare gene / feature name.
  if (cols.length === 1 && GENE.test(line)) return { kind: 'search', term: line };

  return { kind: 'none', reason: `Could not parse a locus from "${line.length > 80 ? `${line.slice(0, 77)}…` : line}".` };
}

/** Reference-consuming length of a CIGAR string (M, D, N, =, X). 0 when unparseable or "*". */
export function cigarReferenceLength(cigar: string): number {
  if (!cigar || cigar === '*') return 0;
  let total = 0;
  let valid = false;
  for (const m of cigar.matchAll(/(\d+)([MIDNSHP=X])/g)) {
    valid = true;
    if ('MDN=X'.includes(m[2]!)) total += Number(m[1]);
  }
  return valid && cigar.replace(/\d+[MIDNSHP=X]/g, '') === '' ? total : 0;
}
