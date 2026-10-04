/**
 * Glue between viewers, the genome registry and session files: save the
 * active view to `.igv.json`, load a session into a viewer, and keep
 * per-viewer restore snapshots in workspace state for window reloads.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { ResolvedGenome, ViewerState } from '../agent/protocol';
import type { GenomeRegistry } from '../genome/GenomeRegistry';
import type { Logger } from '../log';
import { RpcError } from '../shared/rpc';
import type { ViewerController } from '../viewer/ViewerController';
import { buildSession, parseSession, serializeSession, type IgvVscodeSession, type LoadedSession } from './SessionStore';

const RESTORE_KEY = 'igv.restoreSessions';
const MAX_RESTORE_ENTRIES = 20;
const RESTORE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

interface RestoreEntry {
  session: IgvVscodeSession;
  name: string;
  savedAt: number;
}

export interface LoadSessionResult {
  state: ViewerState;
  warnings: string[];
}

export class SessionService {
  constructor(
    private readonly genomes: GenomeRegistry,
    private readonly workspaceState: vscode.Memento,
    private readonly log: Logger,
  ) {}

  /** Build the session object for a viewer; paths relative to `sessionDir` unless `relativePaths` is false. */
  async build(viewer: ViewerController, sessionDir: string, relativePaths = true): Promise<IgvVscodeSession> {
    const genome = viewer.genomeResolved;
    if (!genome) throw new RpcError('INTERNAL', `viewer ${viewer.id} has no genome loaded`);
    const tracks = await viewer.sessionTracks();
    return buildSession({ genome, loci: viewer.getState().loci, tracks, extra: viewer.sessionExtra }, sessionDir, relativePaths);
  }

  async save(viewer: ViewerController, filePath: string, relativePaths = true): Promise<string> {
    const abs = path.resolve(filePath);
    const session = await this.build(viewer, path.dirname(abs), relativePaths);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, serializeSession(session), 'utf8');
    this.log.info(`saved session to ${abs} (${session.tracks.length} tracks)`, viewer.id);
    return abs;
  }

  async read(filePath: string): Promise<LoadedSession> {
    const abs = path.resolve(filePath);
    let text: string;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch (err) {
      throw new RpcError('FILE_NOT_FOUND', `Cannot read session ${abs}: ${(err as Error).message}`);
    }
    return parseSession(text, path.dirname(abs));
  }

  resolveGenome(loaded: LoadedSession): ResolvedGenome {
    const g = loaded.genome;
    if ('id' in g) return this.genomes.resolve(g.id);
    if ('localFile' in g) return this.genomes.fromLocalFile(g.localFile);
    const ref = g.reference;
    const id = typeof ref.id === 'string' && ref.id ? ref.id : 'session-reference';
    return { id, name: typeof ref.name === 'string' ? ref.name : id, source: 'url', reference: { ...ref, id } };
  }

  /** Load a parsed session into a viewer (replacing its genome and tracks). */
  async applyTo(viewer: ViewerController, loaded: LoadedSession): Promise<LoadSessionResult> {
    const genome = this.resolveGenome(loaded);
    const warnings = [...loaded.warnings];
    await viewer.setGenome(genome, loaded.locus);
    viewer.sessionExtra = loaded.extra;
    if (loaded.tracks.length > 0) {
      const r = await viewer.addTracks(loaded.tracks);
      warnings.push(...r.warnings);
    }
    return { state: viewer.getState(), warnings };
  }

  async loadFile(viewer: ViewerController, filePath: string): Promise<LoadSessionResult> {
    const loaded = await this.read(filePath);
    const result = await this.applyTo(viewer, loaded);
    this.log.info(`loaded session ${filePath} into ${viewer.id} (${loaded.tracks.length} tracks, ${result.warnings.length} warnings)`, viewer.id);
    return result;
  }

  // ---- restore snapshots for window reload (spec §3.3 serializer) ----------

  private restoreEntries(): Record<string, RestoreEntry> {
    return this.workspaceState.get<Record<string, RestoreEntry>>(RESTORE_KEY, {});
  }

  async rememberForRestore(key: string, viewer: ViewerController): Promise<void> {
    if (!viewer.genomeResolved || viewer.isDisposed) return;
    try {
      const session = await this.build(viewer, process.cwd(), false);
      const entries = this.restoreEntries();
      entries[key] = { session, name: viewer.name, savedAt: Date.now() };
      const keys = Object.keys(entries).sort((a, b) => entries[a]!.savedAt - entries[b]!.savedAt);
      const now = Date.now();
      for (const k of keys) {
        if (now - entries[k]!.savedAt > RESTORE_MAX_AGE_MS || Object.keys(entries).length > MAX_RESTORE_ENTRIES) delete entries[k];
      }
      await this.workspaceState.update(RESTORE_KEY, entries);
    } catch (err) {
      this.log.warn(`could not snapshot viewer ${viewer.id} for restore: ${String(err)}`, viewer.id);
    }
  }

  async takeRestoreEntry(key: string): Promise<RestoreEntry | undefined> {
    const entries = this.restoreEntries();
    const e = entries[key];
    if (!e) return undefined;
    delete entries[key];
    await this.workspaceState.update(RESTORE_KEY, entries);
    return e;
  }

  async forgetRestoreEntry(key: string): Promise<void> {
    const entries = this.restoreEntries();
    if (!(key in entries)) return;
    delete entries[key];
    await this.workspaceState.update(RESTORE_KEY, entries);
  }

  /** Apply a restore entry (absolute paths) to a viewer. */
  async applyRestoreEntry(viewer: ViewerController, entry: RestoreEntry): Promise<LoadSessionResult> {
    const loaded = parseSession(serializeSession(entry.session), process.cwd());
    return this.applyTo(viewer, loaded);
  }
}
