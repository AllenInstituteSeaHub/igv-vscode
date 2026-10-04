/**
 * Genome lookup (spec §7): the bundled igv-data list, user-defined genomes
 * from the `igv.genomes.custom` setting, ad-hoc local FASTA/2bit references,
 * and the per-workspace default. Local files appear in reference objects as
 * `{__igvVscodeLocalPath}` markers; ViewerController converts them to broker
 * handles so absolute paths never reach the webview.
 *
 * This module has no `vscode` dependency so it can be unit tested; the
 * extension injects persistence through `GenomeDefaultsStore` and file access
 * through `fs`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenomeSummary, IgvReference, ResolvedGenome, TrackSpec } from '../agent/protocol';
import { RpcError } from '../shared/rpc';
import { localPath } from '../shared/markers';
import { baseName, inferFormat } from '../data/formats';

export interface GenomeDefaultsStore {
  getDefaultGenome(): string | undefined;
  setDefaultGenome(id: string): Promise<void>;
  getRecent(): string[];
  setRecent(ids: string[]): Promise<void>;
}

/** Shape of one entry of the `igv.genomes.custom` setting. */
export interface CustomGenomeSetting {
  id: string;
  name?: string;
  fastaPath?: string;
  fastaURL?: string;
  indexPath?: string;
  indexURL?: string;
  twoBitPath?: string;
  twoBitURL?: string;
  cytobandPath?: string;
  cytobandURL?: string;
  aliasPath?: string;
  aliasURL?: string;
  chromosomeOrder?: string | string[];
  tracks?: TrackSpec[];
}

export const MAX_RECENT_GENOMES = 8;
export const UNINDEXED_FASTA_MAX_BYTES = 10 * 1024 * 1024;

type Fs = Pick<typeof fs, 'existsSync' | 'statSync'>;

export function isGenomeEntry(value: unknown): value is IgvReference {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

export function parseGenomeList(json: string): IgvReference[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`genome list is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  if (!Array.isArray(parsed)) throw new Error('genome list must be a JSON array');
  return parsed.filter(isGenomeEntry);
}

interface CustomEntry {
  reference: IgvReference;
  /** Tracks to load with the genome (resolved later by the controller). */
  tracks: TrackSpec[];
}

export class GenomeRegistry {
  private readonly bundled: IgvReference[];
  private custom = new Map<string, CustomEntry>();
  private customErrors: string[] = [];

  constructor(
    bundled: IgvReference[],
    private readonly store: GenomeDefaultsStore,
    private readonly fsys: Fs = fs,
  ) {
    this.bundled = bundled.map((g) => ({ ...g }));
  }

  /**
   * Replace the user-defined genomes. Relative paths resolve against
   * `baseDir`. Invalid entries are skipped and reported via `customProblems`.
   */
  setCustomGenomes(entries: unknown, baseDir: string): void {
    this.custom = new Map();
    this.customErrors = [];
    if (!Array.isArray(entries)) {
      if (entries !== undefined && entries !== null) this.customErrors.push('igv.genomes.custom must be an array');
      return;
    }
    entries.forEach((raw, i) => {
      if (typeof raw !== 'object' || raw === null || typeof (raw as CustomGenomeSetting).id !== 'string' || !(raw as CustomGenomeSetting).id.trim()) {
        this.customErrors.push(`igv.genomes.custom[${i}]: missing "id"`);
        return;
      }
      const e = raw as CustomGenomeSetting;
      const ref: IgvReference = { id: e.id.trim(), name: e.name?.trim() || e.id.trim() };
      const abs = (p: string) => path.resolve(baseDir, p);
      const pathOrUrl = (pathKey: keyof CustomGenomeSetting, urlKey: keyof CustomGenomeSetting, target: string) => {
        const p = e[pathKey];
        const u = e[urlKey];
        if (typeof p === 'string' && p) ref[target] = localPath(abs(p));
        else if (typeof u === 'string' && u) ref[target] = u;
      };
      pathOrUrl('fastaPath', 'fastaURL', 'fastaURL');
      pathOrUrl('indexPath', 'indexURL', 'indexURL');
      pathOrUrl('twoBitPath', 'twoBitURL', 'twoBitURL');
      pathOrUrl('cytobandPath', 'cytobandURL', 'cytobandURL');
      pathOrUrl('aliasPath', 'aliasURL', 'aliasURL');
      if (!ref.fastaURL && !ref.twoBitURL) {
        this.customErrors.push(`igv.genomes.custom[${i}] (${ref.id}): needs fastaPath/fastaURL or twoBitPath/twoBitURL`);
        return;
      }
      if (e.chromosomeOrder) ref.chromosomeOrder = e.chromosomeOrder;
      if (ref.fastaURL && !ref.indexURL && typeof e.fastaPath === 'string') {
        const fai = `${abs(e.fastaPath)}.fai`;
        if (this.fsys.existsSync(fai)) ref.indexURL = localPath(fai);
        else ref.indexed = false;
      }
      const tracks = Array.isArray(e.tracks) ? e.tracks.map((t) => ({ ...t, path: t.path ? abs(t.path) : undefined })) : [];
      this.custom.set(ref.id, { reference: ref, tracks });
    });
  }

  get customProblems(): string[] {
    return [...this.customErrors];
  }

  /** All known genomes: custom first, then the bundled list. */
  list(filter?: string): GenomeSummary[] {
    const f = filter?.trim().toLowerCase();
    const match = (id: string, name: string) => !f || id.toLowerCase().includes(f) || name.toLowerCase().includes(f);
    const out: GenomeSummary[] = [];
    for (const { reference: g } of this.custom.values()) {
      if (match(g.id, g.name ?? '')) out.push({ id: g.id, name: g.name ?? g.id, source: 'custom' });
    }
    for (const g of this.bundled) {
      if (match(g.id, g.name ?? '')) {
        out.push({ id: g.id, name: g.name ?? g.id, source: 'bundled-list', description: typeof g.description === 'string' ? g.description : undefined });
      }
    }
    return out;
  }

  /** The bundled list to hand to igv as `genomeList` on every createBrowser (spec §7, §14 #5). Never includes local paths. */
  igvGenomeList(): IgvReference[] {
    return this.bundled.map((g) => ({ ...g }));
  }

  /** Tracks configured for a custom genome, if any. */
  tracksFor(genomeId: string): TrackSpec[] {
    return this.custom.get(genomeId)?.tracks.map((t) => ({ ...t })) ?? [];
  }

  /**
   * Resolve an id (exact, case-insensitive), a display name, or a path to a
   * local FASTA/2bit file. Throws `GENOME_NOT_FOUND` with suggestions.
   */
  resolve(idNameOrPath: string, baseDir?: string): ResolvedGenome {
    const key = idNameOrPath.trim();
    if (!key) throw new RpcError('GENOME_NOT_FOUND', 'Empty genome identifier');
    const lower = key.toLowerCase();

    const custom = this.custom.get(key) ?? [...this.custom.values()].find((c) => c.reference.id.toLowerCase() === lower);
    if (custom) {
      return { id: custom.reference.id, name: custom.reference.name ?? custom.reference.id, source: 'custom', reference: structuredClone(custom.reference) };
    }
    const match =
      this.bundled.find((g) => g.id === key) ??
      this.bundled.find((g) => g.id.toLowerCase() === lower) ??
      this.bundled.find((g) => (g.name ?? '').toLowerCase() === lower);
    if (match) return { id: match.id, name: match.name ?? match.id, source: 'bundled-list', reference: { ...match } };

    if (looksLikePath(key)) {
      const abs = path.resolve(baseDir ?? process.cwd(), key);
      if (this.fsys.existsSync(abs)) return this.fromLocalFile(abs);
      if (inferFormat(key).kind === 'reference') {
        throw new RpcError('FILE_NOT_FOUND', `Reference file not found: ${abs}`);
      }
    }
    const suggestions = this.list(key).slice(0, 5).map((g) => g.id);
    throw new RpcError('GENOME_NOT_FOUND', `Unknown genome "${idNameOrPath}"`, {
      hint:
        suggestions.length > 0
          ? `Did you mean: ${suggestions.join(', ')}? Run "igv-vscode genomes" to list all.`
          : 'Run "igv-vscode genomes" to list known genomes, or pass a local FASTA/2bit path.',
      suggestions,
    });
  }

  /** Build an ad-hoc genome from a local FASTA (+ .fai) or 2bit file (spec §7, §5.1). */
  fromLocalFile(absPath: string): ResolvedGenome {
    const info = inferFormat(absPath);
    if (info.kind !== 'reference') {
      throw new RpcError('UNSUPPORTED_FORMAT', `${baseName(absPath)} is not a FASTA (.fa/.fasta/.fna) or .2bit file`);
    }
    let size: number;
    try {
      size = this.fsys.statSync(absPath).size;
    } catch {
      throw new RpcError('FILE_NOT_FOUND', `Reference file not found: ${absPath}`);
    }
    const id = displayId(absPath);
    const reference: IgvReference = { id, name: path.basename(absPath) };
    if (info.format === '2bit') {
      reference.twoBitURL = localPath(absPath);
      const bpt = `${absPath}.bpt`;
      if (this.fsys.existsSync(bpt)) reference.twoBitBptURL = localPath(bpt);
    } else {
      if (info.compressed) {
        const gzi = `${absPath}.gzi`;
        const fai = `${absPath}.fai`;
        if (!this.fsys.existsSync(gzi) || !this.fsys.existsSync(fai)) {
          throw new RpcError('INDEX_REQUIRED', `${baseName(absPath)} is bgzip-compressed and needs both .fai and .gzi indexes`, {
            hint: `samtools faidx "${absPath}"`,
          });
        }
        reference.fastaURL = localPath(absPath);
        reference.indexURL = localPath(fai);
        reference.compressedIndexURL = localPath(gzi);
      } else {
        reference.fastaURL = localPath(absPath);
        const fai = `${absPath}.fai`;
        if (this.fsys.existsSync(fai)) {
          reference.indexURL = localPath(fai);
        } else if (size <= UNINDEXED_FASTA_MAX_BYTES) {
          reference.indexed = false;
        } else {
          throw new RpcError('INDEX_REQUIRED', `${baseName(absPath)} is ${(size / 1048576).toFixed(0)} MiB and has no .fai index`, {
            hint: `samtools faidx "${absPath}"`,
            suggestedCommand: `samtools faidx "${absPath}"`,
          });
        }
      }
    }
    return { id, name: reference.name ?? id, source: 'local-file', reference };
  }

  getDefaultGenomeId(): string | undefined {
    const id = this.store.getDefaultGenome()?.trim();
    return id ? id : undefined;
  }

  async setDefaultGenomeId(id: string): Promise<void> {
    await this.store.setDefaultGenome(id);
  }

  getRecentIds(): string[] {
    const known = new Set([...this.bundled.map((g) => g.id), ...this.custom.keys()]);
    return this.store.getRecent().filter((id) => known.has(id));
  }

  async markUsed(id: string): Promise<void> {
    const recent = [id, ...this.store.getRecent().filter((x) => x !== id)].slice(0, MAX_RECENT_GENOMES);
    await this.store.setRecent(recent);
  }
}

function looksLikePath(s: string): boolean {
  return s.includes('/') || s.includes('\\') || inferFormat(s).kind === 'reference';
}

function displayId(absPath: string): string {
  let n = path.basename(absPath);
  for (const ext of ['.gz', '.bgz']) if (n.toLowerCase().endsWith(ext)) n = n.slice(0, -ext.length);
  const dot = n.lastIndexOf('.');
  return dot > 0 ? n.slice(0, dot) : n;
}
