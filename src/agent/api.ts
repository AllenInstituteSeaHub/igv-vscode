/**
 * Implementation of the control-channel methods (spec §6.3) over the
 * extension's services. Pure glue: validation, viewer targeting, and the
 * waitForRender semantics via ViewerController.settle().
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  GenomesListParams, GenomesListResult, PingResult, SessionLoadParams, SessionSaveParams, SessionSaveResult, TrackSpec, TrackState,
  TracksAddParams, TracksAddResult, TracksRemoveParams, TracksRemoveResult, TracksUpdateParams, ViewerCloseParams, ViewerCloseResult,
  ViewerGotoParams, ViewerOpenParams, ViewerOpenResult, ViewerSetGenomeParams, ViewerSnapshotParams, ViewerSnapshotResult, ViewerState,
  ViewerStateParams, ViewerSummary, ResolvedGenome, HostKind,
} from './protocol';
import { CONTROL_METHODS, PROTOCOL_VERSION } from './protocol';
import { RpcError } from '../shared/rpc';
import type { GenomeRegistry } from '../genome/GenomeRegistry';
import type { SessionService } from '../session/SessionService';
import type { LargeFilePolicy } from '../tools/LargeFilePolicy';
import type { ViewerController } from '../viewer/ViewerController';
import type { ViewerManager } from '../viewer/ViewerManager';
import { snapshotFileName } from '../ui/snapshotDir';

export interface ControlApiDeps {
  viewers: ViewerManager;
  genomes: GenomeRegistry;
  sessions: SessionService;
  policy: LargeFilePolicy;
  version: string;
  igvVersion: string;
  vscodeVersion: string;
  host: HostKind;
  workspaceFolders: () => string[];
  defaultGenome: () => ResolvedGenome | undefined;
  snapshotDir: () => Promise<string>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function str(v: unknown, name: string, optional = false): string | undefined {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new RpcError('INTERNAL', `Missing required parameter "${name}"`);
  }
  if (typeof v !== 'string') throw new RpcError('INTERNAL', `Parameter "${name}" must be a string`);
  return v;
}

function locusParam(v: unknown): string | string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.length ? (v as string[]) : undefined;
  throw new RpcError('INTERNAL', 'Parameter "locus" must be a string or an array of strings');
}

function tracksParam(v: unknown): TrackSpec[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RpcError('INTERNAL', 'Parameter "tracks" must be an array of track specs');
  return v.map((t, i) => {
    if (typeof t === 'string') return { path: t };
    if (typeof t !== 'object' || t === null) throw new RpcError('INTERNAL', `tracks[${i}] must be an object or a path string`);
    return t as TrackSpec;
  });
}

function absolutize(specs: TrackSpec[], cwd: string): TrackSpec[] {
  return specs.map((s) => ({
    ...s,
    path: s.path ? path.resolve(cwd, s.path) : undefined,
    index: s.index && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s.index) ? path.resolve(cwd, s.index) : s.index,
  }));
}

export function createControlApi(deps: ControlApiDeps): (method: string, params: Record<string, unknown>) => Promise<unknown> {
  const cwdOf = (p: { cwd?: unknown }) => (typeof p.cwd === 'string' && p.cwd ? p.cwd : deps.workspaceFolders()[0] ?? process.cwd());

  const resolveGenome = (id: string | undefined, cwd: string): ResolvedGenome => {
    if (id) return deps.genomes.resolve(id, cwd);
    const d = deps.defaultGenome();
    if (d) return d;
    throw new RpcError('GENOME_NOT_FOUND', 'No genome given and igv.defaultGenome is not set', {
      hint: 'Pass --genome (an id such as hg38, or a local FASTA/2bit path), or set igv.defaultGenome.',
    });
  };

  const settleFlag = async (viewer: ViewerController, wait: unknown, timeoutMs: unknown): Promise<boolean> => {
    if (wait === false) return false;
    return viewer.settle({ timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_TIMEOUT_MS });
  };

  const addTracks = async (viewer: ViewerController, specs: TrackSpec[], cwd: string) => {
    const prepared = await deps.policy.prepare(absolutize(specs, cwd), 'agent');
    for (const n of prepared.notes) deps.log('info', n);
    const r = prepared.specs.length ? await viewer.addTracks(prepared.specs, { baseDir: cwd }) : { added: [] as TrackState[], warnings: [] as string[], mismatches: [] };
    return { added: r.added, warnings: [...prepared.notes.filter((n) => /skipped|previously/.test(n)), ...r.warnings] };
  };

  const pickViewer = async (p: { viewer?: unknown; reuse?: unknown; name?: unknown }, genome: ResolvedGenome, locus?: string | string[], show?: boolean): Promise<{ viewer: ViewerController; created: boolean }> => {
    const reuse = (str(p.reuse, 'reuse', true) ?? 'new') as 'new' | 'active' | 'byName';
    const name = str(p.name, 'name', true);
    if (reuse === 'active' && deps.viewers.active) {
      const v = deps.viewers.active;
      if (v.genomeId !== genome.id) await v.setGenome(genome, locus);
      else if (locus) await v.goto(locus);
      if (show) v.reveal(true);
      return { viewer: v, created: false };
    }
    if (reuse === 'byName' && name) {
      const existing = deps.viewers.list().find((v) => v.name === name);
      if (existing) {
        const v = deps.viewers.resolve(existing.id);
        if (v.genomeId !== genome.id) await v.setGenome(genome, locus);
        else if (locus) await v.goto(locus);
        if (show) v.reveal(true);
        return { viewer: v, created: false };
      }
    }
    const v = await deps.viewers.open({ genome, locus, opener: 'agent', name });
    if (show) v.reveal(true);
    return { viewer: v, created: true };
  };

  // Each handler declares its typed params; the dispatcher validates fields at runtime.
  const methods: Record<string, (params: never) => Promise<unknown>> = {
    async ping(): Promise<PingResult> {
      return { version: deps.version, igvVersion: deps.igvVersion, vscodeVersion: deps.vscodeVersion, host: deps.host, workspaceFolders: deps.workspaceFolders(), protocolVersion: PROTOCOL_VERSION };
    },

    async 'viewer.open'(p: ViewerOpenParams): Promise<ViewerOpenResult> {
      const cwd = cwdOf(p);
      const genome = resolveGenome(str(p.genome, 'genome', true), cwd);
      const locus = locusParam(p.locus);
      const { viewer } = await pickViewer(p, genome, locus, p.show !== false);
      const warnings: string[] = [];
      const specs = tracksParam(p.tracks);
      if (specs.length) warnings.push(...(await addTracks(viewer, specs, cwd)).warnings);
      const settled = await settleFlag(viewer, p.waitForRender, p.timeoutMs);
      return { ...viewer.getState(), settled, warnings };
    },

    async 'viewer.list'(): Promise<ViewerSummary[]> {
      return deps.viewers.list();
    },

    async 'viewer.state'(p: ViewerStateParams): Promise<ViewerState> {
      const viewer = deps.viewers.resolve(str(p.viewer, 'viewer', true));
      if (viewer.genomeId) await viewer.refreshState();
      return viewer.getState(p.verbose === true);
    },

    async 'viewer.goto'(p: ViewerGotoParams): Promise<ViewerState & { settled: boolean }> {
      const viewer = deps.viewers.resolve(str(p.viewer, 'viewer', true));
      const locus = locusParam(p.locus);
      if (!locus) throw new RpcError('INTERNAL', 'Missing required parameter "locus"', { hint: 'Example: chr8:127,736,588-127,739,371 or a gene name' });
      await viewer.goto(locus);
      const settled = await settleFlag(viewer, p.waitForRender, p.timeoutMs);
      return { ...viewer.getState(), settled };
    },

    async 'viewer.setGenome'(p: ViewerSetGenomeParams): Promise<ViewerState & { warnings: string[] }> {
      const viewer = deps.viewers.resolve(str(p.viewer, 'viewer', true));
      const genome = deps.genomes.resolve(str(p.genome, 'genome')!, cwdOf(p));
      const r = await viewer.setGenome(genome, undefined, { keepTracks: p.keepTracks === true });
      return { ...viewer.getState(), warnings: r.warnings };
    },

    async 'tracks.add'(p: TracksAddParams): Promise<TracksAddResult> {
      const viewer = deps.viewers.resolve(str(p.viewer, 'viewer', true));
      const specs = tracksParam(p.tracks);
      if (specs.length === 0) throw new RpcError('INTERNAL', 'Parameter "tracks" must list at least one track');
      const r = await addTracks(viewer, specs, cwdOf(p));
      const settled = await settleFlag(viewer, p.waitForRender, p.timeoutMs);
      return { added: r.added, warnings: r.warnings, settled };
    },

    async 'tracks.remove'(p: TracksRemoveParams): Promise<TracksRemoveResult> {
      const viewer = deps.viewers.resolve(str(p.viewer, 'viewer', true));
      const names = Array.isArray(p.names) ? (p.names as string[]) : undefined;
      const ids = Array.isArray(p.ids) ? (p.ids as string[]) : undefined;
      if (!names?.length && !ids?.length) throw new RpcError('INTERNAL', 'Give "names" or "ids" of tracks to remove');
      return viewer.removeTracks({ names, ids });
    },

    async 'tracks.update'(p: TracksUpdateParams): Promise<TrackState> {
      const viewer = deps.viewers.resolve(str(p.viewer, 'viewer', true));
      const id = str(p.id, 'id')!;
      if (typeof p.options !== 'object' || p.options === null) throw new RpcError('INTERNAL', 'Parameter "options" must be an object of igv track options');
      return viewer.updateTrack(id, p.options as Record<string, unknown>);
    },

    async 'viewer.snapshot'(p: ViewerSnapshotParams): Promise<ViewerSnapshotResult> {
      const viewer = deps.viewers.resolve(str(p.viewer, 'viewer', true));
      const format = (str(p.format, 'format', true) ?? 'png') as 'png' | 'svg';
      if (format !== 'png' && format !== 'svg') throw new RpcError('INTERNAL', 'format must be "png" or "svg"');
      const cwd = cwdOf(p);
      const out = p.out ? path.resolve(cwd, str(p.out, 'out')!) : path.join(await deps.snapshotDir(), snapshotFileName(viewer.name.replace(/[^\w.-]+/g, '_'), format));
      await fs.mkdir(path.dirname(out), { recursive: true });
      let width: number;
      let height: number;
      let bytes: Uint8Array | string;
      if (format === 'svg') {
        const r = await viewer.snapshotSvg();
        width = r.width;
        height = r.height;
        bytes = r.svg;
        await fs.writeFile(out, r.svg, 'utf8');
      } else {
        const r = await viewer.snapshotPng(typeof p.scale === 'number' && p.scale > 0 ? p.scale : 2);
        width = r.width;
        height = r.height;
        bytes = r.png;
        await fs.writeFile(out, r.png);
      }
      deps.log('info', `snapshot written to ${out}`);
      const result: ViewerSnapshotResult = { path: out, format, width, height, locus: viewer.getState().loci };
      if (p.inline) result.base64 = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8').toString('base64') : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
      return result;
    },

    async 'session.save'(p: SessionSaveParams): Promise<SessionSaveResult> {
      const viewer = deps.viewers.resolve(str(p.viewer, 'viewer', true));
      const target = path.resolve(cwdOf(p), str(p.path, 'path')!);
      return { path: await deps.sessions.save(viewer, target, p.relativePaths !== false) };
    },

    async 'session.load'(p: SessionLoadParams): Promise<ViewerState & { warnings: string[] }> {
      const file = path.resolve(cwdOf(p), str(p.path, 'path')!);
      const loaded = await deps.sessions.read(file);
      const genome = deps.sessions.resolveGenome(loaded);
      const reuse = (str(p.reuse, 'reuse', true) ?? (p.viewer ? 'active' : 'new')) as 'new' | 'active' | 'byName';
      let viewer: ViewerController;
      if (p.viewer) viewer = deps.viewers.resolve(str(p.viewer, 'viewer')!);
      else if (reuse === 'active' && deps.viewers.active) viewer = deps.viewers.active;
      else viewer = await deps.viewers.open({ genome, opener: 'agent', name: path.basename(file).replace(/\.igv\.json$/i, '') });
      const r = await deps.sessions.applyTo(viewer, loaded);
      viewer.reveal(true);
      return { ...r.state, warnings: r.warnings };
    },

    async 'viewer.close'(p: ViewerCloseParams): Promise<ViewerCloseResult> {
      if (p.all === true) {
        const ids = deps.viewers.list().map((v) => v.id);
        for (const id of ids) deps.viewers.resolve(id).dispose();
        return { closed: ids };
      }
      const viewer = deps.viewers.resolve(str(p.viewer, 'viewer', true));
      viewer.dispose();
      return { closed: [viewer.id] };
    },

    async 'genomes.list'(p: GenomesListParams): Promise<GenomesListResult> {
      return { genomes: deps.genomes.list(str(p.filter, 'filter', true)) };
    },
  };

  return async (method, params) => {
    const fn = methods[method];
    if (!fn || !(CONTROL_METHODS as readonly string[]).includes(method)) {
      throw new RpcError('INTERNAL', `unknown method "${method}"`, { hint: `Methods: ${CONTROL_METHODS.join(', ')}` });
    }
    return fn(params as never);
  };
}
