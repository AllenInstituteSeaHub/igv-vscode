/**
 * `.igv.json` session files (spec §6.7): the igv.js session shape plus an
 * `igvVscode` marker, with local sources stored as paths relative to the
 * session file. Pure functions; file I/O is done by the caller.
 */
import * as path from 'node:path';
import type { ResolvedGenome, TrackSpec } from '../agent/protocol';
import { isLocalPathMarker } from '../shared/markers';
import { RpcError } from '../shared/rpc';
import { isUrl, validateOptions } from '../data/TrackResolver';

export const SESSION_VERSION = 1;

/** One track as stored in a session file. Local files use `path`/`indexPath`, remote `url`/`indexURL`. */
export interface SessionTrack {
  name?: string;
  type?: string;
  format?: string;
  path?: string;
  indexPath?: string;
  url?: string;
  indexURL?: string;
  [option: string]: unknown;
}

export interface SessionReference {
  id?: string;
  name?: string;
  fastaPath?: string;
  indexPath?: string;
  twoBitPath?: string;
  fastaURL?: string;
  indexURL?: string;
  twoBitURL?: string;
  [k: string]: unknown;
}

export interface IgvVscodeSession {
  igvVscode: { version: number };
  /** Genome id for bundled or custom genomes. */
  genome?: string;
  /** Full reference for ad-hoc local genomes (or igv-style remote references). */
  reference?: SessionReference;
  locus?: string | string[];
  tracks: SessionTrack[];
  [k: string]: unknown;
}

export interface SessionTrackInput {
  spec: TrackSpec;
  /** Current igv track state (already sanitised to primitives). */
  state?: Record<string, unknown>;
}

export interface BuildSessionInput {
  genome: ResolvedGenome;
  loci: string[];
  tracks: SessionTrackInput[];
  /** Keys from an earlier session we loaded, preserved on save. */
  extra?: Record<string, unknown>;
}

export interface LoadedSession {
  /** Either a genome id to resolve, or a local reference file to build a genome from. */
  genome: { id: string } | { localFile: string; indexFile?: string } | { reference: SessionReference };
  locus?: string | string[];
  tracks: TrackSpec[];
  /** Unknown top-level keys, preserved for round-trips. */
  extra: Record<string, unknown>;
  warnings: string[];
}

const KNOWN_TOP_LEVEL = new Set(['igvVscode', 'genome', 'reference', 'locus', 'tracks']);
const TRACK_META_KEYS = new Set(['name', 'type', 'format', 'path', 'indexPath', 'url', 'indexURL', 'index', 'options', 'autoIndex', 'subsample', 'id']);

/** POSIX-style relative path from `fromDir` to `absPath`; falls back to the absolute path across drives. */
export function toRelativePath(fromDir: string, absPath: string): string {
  const rel = path.relative(fromDir, absPath);
  if (!rel) return path.basename(absPath);
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return absPath.split(path.sep).join('/');
  return rel.split(path.sep).join('/');
}

export function fromRelativePath(sessionDir: string, p: string): string {
  if (isUrl(p)) return p;
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(sessionDir, p.split('/').join(path.sep));
}

function markerPath(v: unknown): string | undefined {
  return isLocalPathMarker(v) ? v.__igvVscodeLocalPath : undefined;
}

export function buildSession(input: BuildSessionInput, sessionDir: string, relativePaths = true): IgvVscodeSession {
  const rel = (abs: string) => (relativePaths ? toRelativePath(sessionDir, abs) : abs);
  const session: IgvVscodeSession = { igvVscode: { version: SESSION_VERSION }, tracks: [] };
  for (const [k, v] of Object.entries(input.extra ?? {})) if (!KNOWN_TOP_LEVEL.has(k)) session[k] = v;

  const g = input.genome;
  if (g.source === 'local-file') {
    const ref: SessionReference = { id: g.id, name: g.name };
    const fasta = markerPath(g.reference.fastaURL);
    const fai = markerPath(g.reference.indexURL);
    const twoBit = markerPath(g.reference.twoBitURL);
    if (fasta) ref.fastaPath = rel(fasta);
    if (fai) ref.indexPath = rel(fai);
    if (twoBit) ref.twoBitPath = rel(twoBit);
    session.reference = ref;
  } else {
    session.genome = g.id;
  }

  session.locus = input.loci.length === 1 ? input.loci[0] : [...input.loci];

  for (const { spec, state } of input.tracks) {
    const t: SessionTrack = {};
    if (spec.name) t.name = spec.name;
    if (spec.type) t.type = spec.type;
    if (spec.format) t.format = spec.format;
    if (spec.url) {
      t.url = spec.url;
      if (spec.index) t.indexURL = spec.index;
    } else if (spec.path) {
      t.path = rel(spec.path);
      if (spec.index) t.indexPath = rel(spec.index);
    }
    const merged = { ...(spec.options ?? {}), ...(state ?? {}) };
    const clean = validateOptions(merged, { dropUnknown: true });
    for (const [k, v] of Object.entries(clean)) {
      if (!TRACK_META_KEYS.has(k) && v !== undefined && v !== null) t[k] = v;
    }
    session.tracks.push(t);
  }
  return session;
}

export function serializeSession(session: IgvVscodeSession): string {
  return JSON.stringify(session, null, 2) + '\n';
}

/**
 * Parse a session file. Accepts our format and plain igv.js sessions (where
 * local files appear as non-URL `url` strings).
 */
export function parseSession(json: string, sessionDir: string): LoadedSession {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new RpcError('UNSUPPORTED_FORMAT', `Session file is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RpcError('UNSUPPORTED_FORMAT', 'Session file must contain a JSON object');
  }
  const s = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const marker = s.igvVscode as { version?: unknown } | undefined;
  if (marker && typeof marker.version === 'number' && marker.version > SESSION_VERSION) {
    warnings.push(`Session was written by a newer igv-vscode (format version ${marker.version}); some settings may be ignored.`);
  }

  let genome: LoadedSession['genome'];
  const ref = s.reference as SessionReference | undefined;
  if (typeof s.genome === 'string' && s.genome.trim()) {
    const gid = s.genome.trim();
    if (!isUrl(gid) && /\.(fa|fasta|fna|2bit)(\.gz|\.bgz)?$/i.test(gid)) {
      genome = { localFile: fromRelativePath(sessionDir, gid) };
    } else {
      genome = { id: gid };
    }
  } else if (ref && typeof ref === 'object') {
    const localSeq = ref.fastaPath ?? ref.twoBitPath ?? (typeof ref.fastaURL === 'string' && !isUrl(ref.fastaURL) ? ref.fastaURL : undefined);
    if (typeof localSeq === 'string') {
      const idx = ref.indexPath ?? (typeof ref.indexURL === 'string' && !isUrl(ref.indexURL) ? ref.indexURL : undefined);
      genome = { localFile: fromRelativePath(sessionDir, localSeq), indexFile: typeof idx === 'string' ? fromRelativePath(sessionDir, idx) : undefined };
    } else {
      genome = { reference: ref };
    }
  } else {
    throw new RpcError('GENOME_NOT_FOUND', 'Session file has neither "genome" nor "reference"', {
      hint: 'Add "genome": "hg38" or a "reference" with fastaPath/twoBitPath.',
    });
  }

  const tracks: TrackSpec[] = [];
  const rawTracks = Array.isArray(s.tracks) ? (s.tracks as unknown[]) : [];
  rawTracks.forEach((rt, i) => {
    if (typeof rt !== 'object' || rt === null) {
      warnings.push(`tracks[${i}] is not an object; skipped`);
      return;
    }
    const t = rt as SessionTrack;
    const spec: TrackSpec = {};
    if (typeof t.name === 'string') spec.name = t.name;
    if (typeof t.type === 'string') spec.type = t.type;
    if (typeof t.format === 'string') spec.format = t.format;
    const source = typeof t.path === 'string' ? t.path : typeof t.url === 'string' ? t.url : undefined;
    if (!source) {
      warnings.push(`tracks[${i}]${t.name ? ` (${t.name})` : ''} has no path or url; skipped`);
      return;
    }
    if (isUrl(source)) spec.url = source;
    else spec.path = fromRelativePath(sessionDir, source);
    const index = typeof t.indexPath === 'string' ? t.indexPath : typeof t.indexURL === 'string' ? t.indexURL : typeof t.index === 'string' ? t.index : undefined;
    if (index) spec.index = isUrl(index) ? index : fromRelativePath(sessionDir, index);
    const options: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t)) if (!TRACK_META_KEYS.has(k)) options[k] = v;
    const dropped: string[] = [];
    spec.options = validateOptions(options, { dropUnknown: true, dropped });
    if (dropped.length) warnings.push(`tracks[${i}]${t.name ? ` (${t.name})` : ''}: ignored option(s) ${dropped.join(', ')}`);
    tracks.push(spec);
  });

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (!KNOWN_TOP_LEVEL.has(k)) extra[k] = v;

  const locus = typeof s.locus === 'string' || (Array.isArray(s.locus) && s.locus.every((x) => typeof x === 'string')) ? (s.locus as string | string[]) : undefined;
  return { genome, locus, tracks, extra, warnings };
}

export function isSessionFileName(name: string): boolean {
  return /\.igv\.json$/i.test(name);
}
