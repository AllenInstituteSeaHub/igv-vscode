/**
 * Turns a TrackSpec (path or URL plus options) into an igv track config plus
 * the files the broker must serve (spec §4.4, §5.1, §9).
 *
 * M1 scope: inference, index discovery, size limits. The large-file *actions*
 * (indexing, compressing, subsampling) are M3; here an oversized unindexed
 * file fails with INDEX_REQUIRED and a concrete hint.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TrackSpec } from '../agent/protocol';
import { RpcError } from '../shared/rpc';
import { baseName, indexCandidates, inferFormat, type FormatInfo } from './formats';

export interface ResolverSettings {
  /** Max size for loading an unindexed BAM/CRAM or text file whole (spec §5.3, default 20 MiB). */
  unindexedMaxBytes: number;
  alignmentVisibilityWindow: number;
  alignmentSamplingDepth: number;
  alignmentSamplingWindowSize: number;
  variantVisibilityWindow: number;
}

export const DEFAULT_RESOLVER_SETTINGS: ResolverSettings = {
  unindexedMaxBytes: 20 * 1024 * 1024,
  alignmentVisibilityWindow: 30_000,
  alignmentSamplingDepth: 100,
  alignmentSamplingWindowSize: 100,
  variantVisibilityWindow: 1_000_000,
};

export interface LocalFileRef {
  absPath: string;
  size: number;
}

export interface ResolvedTrack {
  name: string;
  type: string;
  format: string;
  /** Absolute path or URL of the data. */
  source: string;
  displayPath: string;
  indexed: boolean;
  /** Local data file (absent for URLs). */
  file?: LocalFileRef;
  /** Local index file (absent for URLs or unindexed loads). */
  indexFile?: LocalFileRef;
  /** For URL tracks: the data URL and, if known, the index URL. */
  url?: string;
  indexUrl?: string;
  /** igv track options (everything except url/indexURL/name/type/format which the controller adds). */
  options: Record<string, unknown>;
  format_: FormatInfo;
}

export interface ResolveContext {
  /** Base directory for relative paths (the caller's cwd or the workspace). */
  baseDir?: string;
  /** Workspace folders used to compute displayPath. */
  workspaceFolders?: string[];
  settings?: Partial<ResolverSettings>;
  /** "Load anyway": skip the unindexed size limit for this resolution. */
  ignoreSizeLimit?: boolean;
  /** File system access; overridable for tests. */
  fs?: Pick<typeof fs, 'statSync' | 'existsSync'>;
}

/** Option keys we accept from TrackSpec.options and pass through to igv after validation. */
export const ALLOWED_OPTION_KEYS = new Set([
  'color', 'altColor', 'height', 'minHeight', 'maxHeight', 'autoHeight', 'displayMode', 'visibilityWindow', 'order',
  'autoscale', 'autoscaleGroup', 'min', 'max', 'graphType', 'windowFunction', 'colorBy', 'sort', 'showCoverage',
  'showAlignments', 'viewAsPairs', 'samplingDepth', 'samplingWindowSize', 'alignmentRowHeight', 'squishedRowHeight',
  'coverageTrackHeight', 'filter', 'expandedRowHeight', 'squishedCallHeight', 'expandedCallHeight', 'colorTable',
  'infoURL', 'searchable', 'indexed', 'removable', 'nameField', 'labelField', 'supportsWholeGenome', 'logScale',
  'baseline', 'showGenotypes', 'visible', 'thickness', 'arcType', 'alpha', 'showBlocks', 'colorScale',
]);

export function isUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
}

export function resolveTrack(spec: TrackSpec, ctx: ResolveContext = {}): ResolvedTrack {
  const settings = { ...DEFAULT_RESOLVER_SETTINGS, ...ctx.settings };
  const fsys = ctx.fs ?? fs;

  const source = spec.url ?? spec.path;
  if (!source) {
    throw new RpcError('UNSUPPORTED_FORMAT', 'A track needs a "path" or a "url"', { hint: 'Example: { "path": "data/tumor.bam" }' });
  }
  if (/^(s3|gs):\/\//i.test(source)) {
    throw new RpcError('UNSUPPORTED_FORMAT', `${source.slice(0, 5)} URLs are not supported in this version`, {
      hint: 'Use a presigned https:// URL instead (for example from "aws s3 presign" or "gsutil signurl").',
    });
  }

  const info = inferFormat(source);
  let type = spec.type ?? info.type;
  let format = spec.format ?? info.format;
  if (info.kind === 'reference') {
    throw new RpcError('UNSUPPORTED_FORMAT', `${baseName(source)} is a reference sequence, not a track`, {
      hint: 'Pass it as the genome instead: --genome path/to/ref.fa',
    });
  }
  if (info.kind === 'session') {
    throw new RpcError('UNSUPPORTED_FORMAT', `${baseName(source)} is a session file, not a track`, {
      hint: 'Load it with "igv-vscode session load FILE" or open it in VS Code.',
    });
  }
  if (info.kind === 'unsupported' && !(spec.type && spec.format)) {
    throw new RpcError('UNSUPPORTED_FORMAT', `Cannot determine the track type of ${baseName(source)}`, {
      hint: info.hint,
    });
  }
  if (!type || !format) {
    throw new RpcError('UNSUPPORTED_FORMAT', `Cannot determine the track type of ${baseName(source)}`, {
      hint: 'Pass both "type" and "format" explicitly.',
    });
  }
  type = String(type);
  format = String(format);

  const options = validateOptions(spec.options ?? {});
  const defaultName = displayName(source);
  const name = spec.name?.trim() || defaultName;

  if (isUrl(source)) {
    if (spec.index && !isUrl(spec.index)) {
      throw new RpcError('UNSUPPORTED_FORMAT', 'A URL track needs a URL index', { hint: `Index given: ${spec.index}` });
    }
    applyDefaults(options, type, format, settings);
    return {
      name, type, format, source, displayPath: source, indexed: spec.index !== undefined || info.indexable,
      url: source, indexUrl: spec.index, options, format_: info,
    };
  }

  // Local file.
  const absPath = path.resolve(ctx.baseDir ?? process.cwd(), source);
  let size: number;
  try {
    const st = fsys.statSync(absPath);
    if (!st.isFile()) throw new Error('not a regular file');
    size = st.size;
  } catch {
    throw new RpcError('FILE_NOT_FOUND', `File not found: ${absPath}`, {
      hint: 'Check the path. Relative paths resolve against the current working directory.',
    });
  }

  let indexFile: LocalFileRef | undefined;
  if (spec.index) {
    const idxAbs = path.resolve(ctx.baseDir ?? process.cwd(), spec.index);
    try {
      indexFile = { absPath: idxAbs, size: fsys.statSync(idxAbs).size };
    } catch {
      throw new RpcError('FILE_NOT_FOUND', `Index file not found: ${idxAbs}`);
    }
  } else if (info.indexable || info.compressed) {
    for (const cand of indexCandidates(absPath)) {
      if (fsys.existsSync(cand)) {
        indexFile = { absPath: cand, size: fsys.statSync(cand).size };
        break;
      }
    }
  }

  const indexed = indexFile !== undefined;
  if (!ctx.ignoreSizeLimit) applyLargeFilePolicy({ absPath, size, info, indexed, settings });
  applyDefaults(options, type, format, settings);
  if (!indexed && !info.selfIndexed) options.indexed = false;

  return {
    name, type, format, source: absPath, displayPath: toDisplayPath(absPath, ctx.workspaceFolders),
    indexed, file: { absPath, size }, indexFile, options, format_: info,
  };
}

export interface IndexRequiredData {
  hint: string;
  suggestedCommand: string;
  /** What would fix it: a BAM/CRAM index, or sort+bgzip+tabix for text. */
  remedy: 'index' | 'compressIndex';
  absPath: string;
  format: string;
  compressed: boolean;
  size: number;
}

function applyLargeFilePolicy(args: { absPath: string; size: number; info: FormatInfo; indexed: boolean; settings: ResolverSettings }): void {
  const { absPath, size, info, indexed, settings } = args;
  if (indexed || info.selfIndexed) return;
  if (size <= settings.unindexedMaxBytes) return;
  const mib = (size / (1024 * 1024)).toFixed(1);
  const limitMib = (settings.unindexedMaxBytes / (1024 * 1024)).toFixed(0);
  const cmd = indexHint(absPath, info);
  const isAlignment = info.format === 'bam' || info.format === 'cram';
  const data: IndexRequiredData = {
    hint: `${cmd}  (or pass "autoIndex": true / --auto-index to let igv-vscode run it)`,
    suggestedCommand: cmd,
    remedy: isAlignment || info.compressed ? 'index' : 'compressIndex',
    absPath,
    format: info.format,
    compressed: info.compressed,
    size,
  };
  if (isAlignment) {
    throw new RpcError('INDEX_REQUIRED', `${baseName(absPath)} is ${mib} MiB and has no index (limit for unindexed loads: ${limitMib} MiB)`, data);
  }
  throw new RpcError('INDEX_REQUIRED', `${baseName(absPath)} is ${mib} MiB of ${info.compressed ? 'unindexed compressed' : 'uncompressed, unindexed'} text (limit: ${limitMib} MiB)`, data);
}

export function indexHint(absPath: string, info: FormatInfo): string {
  if (info.format === 'bam') return `samtools index "${absPath}"`;
  if (info.format === 'cram') return `samtools index "${absPath}"`;
  if (info.compressed) return `tabix -p ${tabixPreset(info)} "${absPath}"`;
  const preset = tabixPreset(info);
  const sortCmd = info.format === 'vcf'
    ? `(grep '^#' "${absPath}"; grep -v '^#' "${absPath}" | sort -k1,1 -k2,2n)`
    : `sort -k1,1 -k${preset === 'gff' ? '4,4n' : '2,2n'} "${absPath}"`;
  return `${sortCmd} | bgzip > "${absPath}.gz" && tabix -p ${preset} "${absPath}.gz"`;
}

function tabixPreset(info: FormatInfo): string {
  if (info.format === 'vcf') return 'vcf';
  if (info.format === 'gff3' || info.format === 'gff' || info.format === 'gtf') return 'gff';
  return 'bed';
}

function applyDefaults(options: Record<string, unknown>, type: string, format: string, s: ResolverSettings): void {
  if (type === 'alignment') {
    options.visibilityWindow ??= s.alignmentVisibilityWindow;
    options.samplingDepth ??= s.alignmentSamplingDepth;
    options.samplingWindowSize ??= s.alignmentSamplingWindowSize;
  } else if (type === 'variant') {
    options.visibilityWindow ??= s.variantVisibilityWindow;
  }
  void format;
}

/**
 * Validate igv track options. Unknown keys throw, unless `dropUnknown` is set
 * (used when loading sessions, where igv may have added keys we do not know);
 * dropped keys are returned in `dropped` via the optional out-parameter.
 */
export function validateOptions(
  input: Record<string, unknown>,
  mode: { dropUnknown?: boolean; dropped?: string[] } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (!ALLOWED_OPTION_KEYS.has(k)) {
      if (mode.dropUnknown) mode.dropped?.push(k);
      else rejected.push(k);
      continue;
    }
    if (k === 'height' || k === 'visibilityWindow' || k === 'samplingDepth' || k === 'samplingWindowSize' || k === 'order') {
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new RpcError('UNSUPPORTED_FORMAT', `Track option "${k}" must be a number, got ${JSON.stringify(v)}`);
      }
      out[k] = n;
      continue;
    }
    if (k === 'color' || k === 'altColor') {
      if (typeof v !== 'string' || !v.trim()) {
        throw new RpcError('UNSUPPORTED_FORMAT', `Track option "${k}" must be a colour string such as "#cc0000" or "rgb(204,0,0)"`);
      }
      out[k] = normalizeColor(v.trim());
      continue;
    }
    if (k === 'displayMode') {
      const mode = String(v).toUpperCase();
      if (!['COLLAPSED', 'EXPANDED', 'SQUISHED', 'FULL'].includes(mode)) {
        throw new RpcError('UNSUPPORTED_FORMAT', `Track option displayMode must be COLLAPSED, EXPANDED, SQUISHED or FULL, got ${JSON.stringify(v)}`);
      }
      out[k] = mode;
      continue;
    }
    out[k] = v;
  }
  if (rejected.length > 0) {
    throw new RpcError('UNSUPPORTED_FORMAT', `Unknown track option(s): ${rejected.join(', ')}`, {
      hint: `Allowed: ${[...ALLOWED_OPTION_KEYS].sort().join(', ')}`,
    });
  }
  return out;
}

/**
 * igv.js 3.8.9's colour helpers (e.g. darkenLighten) do not understand
 * 3/4-digit hex shorthand and throw while drawing, so expand it.
 */
export function normalizeColor(color: string): string {
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i.exec(color);
  if (!m) return color;
  const [, r, g, b, a] = m;
  return `#${r}${r}${g}${g}${b}${b}${a ? `${a}${a}` : ''}`.toLowerCase();
}

export function displayName(source: string): string {
  let n = baseNamePreserveCase(source);
  for (const ext of ['.gz', '.bgz']) if (n.toLowerCase().endsWith(ext)) n = n.slice(0, -ext.length);
  const dot = n.lastIndexOf('.');
  return dot > 0 ? n.slice(0, dot) : n;
}

function baseNamePreserveCase(s: string): string {
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

export function toDisplayPath(absPath: string, workspaceFolders?: string[]): string {
  if (workspaceFolders) {
    for (const folder of workspaceFolders) {
      const rel = path.relative(folder, absPath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return workspaceFolders.length > 1 ? `${path.basename(folder)}/${rel.split(path.sep).join('/')}` : rel.split(path.sep).join('/');
      }
    }
  }
  return absPath;
}
