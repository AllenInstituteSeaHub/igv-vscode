import { describe, expect, it } from 'vitest';
import { buildSession, fromRelativePath, isSessionFileName, parseSession, serializeSession, toRelativePath } from '../../src/session/SessionStore';
import type { ResolvedGenome } from '../../src/agent/protocol';
import { localPath } from '../../src/shared/markers';

const bundled: ResolvedGenome = { id: 'hg38', name: 'Human', source: 'bundled-list', reference: { id: 'hg38' } };
const local: ResolvedGenome = {
  id: 'ref', name: 'ref.fa', source: 'local-file',
  reference: { id: 'ref', name: 'ref.fa', fastaURL: localPath('/proj/ref/ref.fa'), indexURL: localPath('/proj/ref/ref.fa.fai') },
};

describe('path helpers', () => {
  it('produces POSIX relative paths and resolves them back', () => {
    expect(toRelativePath('/proj/sessions', '/proj/data/t.bam')).toBe('../data/t.bam');
    expect(toRelativePath('/proj', '/proj/t.bam')).toBe('t.bam');
    expect(fromRelativePath('/proj/sessions', '../data/t.bam')).toBe('/proj/data/t.bam');
    expect(fromRelativePath('/proj', '/abs/x.bam')).toBe('/abs/x.bam');
    expect(fromRelativePath('/proj', 'https://h/x.bam')).toBe('https://h/x.bam');
    expect(isSessionFileName('a.igv.json')).toBe(true);
    expect(isSessionFileName('a.json')).toBe(false);
  });
});

describe('buildSession / parseSession round trip', () => {
  it('writes relative paths and reads them back from a moved directory', () => {
    const session = buildSession(
      {
        genome: local,
        loci: ['chrS:999,950-1,000,050'],
        tracks: [
          { spec: { path: '/proj/data/large.bam', index: '/proj/data/large.bam.bai', name: 'Tumor', type: 'alignment', format: 'bam', options: { color: '#c00' } }, state: { height: 300, displayMode: 'SQUISHED', url: { junk: true }, _private: 1, unknownKey: 2 } },
          { spec: { url: 'https://h/x.bw', name: 'Remote', type: 'wig', format: 'bigwig' } },
          { spec: { path: '/proj/data/genes.bed', type: 'annotation', format: 'bed', options: {} } },
        ],
        extra: { customNote: 'keep me', igvVscode: { version: 99 }, tracks: 'ignored' },
      },
      '/proj/sessions',
    );
    expect(session.igvVscode).toEqual({ version: 1 });
    expect(session.reference).toEqual({ id: 'ref', name: 'ref.fa', fastaPath: '../ref/ref.fa', indexPath: '../ref/ref.fa.fai' });
    expect(session.genome).toBeUndefined();
    expect(session.locus).toBe('chrS:999,950-1,000,050');
    expect(session.customNote).toBe('keep me');
    expect(session.tracks[0]).toEqual({ name: 'Tumor', type: 'alignment', format: 'bam', path: '../data/large.bam', indexPath: '../data/large.bam.bai', color: '#cc0000', height: 300, displayMode: 'SQUISHED' });
    expect(session.tracks[1]).toEqual({ name: 'Remote', type: 'wig', format: 'bigwig', url: 'https://h/x.bw' });
    expect(session.tracks[2]).toEqual({ type: 'annotation', format: 'bed', path: '../data/genes.bed' });

    // The whole project moves to /elsewhere: paths still resolve relative to the session file.
    const loaded = parseSession(serializeSession(session), '/elsewhere/proj/sessions');
    expect(loaded.genome).toEqual({ localFile: '/elsewhere/proj/ref/ref.fa', indexFile: '/elsewhere/proj/ref/ref.fa.fai' });
    expect(loaded.locus).toBe('chrS:999,950-1,000,050');
    expect(loaded.tracks[0]).toEqual({ name: 'Tumor', type: 'alignment', format: 'bam', path: '/elsewhere/proj/data/large.bam', index: '/elsewhere/proj/data/large.bam.bai', options: { color: '#cc0000', height: 300, displayMode: 'SQUISHED' } });
    expect(loaded.tracks[1]).toEqual({ name: 'Remote', type: 'wig', format: 'bigwig', url: 'https://h/x.bw', options: {} });
    expect(loaded.extra).toEqual({ customNote: 'keep me' });
    expect(loaded.warnings).toEqual([]);
  });

  it('stores bundled genomes by id, multi-locus as an array, absolute paths when requested', () => {
    const s = buildSession({ genome: bundled, loci: ['chr1:1-100', 'chr2:1-100'], tracks: [{ spec: { path: '/d/x.bam' } }] }, '/s', false);
    expect(s.genome).toBe('hg38');
    expect(s.locus).toEqual(['chr1:1-100', 'chr2:1-100']);
    expect(s.tracks[0]!.path).toBe('/d/x.bam');
    const l = parseSession(serializeSession(s), '/anywhere');
    expect(l.genome).toEqual({ id: 'hg38' });
    expect(l.tracks[0]!.path).toBe('/d/x.bam');
  });

  it('accepts plain igv.js sessions with url-based local files and remote references', () => {
    const igvSession = JSON.stringify({
      genome: 'hg19',
      locus: 'chr1:1000-2000',
      tracks: [
        { name: 'A', url: 'data/a.bam', indexURL: 'data/a.bam.bai', format: 'bam', type: 'alignment', height: 200, sourceType: 'file' },
        { url: 'https://h/b.bw', format: 'bigwig' },
        { name: 'no source' },
        'junk',
      ],
    });
    const l = parseSession(igvSession, '/w');
    expect(l.genome).toEqual({ id: 'hg19' });
    expect(l.tracks).toHaveLength(2);
    expect(l.tracks[0]).toMatchObject({ path: '/w/data/a.bam', index: '/w/data/a.bam.bai', options: { height: 200 } });
    expect(l.warnings).toEqual([
      'tracks[0] (A): ignored option(s) sourceType',
      'tracks[2] (no source) has no path or url; skipped',
      'tracks[3] is not an object; skipped',
    ]);
    const remoteRef = parseSession(JSON.stringify({ reference: { id: 'x', fastaURL: 'https://h/x.fa', indexURL: 'https://h/x.fa.fai' }, tracks: [] }), '/w');
    expect(remoteRef.genome).toEqual({ reference: { id: 'x', fastaURL: 'https://h/x.fa', indexURL: 'https://h/x.fa.fai' } });
    expect(parseSession(JSON.stringify({ genome: 'ref/genome.fa', tracks: [] }), '/w').genome).toEqual({ localFile: '/w/ref/genome.fa' });
  });

  it('rejects invalid sessions with clear errors and warns about newer versions', () => {
    expect(() => parseSession('{', '/w')).toThrow(/not valid JSON/);
    expect(() => parseSession('[]', '/w')).toThrow(/JSON object/);
    expect(() => parseSession('{"tracks":[]}', '/w')).toThrow(/neither "genome" nor "reference"/);
    expect(parseSession('{"igvVscode":{"version":7},"genome":"hg38","tracks":[]}', '/w').warnings[0]).toMatch(/newer igv-vscode/);
  });
});
