/**
 * Read the sequence (chromosome) names a data file refers to, without igv,
 * for the genome mismatch check (spec §7). Reads only the bytes needed:
 *  - BAM: BGZF blocks from the start until the header's reference list is complete
 *  - bgzipped text + .tbi: the tabix index's name list
 *  - bigWig/bigBed: the chromosome B+ tree
 *  - plain text (BED, GFF, VCF, bedGraph, WIG, SEG): first data lines
 * Returns undefined when the format is not understood; callers then skip the check.
 */
import * as fs from 'node:fs/promises';
import * as zlib from 'node:zlib';
import { inferFormat } from './formats';
import type { RemoteProxy } from './RemoteProxy';

/** Random-access bytes: a local file or a remote URL through the proxy. */
export interface ByteSource {
  read(start: number, end: number): Promise<Buffer>;
  size(): Promise<number>;
  close(): Promise<void>;
}

export async function fileSource(absPath: string): Promise<ByteSource> {
  const fh = await fs.open(absPath, 'r');
  let size: number | undefined;
  return {
    async read(start, end) {
      const len = Math.max(0, end - start);
      const buf = Buffer.alloc(len);
      let off = 0;
      while (off < len) {
        const { bytesRead } = await fh.read(buf, off, len - off, start + off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return buf.subarray(0, off);
    },
    async size() {
      if (size === undefined) size = (await fh.stat()).size;
      return size;
    },
    close: () => fh.close(),
  };
}

export function urlSource(url: string, proxy: RemoteProxy): ByteSource {
  return {
    async read(start, end) {
      const u8 = await proxy.read(url, start, end);
      return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
    },
    async size() {
      return (await proxy.stat(url)).size ?? 0;
    },
    close: async () => undefined,
  };
}

export interface SequenceInfo {
  names: string[];
  /** Lengths when the format provides them (BAM, bigWig). */
  lengths?: Map<string, number>;
}

const MAX_HEADER_BYTES = 8 * 1024 * 1024;

export async function readSequenceNames(absPath: string, indexPath?: string): Promise<SequenceInfo | undefined> {
  let src: ByteSource | undefined;
  let idx: ByteSource | undefined;
  try {
    src = await fileSource(absPath);
    if (indexPath && /\.tbi$/i.test(indexPath)) idx = await fileSource(indexPath);
    return await readSequenceNamesFrom(src, inferFormat(absPath), idx);
  } catch {
    return undefined;
  } finally {
    await src?.close();
    await idx?.close();
  }
}

/** Same as readSequenceNames for a remote URL, reading through the proxy (a few KB). */
export async function readSequenceNamesRemote(url: string, proxy: RemoteProxy, indexUrl?: string): Promise<SequenceInfo | undefined> {
  try {
    const idx = indexUrl && /\.tbi$/i.test(indexUrl) ? urlSource(indexUrl, proxy) : undefined;
    return await readSequenceNamesFrom(urlSource(url, proxy), inferFormat(url), idx);
  } catch {
    return undefined;
  }
}

export async function readSequenceNamesFrom(src: ByteSource, info: ReturnType<typeof inferFormat>, index?: ByteSource): Promise<SequenceInfo | undefined> {
  if (info.format === 'bam') return readBamReferencesFrom(src);
  if (info.format === 'bigwig' || info.format === 'bigbed') return readBigChromTreeFrom(src);
  if (info.compressed) {
    if (index) return readTabixNamesFrom(index);
    return readTextChromsFrom(src, true);
  }
  if (['bed', 'gff', 'gff3', 'gtf', 'vcf', 'bedgraph', 'narrowPeak', 'broadPeak', 'seg', 'wig'].includes(info.format)) {
    return readTextChromsFrom(src, false);
  }
  return undefined;
}

// ---- BGZF ------------------------------------------------------------------

async function readPrefix(absPath: string, bytes: number): Promise<Buffer> {
  const src = await fileSource(absPath);
  try {
    return await readPrefixFrom(src, bytes);
  } finally {
    await src.close();
  }
}

async function readPrefixFrom(src: ByteSource, bytes: number): Promise<Buffer> {
  const size = await src.size();
  return src.read(0, Math.min(bytes, size || bytes));
}

/** Inflate consecutive BGZF (gzip member) blocks from the start of `buf` until `wanted` bytes are available or data ends. */
export function inflateBgzf(buf: Buffer, wanted: number): Buffer {
  const out: Buffer[] = [];
  let total = 0;
  let pos = 0;
  while (pos + 18 <= buf.length && total < wanted) {
    if (buf[pos] !== 0x1f || buf[pos + 1] !== 0x8b) break;
    const xlen = buf.readUInt16LE(pos + 10);
    // Find BSIZE in the extra field.
    let bsize = -1;
    let p = pos + 12;
    const xend = p + xlen;
    while (p + 4 <= xend) {
      const si1 = buf[p]!, si2 = buf[p + 1]!, slen = buf.readUInt16LE(p + 2);
      if (si1 === 66 && si2 === 67 && slen === 2) bsize = buf.readUInt16LE(p + 4);
      p += 4 + slen;
    }
    if (bsize < 0) break;
    const blockEnd = pos + bsize + 1;
    if (blockEnd > buf.length) break;
    const inflated = zlib.gunzipSync(buf.subarray(pos, blockEnd));
    out.push(inflated);
    total += inflated.length;
    pos = blockEnd;
  }
  return Buffer.concat(out);
}

export async function readBamReferences(absPath: string): Promise<SequenceInfo> {
  const src = await fileSource(absPath);
  try {
    return await readBamReferencesFrom(src);
  } finally {
    await src.close();
  }
}

export async function readBamReferencesFrom(src: ByteSource): Promise<SequenceInfo> {
  let size = 64 * 1024;
  for (;;) {
    const raw = await readPrefixFrom(src, size);
    const data = inflateBgzf(raw, Number.MAX_SAFE_INTEGER);
    const parsed = parseBamHeader(data);
    if (parsed) return parsed;
    if (raw.length < size || size >= MAX_HEADER_BYTES) throw new Error('BAM header incomplete');
    size *= 4;
  }
}

function parseBamHeader(d: Buffer): SequenceInfo | undefined {
  if (d.length < 12 || d.toString('latin1', 0, 4) !== 'BAM\u0001') return undefined;
  const lText = d.readInt32LE(4);
  let p = 8 + lText;
  if (p + 4 > d.length) return undefined;
  const nRef = d.readInt32LE(p);
  p += 4;
  const names: string[] = [];
  const lengths = new Map<string, number>();
  for (let i = 0; i < nRef; i++) {
    if (p + 4 > d.length) return undefined;
    const lName = d.readInt32LE(p);
    p += 4;
    if (p + lName + 4 > d.length) return undefined;
    const name = d.toString('utf8', p, p + lName - 1);
    p += lName;
    const len = d.readInt32LE(p);
    p += 4;
    names.push(name);
    lengths.set(name, len);
  }
  return { names, lengths };
}

// ---- tabix -----------------------------------------------------------------

export async function readTabixNames(indexPath: string): Promise<SequenceInfo> {
  const src = await fileSource(indexPath);
  try {
    return await readTabixNamesFrom(src);
  } finally {
    await src.close();
  }
}

export async function readTabixNamesFrom(src: ByteSource): Promise<SequenceInfo> {
  const raw = await src.read(0, await src.size());
  const d = inflateBgzf(raw, Number.MAX_SAFE_INTEGER);
  if (d.toString('latin1', 0, 4) !== 'TBI\u0001') throw new Error('not a tabix index');
  const lNm = d.readInt32LE(32);
  const namesBlob = d.toString('utf8', 36, 36 + lNm);
  return { names: namesBlob.split('\u0000').filter((n) => n.length > 0) };
}

// ---- bigWig / bigBed ---------------------------------------------------------

export async function readBigChromTree(absPath: string): Promise<SequenceInfo> {
  const src = await fileSource(absPath);
  try {
    return await readBigChromTreeFrom(src);
  } finally {
    await src.close();
  }
}

export async function readBigChromTreeFrom(src: ByteSource): Promise<SequenceInfo> {
  {
    const head = await src.read(0, 64);
    const magicLE = head.readUInt32LE(0);
    const le = magicLE === 0x888ffc26 || magicLE === 0x8789f2eb;
    const be = head.readUInt32BE(0) === 0x888ffc26 || head.readUInt32BE(0) === 0x8789f2eb;
    if (!le && !be) throw new Error('not a bigWig/bigBed');
    const u32 = (b: Buffer, o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const u64 = (b: Buffer, o: number) => Number(le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o));
    const chromTreeOffset = u64(head, 8);
    const treeHead = await src.read(chromTreeOffset, chromTreeOffset + 32);
    const keySize = u32(treeHead, 8);
    const valSize = u32(treeHead, 12);
    const names: string[] = [];
    const lengths = new Map<string, number>();
    const visit = async (offset: number): Promise<void> => {
      const nh = await src.read(offset, offset + 4);
      const isLeaf = nh[0] === 1;
      const count = le ? nh.readUInt16LE(2) : nh.readUInt16BE(2);
      const itemSize = isLeaf ? keySize + valSize : keySize + 8;
      const items = await src.read(offset + 4, offset + 4 + count * itemSize);
      for (let i = 0; i < count; i++) {
        const base = i * itemSize;
        if (isLeaf) {
          const name = items.toString('latin1', base, base + keySize).split('\u0000')[0] ?? '';
          const size = u32(items, base + keySize + 4);
          names.push(name);
          lengths.set(name, size);
        } else {
          await visit(u64(items, base + keySize));
        }
      }
    };
    await visit(chromTreeOffset + 32);
    return { names, lengths };
  }
}

// ---- plain text --------------------------------------------------------------

export async function readTextChroms(absPath: string, compressed: boolean): Promise<SequenceInfo> {
  const src = await fileSource(absPath);
  try {
    return await readTextChromsFrom(src, compressed);
  } finally {
    await src.close();
  }
}

export async function readTextChromsFrom(src: ByteSource, compressed: boolean): Promise<SequenceInfo> {
  const raw = await readPrefixFrom(src, 256 * 1024);
  const text = (compressed ? inflateBgzf(raw, 256 * 1024) : raw).toString('utf8');
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('track') || line.startsWith('browser')) continue;
    if (line.startsWith('variableStep') || line.startsWith('fixedStep')) {
      const m = /chrom=(\S+)/.exec(line);
      if (m) names.add(m[1]!);
      continue;
    }
    const col = line.split(/\t| +/)[0];
    if (col && !/^\d+$/.test(col)) names.add(col);
    if (names.size >= 50) break;
  }
  return { names: [...names] };
}

// ---- initial locus -------------------------------------------------------------

export const INITIAL_WINDOW_BP = 20_000;

/**
 * Suggest a locus where the file has data, so a viewer opened from a file
 * shows something immediately instead of igv's whole-genome view (where
 * alignments are hidden by the visibility window). Only chromosomes present
 * in `genomeNames` are suggested. Undefined when nothing suitable is found.
 */
export async function suggestInitialLocus(absPath: string, genomeNames: string[], indexPath?: string): Promise<string | undefined> {
  const info = inferFormat(absPath);
  const genome = new Map(genomeNames.map((n) => [normalizeChromName(n), n]));
  const pick = (chr: string, start1: number, length?: number): string | undefined => {
    const gname = genome.get(normalizeChromName(chr));
    if (!gname) return undefined;
    const s = Math.max(1, start1 - Math.floor(INITIAL_WINDOW_BP / 10));
    let e = s + INITIAL_WINDOW_BP - 1;
    if (length && e > length) e = length;
    return `${gname}:${s.toLocaleString('en-US')}-${e.toLocaleString('en-US')}`;
  };
  try {
    if (info.format === 'bam') {
      const first = await readFirstBamRecord(absPath);
      if (first) return pick(first.chr, first.pos + 1, first.length);
      return undefined;
    }
    if (info.format === 'cram') {
      // The .crai index is gzipped text: "seqId<TAB>start<TAB>span<TAB>containerOffset<TAB>sliceOffset<TAB>sliceLen".
      // seqId indexes the CRAM's @SQ list; we assume it matches the genome's order (true for files
      // aligned to this reference). Fall back to the first genome chromosome.
      const crai = indexPath ?? `${absPath}.crai`;
      try {
        const text = zlib.gunzipSync(await fs.readFile(crai)).toString('utf8');
        const line = text.split('\n').find((l) => l.trim().length > 0);
        if (line) {
          const [seqId, start] = line.split('\t');
          const chr = genomeNames[Number(seqId)];
          if (chr && Number.isFinite(Number(start)) && Number(seqId) >= 0) return pick(chr, Number(start) + 1);
        }
      } catch {
        // fall through
      }
      return genomeNames[0] ? pick(genomeNames[0], 1) : undefined;
    }
    if (info.format === 'bigwig' || info.format === 'bigbed') {
      const seq = await readBigChromTree(absPath);
      const chr = seq.names.find((n) => genome.has(normalizeChromName(n)));
      return chr ? pick(chr, 1, seq.lengths?.get(chr)) : undefined;
    }
    if (info.compressed || ['bed', 'gff', 'gff3', 'gtf', 'vcf', 'bedgraph', 'narrowPeak', 'broadPeak', 'seg'].includes(info.format)) {
      const raw = await readPrefix(absPath, 256 * 1024);
      const text = (info.compressed ? inflateBgzf(raw, 256 * 1024) : raw).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line || line.startsWith('#') || line.startsWith('track') || line.startsWith('browser')) continue;
        const cols = line.split('\t');
        if (cols.length < 2) continue;
        const chr = cols[0]!;
        let start1: number | undefined;
        if (info.format === 'vcf') start1 = Number(cols[1]);
        else if (info.format === 'gff' || info.format === 'gff3' || info.format === 'gtf') start1 = Number(cols[3]);
        else start1 = Number(cols[1]) + 1;
        if (!Number.isFinite(start1)) continue;
        const l = pick(chr, start1);
        if (l) return l;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** First alignment record of a BAM: reference name, 0-based position and reference length. */
export async function readFirstBamRecord(absPath: string): Promise<{ chr: string; pos: number; length: number } | undefined> {
  let size = 256 * 1024;
  for (;;) {
    const raw = await readPrefix(absPath, size);
    const d = inflateBgzf(raw, Number.MAX_SAFE_INTEGER);
    const header = parseBamHeaderWithEnd(d);
    if (header) {
      const p = header.end;
      if (p + 12 <= d.length) {
        const refId = d.readInt32LE(p + 4);
        const pos = d.readInt32LE(p + 8);
        const chr = header.info.names[refId];
        if (refId >= 0 && chr) return { chr, pos, length: header.info.lengths?.get(chr) ?? 0 };
        return undefined; // unmapped first read
      }
    }
    if (raw.length < size || size >= MAX_HEADER_BYTES) return undefined;
    size *= 4;
  }
}

function parseBamHeaderWithEnd(d: Buffer): { info: SequenceInfo; end: number } | undefined {
  if (d.length < 12 || d.toString('latin1', 0, 4) !== 'BAM\u0001') return undefined;
  const lText = d.readInt32LE(4);
  let p = 8 + lText;
  if (p + 4 > d.length) return undefined;
  const nRef = d.readInt32LE(p);
  p += 4;
  const names: string[] = [];
  const lengths = new Map<string, number>();
  for (let i = 0; i < nRef; i++) {
    if (p + 4 > d.length) return undefined;
    const lName = d.readInt32LE(p);
    p += 4;
    if (p + lName + 4 > d.length) return undefined;
    const name = d.toString('utf8', p, p + lName - 1);
    p += lName;
    lengths.set(name, d.readInt32LE(p));
    p += 4;
    names.push(name);
  }
  return { info: { names, lengths }, end: p };
}

// ---- comparison --------------------------------------------------------------

export function normalizeChromName(name: string): string {
  let n = name.trim().toLowerCase();
  if (n.startsWith('chr')) n = n.slice(3);
  if (n === 'm' || n === 'mt') return 'm';
  return n;
}

/** Names present in `fileNames` that have no counterpart (modulo chr prefix / case) in `genomeNames`. */
export function compareSequenceNames(fileNames: string[], genomeNames: string[]): { matched: string[]; unmatched: string[] } {
  const genome = new Set(genomeNames.map(normalizeChromName));
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const n of fileNames) (genome.has(normalizeChromName(n)) ? matched : unmatched).push(n);
  return { matched, unmatched };
}
