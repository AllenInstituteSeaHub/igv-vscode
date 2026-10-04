/**
 * Track type inference from file names (spec §9) and index discovery
 * candidates (spec §4.4). Pure functions, no I/O.
 */

export type ResourceKind = 'track' | 'reference' | 'session' | 'unsupported';

export interface FormatInfo {
  kind: ResourceKind;
  /** igv track type, e.g. "alignment". Empty for non-tracks. */
  type: string;
  /** igv format, e.g. "bam". */
  format: string;
  /** True when the name ends in .gz/.bgz. */
  compressed: boolean;
  /** Whether this format is a binary container that is always internally indexed (bigWig, bigBed, TDF). */
  selfIndexed: boolean;
  /** Whether igv requires an external index for this format to stream (BAM/CRAM) or benefits from tabix (text). */
  indexable: boolean;
  /** Formats that need a reference sequence (CRAM). */
  needsReference: boolean;
  /** For unsupported extensions, a hint for the user. */
  hint?: string;
}

interface Rule {
  exts: string[];
  info: Omit<FormatInfo, 'compressed'>;
}

const base = (kind: ResourceKind, type: string, format: string, extra: Partial<FormatInfo> = {}): Omit<FormatInfo, 'compressed'> => ({
  kind,
  type,
  format,
  selfIndexed: false,
  indexable: false,
  needsReference: false,
  ...extra,
});

const RULES: Rule[] = [
  { exts: ['.igv.json'], info: base('session', '', 'igv-session') },
  { exts: ['.bam'], info: base('track', 'alignment', 'bam', { indexable: true }) },
  { exts: ['.cram'], info: base('track', 'alignment', 'cram', { indexable: true, needsReference: true }) },
  {
    exts: ['.sam'],
    info: base('unsupported', 'alignment', 'sam', {
      hint: 'igv.js does not read SAM text. Convert and index it: samtools view -b -o X.bam X.sam && samtools index X.bam',
    }),
  },
  { exts: ['.bw', '.bigwig'], info: base('track', 'wig', 'bigwig', { selfIndexed: true }) },
  { exts: ['.wig'], info: base('track', 'wig', 'wig') },
  { exts: ['.bedgraph', '.bdg'], info: base('track', 'wig', 'bedgraph', { indexable: true }) },
  { exts: ['.tdf'], info: base('track', 'wig', 'tdf', { selfIndexed: true }) },
  { exts: ['.bb', '.bigbed'], info: base('track', 'annotation', 'bigbed', { selfIndexed: true }) },
  { exts: ['.bed'], info: base('track', 'annotation', 'bed', { indexable: true }) },
  { exts: ['.narrowpeak'], info: base('track', 'annotation', 'narrowPeak', { indexable: true }) },
  { exts: ['.broadpeak'], info: base('track', 'annotation', 'broadPeak', { indexable: true }) },
  { exts: ['.gff3'], info: base('track', 'annotation', 'gff3', { indexable: true }) },
  { exts: ['.gff'], info: base('track', 'annotation', 'gff', { indexable: true }) },
  { exts: ['.gtf'], info: base('track', 'annotation', 'gtf', { indexable: true }) },
  { exts: ['.vcf'], info: base('track', 'variant', 'vcf', { indexable: true }) },
  { exts: ['.seg'], info: base('track', 'seg', 'seg') },
  { exts: ['.maf', '.mut'], info: base('track', 'mut', 'mut') },
  { exts: ['.bedpe'], info: base('track', 'interact', 'bedpe') },
  { exts: ['.interact'], info: base('track', 'interact', 'interact') },
  { exts: ['.gwas'], info: base('track', 'gwas', 'gwas') },
  { exts: ['.qtl.tsv', '.qtl'], info: base('track', 'qtl', 'qtl') },
  { exts: ['.bp'], info: base('track', 'arc', 'bp') },
  { exts: ['.fa', '.fasta', '.fna'], info: base('reference', '', 'fasta', { indexable: true }) },
  { exts: ['.2bit'], info: base('reference', '', '2bit', { selfIndexed: true }) },
  { exts: ['.xml'], info: base('unsupported', '', 'xml', { hint: 'IGV desktop XML sessions are not supported yet. Use an .igv.json session.' }) },
];

const COMPRESSED_EXTS = ['.gz', '.bgz'];

/** Lower-cased basename of a path or URL, with any query string removed. */
export function baseName(pathOrUrl: string): string {
  let s = pathOrUrl;
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return (idx >= 0 ? s.slice(idx + 1) : s).toLowerCase();
}

/** Strips a trailing .gz/.bgz. Returns [name, wasCompressed]. */
export function stripCompression(name: string): [string, boolean] {
  for (const ext of COMPRESSED_EXTS) {
    if (name.endsWith(ext)) return [name.slice(0, -ext.length), true];
  }
  return [name, false];
}

export function inferFormat(pathOrUrl: string): FormatInfo {
  const [name, compressed] = stripCompression(baseName(pathOrUrl));
  for (const rule of RULES) {
    for (const ext of rule.exts) {
      if (name.endsWith(ext)) return { ...rule.info, compressed };
    }
  }
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  return {
    kind: 'unsupported',
    type: '',
    format: ext.replace(/^\./, ''),
    compressed,
    selfIndexed: false,
    indexable: false,
    needsReference: false,
    hint: ext
      ? `Unknown file extension "${ext}". Pass "type" and "format" explicitly if igv.js supports this format.`
      : 'The file has no extension. Pass "type" and "format" explicitly.',
  };
}

/**
 * Index file candidates for a data file, in preference order (spec §4.4).
 * Works for paths and URLs since only string suffixes are involved.
 */
export function indexCandidates(pathOrUrl: string): string[] {
  const lower = baseName(pathOrUrl);
  const withoutExt = (ext: string) => pathOrUrl.slice(0, pathOrUrl.length - ext.length);
  if (lower.endsWith('.bam')) return [`${pathOrUrl}.bai`, `${withoutExt('.bam')}.bai`, `${pathOrUrl}.csi`];
  if (lower.endsWith('.cram')) return [`${pathOrUrl}.crai`, `${withoutExt('.cram')}.crai`];
  if (lower.endsWith('.gz') || lower.endsWith('.bgz')) return [`${pathOrUrl}.tbi`, `${pathOrUrl}.csi`];
  for (const ext of ['.fa', '.fasta', '.fna']) {
    if (lower.endsWith(ext)) return [`${pathOrUrl}.fai`];
  }
  return [];
}

/** Does this index file name belong to an index that igv reads whole (bai, tbi, csi, crai, fai)? */
export function isIndexName(pathOrUrl: string): boolean {
  const n = baseName(pathOrUrl);
  return ['.bai', '.csi', '.tbi', '.crai', '.fai', '.gzi'].some((e) => n.endsWith(e));
}

/** All data-file extensions we open from the Explorer, used for menus and custom editor selectors. */
export const DEFAULT_PRIORITY_EXTENSIONS = ['bam', 'cram', 'bw', 'bigwig', 'bb', 'bigbed', 'tdf', '2bit'];
export const OPTION_PRIORITY_EXTENSIONS = [
  'vcf.gz', 'bed', 'bed.gz', 'gff', 'gff3', 'gtf', 'gff.gz', 'gff3.gz', 'gtf.gz', 'bedgraph', 'bedgraph.gz', 'wig', 'vcf', 'fa', 'fasta', 'fna',
  'seg', 'maf', 'bedpe', 'narrowpeak', 'broadpeak',
];
