/**
 * Large-file policy (spec §5): turn TrackSpecs that would fail with
 * INDEX_REQUIRED into loadable specs by indexing, compressing+indexing or
 * subsampling, either automatically (agents with autoIndex/subsample) or by
 * asking the human. UI is injected so this stays testable without vscode.
 */
import * as path from 'node:path';
import type { TrackSpec } from '../agent/protocol';
import { derivedLocation, findDerived } from '../data/derivedDir';
import { inferFormat } from '../data/formats';
import { resolveTrack, type IndexRequiredData, type ResolveContext } from '../data/TrackResolver';
import { RpcError } from '../shared/rpc';
import { indexBam, indexFasta, sortBgzipTabix, subsampleBam, subsampleOutputName, tabixPresetFor, type JobContext, type SubsampleOptions } from './jobs';
import type { ToolDetector } from './ToolDetector';

export type PolicyAction = 'index' | 'compressIndex' | 'subsample' | 'loadAnyway' | 'cancel';

export interface PolicyQuestion {
  spec: TrackSpec;
  problem: IndexRequiredData;
  message: string;
  /** Actions the UI may offer, in order; tools unavailable → action omitted. */
  actions: PolicyAction[];
  missingTools: string[];
}

export interface PolicyAnswer {
  action: PolicyAction;
  subsample?: SubsampleOptions;
}

export interface PolicyDeps {
  tools: ToolDetector;
  derivedDir: () => string;
  resolveContext: () => ResolveContext;
  log: (line: string) => void;
  /** Runs a job with progress/cancel UI (the extension wraps vscode.window.withProgress). */
  runJob: <T>(title: string, task: (ctx: JobContext) => Promise<T>) => Promise<T>;
  /** Interactive prompt; undefined (no UI) behaves like an agent. */
  ask?: (q: PolicyQuestion) => Promise<PolicyAnswer | undefined>;
}

export interface PreparedTracks {
  specs: TrackSpec[];
  /** Human-readable notes (e.g. "indexed X", "skipped Y"). */
  notes: string[];
}

export class LargeFilePolicy {
  constructor(private readonly deps: PolicyDeps) {}

  /** Make every spec loadable or drop it (interactive cancel) / throw (agent). */
  async prepare(specs: TrackSpec[], mode: 'interactive' | 'agent'): Promise<PreparedTracks> {
    const out: TrackSpec[] = [];
    const notes: string[] = [];
    for (const spec of specs) {
      const prepared = await this.prepareOne(spec, mode, notes);
      if (prepared) out.push(prepared);
    }
    return { specs: out, notes };
  }

  private async prepareOne(spec: TrackSpec, mode: 'interactive' | 'agent', notes: string[]): Promise<TrackSpec | undefined> {
    if (spec.url || spec.loadAnyway) return spec;
    const ctx = this.deps.resolveContext();
    if (spec.subsample) {
      const abs = path.resolve(ctx.baseDir ?? process.cwd(), spec.path ?? '');
      return this.subsample(spec, abs, spec.subsample, notes);
    }
    try {
      resolveTrack(spec, ctx);
      return spec;
    } catch (err) {
      const e = RpcError.from(err);
      if (e.code !== 'INDEX_REQUIRED') throw e;
      const problem = e.data as IndexRequiredData;
      // A previously generated artifact in the derived dir?
      const existing = await this.findExistingArtifact(problem);
      if (existing) {
        notes.push(`${path.basename(problem.absPath)}: using previously generated ${path.basename(existing.index ?? existing.path ?? '')}`);
        return { ...spec, ...existing };
      }
      if (spec.autoIndex) return this.remedy(spec, problem, problem.remedy, notes);
      if (mode === 'agent' || !this.deps.ask) throw e;

      const tools = await this.deps.tools.detectAll();
      const actions: PolicyAction[] = [];
      const missing: string[] = [];
      if (problem.remedy === 'index') {
        if (problem.format === 'bam' || problem.format === 'cram') {
          if (tools.samtools) actions.push('index', 'subsample');
          else missing.push('samtools');
        } else if (tools.tabix) actions.push('index');
        else missing.push('tabix');
      } else if (tools.bgzip && tools.tabix && tools.sort) actions.push('compressIndex');
      else missing.push(...(['bgzip', 'tabix', 'sort'] as const).filter((t) => !tools[t]));
      actions.push('loadAnyway', 'cancel');
      const answer = await this.deps.ask({ spec, problem, message: e.message, actions, missingTools: missing });
      if (!answer || answer.action === 'cancel') {
        notes.push(`${path.basename(problem.absPath)}: skipped`);
        return undefined;
      }
      if (answer.action === 'loadAnyway') return { ...spec, autoIndex: false, loadAnyway: true };
      if (answer.action === 'subsample') return this.subsample(spec, problem.absPath, answer.subsample ?? { fraction: 0.1 }, notes);
      return this.remedy(spec, problem, answer.action, notes);
    }
  }

  private async findExistingArtifact(problem: IndexRequiredData): Promise<Partial<TrackSpec> | undefined> {
    const derived = this.deps.derivedDir();
    if (problem.remedy === 'index') {
      const suffix = problem.format === 'bam' ? '.bai' : problem.format === 'cram' ? '.crai' : '.tbi';
      const idx = await findDerived(problem.absPath, suffix, derived);
      return idx ? { index: idx } : undefined;
    }
    const gz = await findDerived(problem.absPath, '.gz', derived);
    if (!gz) return undefined;
    const tbi = await findDerived(gz, '.tbi', derived);
    return tbi ? { path: gz, index: tbi } : undefined;
  }

  /** Run the job that fixes `problem` and return the updated spec. */
  async remedy(spec: TrackSpec, problem: IndexRequiredData, action: 'index' | 'compressIndex', notes: string[]): Promise<TrackSpec> {
    const derived = this.deps.derivedDir();
    const base = path.basename(problem.absPath);
    if (action === 'index') {
      if (problem.format === 'bam' || problem.format === 'cram') {
        const samtools = await this.deps.tools.require('samtools', `index ${base}`);
        const loc = await derivedLocation(problem.absPath, derived);
        const out = path.join(loc.dir, `${base}${problem.format === 'bam' ? '.bai' : '.crai'}`);
        await this.deps.runJob(`IGV: indexing ${base}`, (ctx) => indexBam(samtools, problem.absPath, out, ctx));
        notes.push(`${base}: index written to ${loc.nextToSource ? path.basename(out) : out}`);
        return { ...spec, index: out };
      }
      // bgzipped text without .tbi
      const tabix = await this.deps.tools.require('tabix', `index ${base}`);
      const loc = await derivedLocation(problem.absPath, derived);
      let target = problem.absPath;
      if (!loc.nextToSource) {
        // tabix writes next to its input; copy into the derived dir first.
        target = path.join(loc.dir, base);
        await (await import('node:fs/promises')).copyFile(problem.absPath, target);
      }
      await this.deps.runJob(`IGV: indexing ${base}`, (ctx) => import('./jobs').then((j) => j.runCommand(tabix.path, ['-f', '-p', tabixPresetFor(problem.format), target], ctx)));
      notes.push(`${base}: tabix index created`);
      return { ...spec, path: target, index: `${target}.tbi` };
    }
    // compressIndex
    const [sort, bgzip, tabix] = await Promise.all([
      this.deps.tools.require('sort', `sort ${base}`),
      this.deps.tools.require('bgzip', `compress ${base}`),
      this.deps.tools.require('tabix', `index ${base}`),
    ]);
    const loc = await derivedLocation(problem.absPath, derived);
    const outGz = path.join(loc.dir, `${base}.gz`);
    const r = await this.deps.runJob(`IGV: sorting, compressing and indexing ${base}`, (ctx) =>
      sortBgzipTabix({ sort, bgzip, tabix }, problem.absPath, tabixPresetFor(problem.format), outGz, ctx),
    );
    notes.push(`${base}: wrote ${loc.nextToSource ? path.basename(r.gz) : r.gz} and its tabix index`);
    return { ...spec, path: r.gz, index: r.index };
  }

  /** Create a subsampled, indexed BAM in the derived location and return a spec for it. */
  async subsample(spec: TrackSpec, absPath: string, options: SubsampleOptions, notes: string[]): Promise<TrackSpec> {
    const info = inferFormat(absPath);
    if (info.format !== 'bam') throw new RpcError('UNSUPPORTED_FORMAT', `Subsampling is only supported for BAM files (got ${path.basename(absPath)})`);
    const samtools = await this.deps.tools.require('samtools', `subsample ${path.basename(absPath)}`);
    const loc = await derivedLocation(absPath, this.deps.derivedDir());
    const fraction = options.fraction ?? 0.1;
    const outName = subsampleOutputName(absPath, options.fraction ?? fraction, options.region);
    const out = path.join(loc.dir, outName);
    const r = await this.deps.runJob(`IGV: subsampling ${path.basename(absPath)}`, (ctx) => subsampleBam(samtools, absPath, options, out, ctx));
    const pct = `${(r.fraction * 100).toPrecision(2).replace(/\.0$/, '')}%`;
    notes.push(`${path.basename(absPath)}: subsample ${pct} written to ${loc.nextToSource ? outName : out}`);
    const { subsample: _s, ...rest } = spec;
    void _s;
    return { ...rest, path: r.bam, index: r.index, name: `${spec.name ?? path.basename(absPath).replace(/\.bam$/i, '')} (subsample ${pct})` };
  }

  /** "IGV: Index File…": index a BAM/CRAM, FASTA or bgzipped text file, or sort+bgzip+tabix plain text. */
  async indexFile(absPath: string): Promise<{ outputs: string[]; note: string }> {
    const info = inferFormat(absPath);
    const base = path.basename(absPath);
    if (info.kind === 'reference' && info.format === 'fasta') {
      const samtools = await this.deps.tools.require('samtools', `index ${base}`);
      const fai = await this.deps.runJob(`IGV: indexing ${base}`, (ctx) => indexFasta(samtools, absPath, ctx));
      return { outputs: [fai], note: `${base}: wrote ${path.basename(fai)}` };
    }
    if (info.format === 'bam' || info.format === 'cram') {
      const notes: string[] = [];
      const spec = await this.remedy({ path: absPath }, { absPath, format: info.format, compressed: false, remedy: 'index', hint: '', suggestedCommand: '', size: 0 }, 'index', notes);
      return { outputs: [spec.index!], note: notes.join('; ') };
    }
    if (info.kind === 'track' && info.indexable) {
      const notes: string[] = [];
      const spec = await this.remedy({ path: absPath }, { absPath, format: info.format, compressed: info.compressed, remedy: info.compressed ? 'index' : 'compressIndex', hint: '', suggestedCommand: '', size: 0 }, info.compressed ? 'index' : 'compressIndex', notes);
      return { outputs: [spec.path!, spec.index!], note: notes.join('; ') };
    }
    throw new RpcError('UNSUPPORTED_FORMAT', `${base} cannot be indexed (${info.selfIndexed ? 'it is already self-indexed' : 'unsupported format'})`);
  }
}
