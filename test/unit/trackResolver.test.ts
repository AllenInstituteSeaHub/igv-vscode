import type * as nodeFs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TrackSpec } from '../../src/agent/protocol';
import { displayName, indexHint, normalizeColor, resolveTrack, toDisplayPath, validateOptions } from '../../src/data/TrackResolver';
import type { RpcError } from '../../src/shared/rpc';

const isWindows = process.platform === 'win32';

/** In-memory file system: path → size. */
function fakeFs(files: Record<string, number>) {
  return {
    existsSync: (p: string) => p in files,
    statSync: (p: string) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: files[p]!, isFile: () => true } as unknown as nodeFs.Stats;
    },
  } as unknown as Pick<typeof nodeFs, 'statSync' | 'existsSync'>;
}

function failure(fn: () => unknown): RpcError {
  try {
    fn();
  } catch (e) {
    return e as RpcError;
  }
  throw new Error('expected a throw');
}

const MiB = 1024 * 1024;
const base = '/ws';

// These suites model a POSIX filesystem ('/ws/...'); on Windows path.resolve() rewrites them to C:\\ws\\..., so they are skipped there.
describe.skipIf(isWindows)('resolveTrack: local files', () => {
  it('resolves an indexed BAM with defaults and a workspace-relative display path', () => {
    const fs = fakeFs({ '/ws/data/tumor.bam': 5e9, '/ws/data/tumor.bam.bai': 4e6 });
    const t = resolveTrack({ path: 'data/tumor.bam' }, { baseDir: base, workspaceFolders: ['/ws'], fs });
    expect(t).toMatchObject({
      name: 'tumor', type: 'alignment', format: 'bam', source: '/ws/data/tumor.bam', displayPath: 'data/tumor.bam', indexed: true,
      file: { absPath: '/ws/data/tumor.bam', size: 5e9 }, indexFile: { absPath: '/ws/data/tumor.bam.bai', size: 4e6 },
    });
    expect(t.options).toEqual({ visibilityWindow: 30_000, samplingDepth: 100, samplingWindowSize: 100 });
  });

  it('prefers X.bam.bai, then X.bai, then X.bam.csi', () => {
    const fs = fakeFs({ '/ws/a.bam': 1, '/ws/a.bai': 1, '/ws/a.bam.csi': 1 });
    expect(resolveTrack({ path: 'a.bam' }, { baseDir: base, fs }).indexFile?.absPath).toBe('/ws/a.bai');
    const fs2 = fakeFs({ '/ws/a.bam': 1, '/ws/a.bam.csi': 1 });
    expect(resolveTrack({ path: 'a.bam' }, { baseDir: base, fs: fs2 }).indexFile?.absPath).toBe('/ws/a.bam.csi');
  });

  it('honours an explicit index and fails if it is missing', () => {
    const fs = fakeFs({ '/ws/a.bam': 1, '/other/idx.bai': 2 });
    expect(resolveTrack({ path: 'a.bam', index: '/other/idx.bai' }, { baseDir: base, fs }).indexFile?.absPath).toBe('/other/idx.bai');
    expect(failure(() => resolveTrack({ path: 'a.bam', index: 'nope.bai' }, { baseDir: base, fs })).code).toBe('FILE_NOT_FOUND');
  });

  it('loads a small unindexed BAM with indexed:false', () => {
    const fs = fakeFs({ '/ws/small.bam': 2 * MiB });
    const t = resolveTrack({ path: 'small.bam' }, { baseDir: base, fs });
    expect(t.indexed).toBe(false);
    expect(t.options.indexed).toBe(false);
  });

  it('rejects a large unindexed BAM with INDEX_REQUIRED and a samtools hint', () => {
    const fs = fakeFs({ '/ws/big.bam': 21 * MiB });
    const err = failure(() => resolveTrack({ path: 'big.bam' }, { baseDir: base, fs }));
    expect(err.code).toBe('INDEX_REQUIRED');
    expect((err.data as { suggestedCommand: string }).suggestedCommand).toBe('samtools index "/ws/big.bam"');
    // Raising the limit allows it.
    expect(resolveTrack({ path: 'big.bam' }, { baseDir: base, fs, settings: { unindexedMaxBytes: 30 * MiB } }).indexed).toBe(false);
  });

  it('rejects a large unindexed BED with a sort+bgzip+tabix hint, loads a small one whole', () => {
    const fs = fakeFs({ '/ws/big.bed': 21 * MiB, '/ws/small.bed': MiB });
    const err = failure(() => resolveTrack({ path: 'big.bed' }, { baseDir: base, fs }));
    expect(err.code).toBe('INDEX_REQUIRED');
    expect((err.data as { suggestedCommand: string }).suggestedCommand).toMatch(/sort -k1,1 -k2,2n .* \| bgzip > .* && tabix -p bed/);
    expect(resolveTrack({ path: 'small.bed' }, { baseDir: base, fs })).toMatchObject({ indexed: false, type: 'annotation', format: 'bed' });
  });

  it('uses tabix indexes for bgzipped text and loads bigWig as-is regardless of size', () => {
    const fs = fakeFs({ '/ws/v.vcf.gz': 50 * MiB, '/ws/v.vcf.gz.tbi': 1e5, '/ws/cov.bw': 3e9 });
    const v = resolveTrack({ path: 'v.vcf.gz' }, { baseDir: base, fs });
    expect(v).toMatchObject({ type: 'variant', format: 'vcf', indexed: true, indexFile: { absPath: '/ws/v.vcf.gz.tbi' } });
    expect(v.options).toEqual({ visibilityWindow: 1_000_000 });
    const bw = resolveTrack({ path: 'cov.bw' }, { baseDir: base, fs });
    expect(bw).toMatchObject({ type: 'wig', format: 'bigwig', indexed: false });
    expect(bw.options.indexed).toBeUndefined();
  });

  it('rejects large bgzipped text without a tabix index with a tabix hint', () => {
    const fs = fakeFs({ '/ws/v.vcf.gz': 50 * MiB });
    const err = failure(() => resolveTrack({ path: 'v.vcf.gz' }, { baseDir: base, fs }));
    expect(err.code).toBe('INDEX_REQUIRED');
    expect((err.data as { suggestedCommand: string }).suggestedCommand).toBe('tabix -p vcf "/ws/v.vcf.gz"');
  });

  it('INDEX_REQUIRED carries structured remedy data and ignoreSizeLimit overrides it', () => {
    const fs = fakeFs({ '/ws/big.bam': 21 * MiB, '/ws/big.bed': 21 * MiB });
    const err = failure(() => resolveTrack({ path: 'big.bam', autoIndex: true }, { baseDir: base, fs }));
    expect(err.code).toBe('INDEX_REQUIRED');
    expect(err.data).toMatchObject({ remedy: 'index', absPath: '/ws/big.bam', format: 'bam', suggestedCommand: 'samtools index "/ws/big.bam"' });
    expect((failure(() => resolveTrack({ path: 'big.bed' }, { baseDir: base, fs })).data as { remedy: string }).remedy).toBe('compressIndex');
    expect(resolveTrack({ path: 'big.bam' }, { baseDir: base, fs, ignoreSizeLimit: true }).indexed).toBe(false);
  });

  it('errors for missing files, references, sessions and unknown types', () => {
    const fs = fakeFs({ '/ws/ref.fa': 1, '/ws/s.igv.json': 1, '/ws/x.xyz': 1, '/ws/x.sam': 1 });
    expect(failure(() => resolveTrack({ path: 'missing.bam' }, { baseDir: base, fs })).code).toBe('FILE_NOT_FOUND');
    expect(failure(() => resolveTrack({ path: 'ref.fa' }, { baseDir: base, fs })).message).toMatch(/reference sequence/);
    expect(failure(() => resolveTrack({ path: 's.igv.json' }, { baseDir: base, fs })).message).toMatch(/session file/);
    const unknown = failure(() => resolveTrack({ path: 'x.xyz' }, { baseDir: base, fs }));
    expect(unknown.code).toBe('UNSUPPORTED_FORMAT');
    expect((failure(() => resolveTrack({ path: 'x.sam' }, { baseDir: base, fs })).data as { hint: string }).hint).toMatch(/samtools view/);
    // Explicit type+format rescues an unknown extension.
    expect(resolveTrack({ path: 'x.xyz', type: 'annotation', format: 'bed' }, { baseDir: base, fs })).toMatchObject({ type: 'annotation', format: 'bed' });
    expect(failure(() => resolveTrack({} as TrackSpec)).code).toBe('UNSUPPORTED_FORMAT');
  });

  it('applies explicit name and validated options', () => {
    const fs = fakeFs({ '/ws/t.bam': 1, '/ws/t.bam.bai': 1 });
    const t = resolveTrack(
      { path: 't.bam', name: ' Tumor ', options: { color: '#c00', height: '300', displayMode: 'squished', visibilityWindow: 100000 } },
      { baseDir: base, fs },
    );
    expect(t.name).toBe('Tumor');
    expect(t.options).toEqual({ color: '#cc0000', height: 300, displayMode: 'SQUISHED', visibilityWindow: 100000, samplingDepth: 100, samplingWindowSize: 100 });
  });
});

describe('resolveTrack: URLs', () => {
  it('passes https URLs through with optional index', () => {
    const t = resolveTrack({ url: 'https://h/x.bam', index: 'https://h/x.bam.bai' });
    expect(t).toMatchObject({ url: 'https://h/x.bam', indexUrl: 'https://h/x.bam.bai', indexed: true, type: 'alignment', displayPath: 'https://h/x.bam' });
    expect(t.file).toBeUndefined();
  });
  it('rejects s3:// and gs:// with a presigned-URL hint', () => {
    const err = failure(() => resolveTrack({ url: 's3://bucket/x.bam' }));
    expect(err.code).toBe('UNSUPPORTED_FORMAT');
    expect((err.data as { hint: string }).hint).toMatch(/presigned/);
    expect(failure(() => resolveTrack({ url: 'gs://b/x.bam' })).code).toBe('UNSUPPORTED_FORMAT');
  });
  it('rejects a local index for a URL track', () => {
    expect(failure(() => resolveTrack({ url: 'https://h/x.bam', index: 'local.bai' })).message).toMatch(/URL index/);
  });
});

describe.skipIf(isWindows)('helpers', () => {
  it('normalizes shorthand hex colours (igv.js cannot draw them) and rejects non-strings', () => {
    expect(normalizeColor('#c00')).toBe('#cc0000');
    expect(normalizeColor('#C00F')).toBe('#cc0000ff');
    expect(normalizeColor('#cc0000')).toBe('#cc0000');
    expect(normalizeColor('rgb(204,0,0)')).toBe('rgb(204,0,0)');
    expect(normalizeColor('red')).toBe('red');
    expect(validateOptions({ color: '#0f0', altColor: 'blue' })).toEqual({ color: '#00ff00', altColor: 'blue' });
    expect(failure(() => validateOptions({ color: 7 })).message).toMatch(/colour string/);
  });

  it('validateOptions rejects unknown keys and bad values', () => {
    expect(failure(() => validateOptions({ evil: 1 })).message).toMatch(/Unknown track option/);
    expect(failure(() => validateOptions({ height: 'tall' })).message).toMatch(/must be a number/);
    expect(failure(() => validateOptions({ displayMode: 'weird' })).message).toMatch(/displayMode/);
  });
  it('displayName strips directories and extensions including .gz', () => {
    expect(displayName('/a/b/Tumor.bam')).toBe('Tumor');
    expect(displayName('https://h/calls.vcf.gz?x=1')).toBe('calls');
    expect(displayName('noext')).toBe('noext');
  });
  it('toDisplayPath is relative inside a workspace and absolute outside', () => {
    expect(toDisplayPath('/ws/data/x.bam', ['/ws'])).toBe('data/x.bam');
    expect(toDisplayPath('/elsewhere/x.bam', ['/ws'])).toBe('/elsewhere/x.bam');
    expect(toDisplayPath('/ws2/x.bam', ['/ws', '/ws2'])).toBe('ws2/x.bam');
  });
  it('indexHint covers gff sorting', () => {
    expect(indexHint('/ws/g.gff3', { kind: 'track', type: 'annotation', format: 'gff3', compressed: false, selfIndexed: false, indexable: true, needsReference: false })).toMatch(/-k4,4n .*tabix -p gff/);
  });
});
