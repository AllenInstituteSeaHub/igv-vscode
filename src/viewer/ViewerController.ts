/**
 * Owns one WebviewPanel and the authoritative state for one viewer
 * (spec §3.1). All webview operations go through a per-viewer queue so that
 * concurrent commands (human + agent) are serialized. Byte reads from the
 * webview are answered through the FileAccessBroker's per-viewer allow-list.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IgvReference, ResolvedGenome, TrackSpec, TrackState, ViewerState } from '../agent/protocol';
import type {
  AlertEvent,
  BrowserCreateParams,
  BrowserCreateResult,
  BrowserGotoParams,
  BrowserStateResult,
  ErrorEvent,
  LocusChangeEvent,
  LogEvent,
  PayloadEncoding,
  ProbeResult,
  ReadParams,
  SnapshotPngResult,
  SnapshotSvgResult,
  TrackConfig,
  TracksStateResult,
  TracksAddResult,
  TracksRemoveResult,
  TransportSettings,
  WebviewTrackState,
} from '../shared/webviewProtocol';
import { Rpc, RpcError, isRpcMessage } from '../shared/rpc';
import { fileRef, replaceLocalPaths } from '../shared/markers';
import type { FileAccessBroker, FileHandleInfo } from '../data/FileAccessBroker';
import { resolveTrack, validateOptions, type ResolvedTrack, type ResolverSettings } from '../data/TrackResolver';
import { compareSequenceNames, readSequenceNames, readSequenceNamesRemote } from '../data/sequenceNames';
import { indexCandidates } from '../data/formats';
import { looksLikeNetworkError, type RemoteProxy } from '../data/RemoteProxy';
import type { Logger } from '../log';
import { getViewerHtml } from './html';

export const VIEWER_VIEW_TYPE = 'igv.viewer';

export type RemoteMode = 'direct' | 'proxy' | 'auto';
export type TransportMode = 'shim' | 'webviewUri';

export interface ViewerControllerDeps {
  extensionUri: vscode.Uri;
  log: Logger;
  broker: FileAccessBroker;
  genomeList: () => IgvReference[];
  resolverSettings: () => Partial<ResolverSettings>;
  workspaceFolders: () => string[];
  transport: () => Omit<TransportSettings, 'encoding'>;
  /** Remote URL handling (spec §4.3). */
  remote: () => { mode: RemoteMode; proxy: RemoteProxy | undefined; allowHttp: boolean };
  /** Local file transport (spec §4.1 shim, §4.2 webviewUri). Read once per viewer at creation. */
  transportMode: () => TransportMode;
  /** Origins that needed the proxy in "auto" mode, shared across viewers for the session. */
  proxiedOrigins: Set<string>;
}

export interface OpenPlacement {
  viewColumn: vscode.ViewColumn;
  preserveFocus: boolean;
}

export interface AddTracksOptions {
  /** Base directory for relative paths (defaults to the first workspace folder or cwd). */
  baseDir?: string;
}

export interface GenomeMismatch {
  trackId: string;
  trackName: string;
  /** Sequence names found in the file (first few). */
  fileNames: string[];
  genomeId: string;
  code: 'GENOME_MISMATCH';
}

export interface AddTracksResult {
  added: TrackState[];
  warnings: string[];
  mismatches: GenomeMismatch[];
}

export interface SettleOptions {
  timeoutMs?: number;
  quietMs?: number;
}

interface TrackRecord {
  state: TrackState;
  spec: TrackSpec;
  files: FileHandleInfo[];
}

const READY_TIMEOUT_MS = 20_000;
const DEFAULT_RPC_TIMEOUT_MS = 120_000;

export class ViewerController implements vscode.Disposable {
  readonly id: string;
  name: string;
  readonly panel: vscode.WebviewPanel;

  private readonly rpc: Rpc;
  private readonly disposables: vscode.Disposable[] = [];
  private ready!: { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void };
  private queue: Promise<unknown> = Promise.resolve();
  private genome: ResolvedGenome | null = null;
  private loci: string[] = [];
  private chromosomeNames: string[] = [];
  private igvVersion = '';
  private encoding: PayloadEncoding | undefined;
  private readonly tracks = new Map<string, TrackRecord>();
  private nextTrackIndex = 1;
  private readsInFlight = 0;
  private lastReadFinished = 0;
  private disposed = false;
  readonly transportMode: TransportMode;
  /** Directories added to localResourceRoots in webviewUri mode. */
  private readonly extraRoots = new Set<string>();

  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this._onDidDispose.event;
  private readonly _onDidChangeState = new vscode.EventEmitter<ViewerState>();
  readonly onDidChangeState = this._onDidChangeState.event;
  private readonly _onDidChangeViewState = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
  readonly onDidChangeViewState = this._onDidChangeViewState.event;

  constructor(id: string, name: string, panel: vscode.WebviewPanel, private readonly deps: ViewerControllerDeps) {
    this.id = id;
    this.name = name;
    this.panel = panel;
    this.transportMode = deps.transportMode();

    this.resetReady();

    this.rpc = new Rpc((m) => void this.panel.webview.postMessage(m), {
      defaultTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      onError: (err) => this.deps.log.error(err instanceof Error ? err : String(err), this.id),
    });
    this.wireEvents();
    this.rpc.handle('read', (params) => this.handleRead(params as ReadParams));

    this.disposables.push(
      panel.webview.onDidReceiveMessage((m) => {
        if (isRpcMessage(m)) void this.rpc.dispatch(m);
      }),
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState((e) => this._onDidChangeViewState.fire(e)),
    );

    this.loadHtml();
  }

  /** Arm a fresh "ready" handshake (initial load and every webview reload). */
  private resetReady(): void {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    this.ready = { promise, resolve, reject };
    const timer = setTimeout(() => reject(new RpcError('TIMEOUT', `viewer ${this.id} webview did not become ready within ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
    promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
  }

  private loadHtml(): void {
    this.panel.webview.html = getViewerHtml({
      webview: this.panel.webview,
      extensionUri: this.deps.extensionUri,
      viewerId: this.id,
      extraConnect: [...(this.deps.remote().allowHttp ? ['http:'] : []), ...(this.transportMode === 'webviewUri' ? [this.panel.webview.cspSource] : [])],
    });
  }

  static createPanel(title: string, placement: OpenPlacement, extensionUri: vscode.Uri): vscode.WebviewPanel {
    return vscode.window.createWebviewPanel(
      VIEWER_VIEW_TYPE,
      title,
      { viewColumn: placement.viewColumn, preserveFocus: placement.preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    );
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  get genomeId(): string | undefined {
    return this.genome?.id;
  }

  get chromosomes(): string[] {
    return [...this.chromosomeNames];
  }

  get transportEncoding(): PayloadEncoding | undefined {
    return this.encoding;
  }

  getState(verbose = false): ViewerState {
    const state: ViewerState = {
      id: this.id,
      name: this.name,
      genome: this.genome ? { id: this.genome.id, name: this.genome.name, source: this.genome.source } : null,
      loci: [...this.loci],
      tracks: [...this.tracks.values()].map((t) => ({ ...t.state })),
    };
    if (verbose) state.metrics = this.deps.broker.getMetrics(this.id);
    return state;
  }

  /** Track specs currently loaded, for session saving and genome switches. */
  trackSpecs(): TrackSpec[] {
    return [...this.tracks.values()].map((t) => ({ ...t.spec }));
  }

  /**
   * Create (or recreate) the igv browser for a genome. Existing tracks are
   * dropped unless `keepTracks`, in which case they are re-added afterwards
   * and failures are reported as warnings.
   */
  setGenome(genome: ResolvedGenome, locus?: string | string[], options: { keepTracks?: boolean } = {}): Promise<ViewerState & { warnings: string[]; mismatches: GenomeMismatch[] }> {
    return this.enqueue(async () => {
      await this.ready.promise;
      await this.ensureEncoding();
      const previousSpecs = options.keepTracks ? this.trackSpecs() : [];
      await this.forgetAllTracks();

      const reference = await this.localize(genome.reference);
      const params: BrowserCreateParams = {
        reference,
        locus,
        genomeList: this.deps.genomeList(),
        transport: this.transportSettings(),
      };
      this.deps.log.info(`creating browser for genome ${genome.id}${locus ? ` at ${String(locus)}` : ''}`, this.id);
      const result = await this.rpc.request<BrowserCreateResult>('browser.create', params);
      this.genome = genome;
      this.loci = result.loci;
      this.igvVersion = result.igvVersion;
      this.chromosomeNames = result.chromosomeNames;
      this.panel.title = this.titleFor();

      const warnings: string[] = [];
      let mismatches: GenomeMismatch[] = [];
      if (previousSpecs.length > 0) {
        const r = await this.addTracksInner(previousSpecs, {});
        warnings.push(...r.warnings);
        mismatches = r.mismatches;
      }
      const state = this.getState();
      this._onDidChangeState.fire(state);
      return { ...state, warnings, mismatches };
    });
  }

  goto(locus: string | string[]): Promise<ViewerState> {
    return this.enqueue(async () => {
      this.ensureBrowser();
      const params: BrowserGotoParams = { locus };
      const result = await this.rpc.request<BrowserStateResult>('browser.goto', params);
      this.applyWebviewState(result);
      const state = this.getState();
      this._onDidChangeState.fire(state);
      return state;
    });
  }

  addTracks(specs: TrackSpec[], options: AddTracksOptions = {}): Promise<AddTracksResult> {
    return this.enqueue(async () => {
      this.ensureBrowser();
      const r = await this.addTracksInner(specs, options);
      this._onDidChangeState.fire(this.getState());
      return r;
    });
  }

  removeTracks(selector: { ids?: string[]; names?: string[] }): Promise<{ removed: string[] }> {
    return this.enqueue(async () => {
      this.ensureBrowser();
      const ids = new Set<string>();
      for (const id of selector.ids ?? []) {
        if (!this.tracks.has(id)) throw new RpcError('VIEWER_NOT_FOUND', `No track with id "${id}" in viewer ${this.id}`, { hint: this.trackListHint() });
        ids.add(id);
      }
      for (const name of selector.names ?? []) {
        const matches = [...this.tracks.values()].filter((t) => t.state.name === name);
        if (matches.length === 0) throw new RpcError('VIEWER_NOT_FOUND', `No track named "${name}" in viewer ${this.id}`, { hint: this.trackListHint() });
        for (const m of matches) ids.add(m.state.id);
      }
      if (ids.size === 0) return { removed: [] };
      const result = await this.rpc.request<TracksRemoveResult>('tracks.remove', { ids: [...ids] });
      for (const id of result.removed) {
        const rec = this.tracks.get(id);
        this.tracks.delete(id);
        for (const f of rec?.files ?? []) await this.deps.broker.unregister(this.id, f.fileId);
      }
      this._onDidChangeState.fire(this.getState());
      return { removed: result.removed };
    });
  }

  /** Change options of a loaded track (colour, height, displayMode, visibilityWindow, …). */
  updateTrack(id: string, options: Record<string, unknown>): Promise<TrackState> {
    return this.enqueue(async () => {
      this.ensureBrowser();
      const rec = this.tracks.get(id) ?? [...this.tracks.values()].find((t) => t.state.name === id);
      if (!rec) throw new RpcError('VIEWER_NOT_FOUND', `No track with id or name "${id}" in viewer ${this.id}`, { hint: this.trackListHint() });
      const clean = validateOptions(options);
      const w = await this.rpc.request<WebviewTrackState>('tracks.update', { id: rec.state.id, options: clean });
      rec.spec.options = { ...(rec.spec.options ?? {}), ...clean };
      this.mergeTrackState(rec, w);
      this._onDidChangeState.fire(this.getState());
      return { ...rec.state };
    });
  }

  refreshState(): Promise<ViewerState> {
    return this.enqueue(async () => {
      this.ensureBrowser();
      const result = await this.rpc.request<BrowserStateResult>('browser.state', {});
      this.applyWebviewState(result);
      return this.getState();
    });
  }

  snapshotSvg(): Promise<SnapshotSvgResult> {
    return this.enqueue(async () => {
      this.ensureBrowser();
      await this.settle();
      return this.rpc.request<SnapshotSvgResult>('snapshot.svg', {});
    });
  }

  snapshotPng(scale = 2): Promise<SnapshotPngResult> {
    return this.enqueue(async () => {
      this.ensureBrowser();
      await this.settle();
      const r = await this.rpc.request<SnapshotPngResult>('snapshot.png', { scale });
      const png = r.png as unknown;
      if (!(png instanceof Uint8Array)) {
        throw new RpcError('INTERNAL', 'snapshot PNG did not arrive as binary data');
      }
      return r;
    });
  }

  /** Track specs plus current igv state, for session files (spec §6.7). */
  sessionTracks(): Promise<{ spec: TrackSpec; state?: Record<string, unknown> }[]> {
    return this.enqueue(async () => {
      if (!this.genome) return [];
      const result = await this.rpc.request<TracksStateResult>('tracks.state', {});
      const states = new Map(result.tracks.map((t) => [t.id, t.state]));
      return [...this.tracks.entries()].map(([id, rec]) => ({ spec: { ...rec.spec }, state: states.get(id) }));
    });
  }

  get genomeResolved(): ResolvedGenome | null {
    return this.genome;
  }

  /** Unknown top-level keys from a loaded session, preserved on save. */
  sessionExtra: Record<string, unknown> = {};

  /** Ask the webview to persist a key in its VS Code state so the panel can be restored after a reload. */
  setRestoreKey(key: string): void {
    this.restoreKey = key;
    this.ready.promise.then(() => this.rpc.emit('state.set', { key }), () => undefined);
  }
  private restoreKey: string | undefined;

  /**
   * Resolve when no reads have been in flight for `quietMs` and igv reports
   * no pending track loads (spec §6.3 waitForRender). Returns false on
   * timeout. Not queued: callers inside the queue use it directly.
   */
  async settle(options: SettleOptions = {}): Promise<boolean> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const quietMs = options.quietMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const quietFor = Date.now() - this.lastReadFinished;
      if (this.readsInFlight === 0 && quietFor >= quietMs) {
        const st = await this.rpc.request<BrowserStateResult>('browser.state', {});
        if (st.pendingLoads === 0 && this.readsInFlight === 0 && Date.now() - this.lastReadFinished >= quietMs) {
          this.applyWebviewState(st);
          return true;
        }
      }
      await sleep(Math.min(50, Math.max(10, quietMs - quietFor)));
    }
    return false;
  }

  reveal(preserveFocus = false): void {
    this.panel.reveal(undefined, preserveFocus);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rpc.dispose('viewer closed');
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.tracks.clear();
    void this.deps.broker.releaseViewer(this.id);
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
    this._onDidChangeState.dispose();
    this._onDidChangeViewState.dispose();
    this.deps.log.info('viewer disposed', this.id);
  }

  // ---- internals -----------------------------------------------------------

  private async addTracksInner(specs: TrackSpec[], options: AddTracksOptions): Promise<AddTracksResult> {
    const baseDir = options.baseDir ?? this.deps.workspaceFolders()[0] ?? process.cwd();
    const resolved: { spec: TrackSpec; track: ResolvedTrack }[] = [];
    for (const spec of specs) {
      const track = resolveTrack(spec, {
        baseDir,
        workspaceFolders: this.deps.workspaceFolders(),
        settings: this.deps.resolverSettings(),
        ignoreSizeLimit: spec.loadAnyway === true,
      });
      if (track.format_.needsReference && !this.genomeHasSequence()) {
        throw new RpcError('REFERENCE_REQUIRED', `${track.name} is a CRAM and the current genome has no reference sequence`, {
          hint: 'Load a genome with a FASTA or 2bit sequence (bundled genomes have one).',
        });
      }
      resolved.push({ spec, track });
    }

    if (this.transportMode === 'webviewUri') {
      const newDirs = new Set<string>();
      for (const { track } of resolved) {
        for (const f of [track.file?.absPath, track.indexFile?.absPath]) {
          if (f && !this.extraRoots.has(path.dirname(f))) newDirs.add(path.dirname(f));
        }
      }
      if (newDirs.size > 0) await this.reloadWithRoots([...newDirs]);
    }

    const configs: TrackConfig[] = [];
    const records: TrackRecord[] = [];
    for (const { spec, track } of resolved) {
      const id = `t${this.nextTrackIndex++}`;
      const files: FileHandleInfo[] = [];
      const config: TrackConfig = { id, name: track.name, type: track.type, format: track.format, ...track.options };
      if (track.file && this.transportMode === 'webviewUri') {
        config.url = this.webviewUriFor(track.file.absPath);
        if (track.indexFile) config.indexURL = this.webviewUriFor(track.indexFile.absPath);
      } else if (track.file) {
        const h = await this.deps.broker.register(this.id, track.file.absPath, track.displayPath);
        files.push(h);
        config.url = fileRef(h);
        if (track.indexFile) {
          const hi = await this.deps.broker.register(this.id, track.indexFile.absPath, track.indexFile.absPath);
          files.push(hi);
          config.indexURL = fileRef(hi);
        }
      } else if (track.url) {
        await this.configureRemote(config, track, files, spec);
      }
      const record: TrackRecord = {
        spec: { ...spec, path: track.file ? track.file.absPath : undefined, url: track.url, index: track.indexFile?.absPath ?? track.indexUrl },
        files,
        state: {
          id, name: track.name, type: track.type, format: track.format, source: track.source, displayPath: track.displayPath,
          indexed: track.indexed, inView: true, error: null,
        },
      };
      configs.push(config);
      records.push(record);
      this.tracks.set(id, record);
    }

    // Genome mismatch check (spec §7): compare the file's sequence names with the genome's.
    const warnings: string[] = [];
    const mismatches: GenomeMismatch[] = [];
    const mismatched = new Set<string>();
    if (this.chromosomeNames.length > 0) {
      await Promise.all(
        resolved.map(async ({ track }, i) => {
          const rec = records[i]!;
          const proxy = this.deps.remote().proxy;
          const seq = track.file
            ? await readSequenceNames(track.file.absPath, track.indexFile?.absPath)
            : track.url && proxy
              ? await readSequenceNamesRemote(track.url, proxy, track.indexUrl)
              : undefined;
          if (!seq || seq.names.length === 0) return;
          const cmp = compareSequenceNames(seq.names, this.chromosomeNames);
          if (cmp.matched.length > 0) return;
          mismatched.add(rec.state.id);
          const shown = seq.names.slice(0, 4).join(', ') + (seq.names.length > 4 ? ', …' : '');
          const gshown = this.chromosomeNames.slice(0, 4).join(', ') + (this.chromosomeNames.length > 4 ? ', …' : '');
          mismatches.push({ trackId: rec.state.id, trackName: track.name, fileNames: seq.names.slice(0, 10), genomeId: this.genome?.id ?? '', code: 'GENOME_MISMATCH' });
          warnings.push(`GENOME_MISMATCH: ${track.name} uses sequence names (${shown}) that do not exist in genome ${this.genome?.id ?? ''} (${gshown}). Choose a matching genome with "IGV: Set Genome…".`);
          this.deps.log.warn(`genome mismatch for ${track.name}: file has ${shown}; genome ${this.genome?.id} has ${gshown}`, this.id);
        }),
      );
    }

    let result = await this.rpc.request<TracksAddResult>('tracks.add', { tracks: configs });
    result = await this.retryViaProxy(result, configs, resolved, records);
    for (const w of result.added) {
      const rec = this.tracks.get(w.id);
      if (!rec) continue;
      this.mergeTrackState(rec, w);
      if (mismatched.has(w.id)) {
        rec.state.inView = false;
        rec.state.inViewReason = 'genomeMismatch';
      }
      if (w.error) {
        warnings.push(`${w.name}: ${w.error}`);
        this.deps.log.warn(`track ${w.id} (${w.name}) failed to load: ${w.error}`, this.id);
      }
    }
    return { added: records.map((r) => ({ ...r.state })), warnings, mismatches };
  }

  /**
   * webviewUri mode (spec §4.2): expose the file's directory as a resource
   * root and hand igv a vscode-resource URL that the host serves with HTTP
   * range support. Widens readable roots to whole directories, hence opt-in.
   */
  private webviewUriFor(absPath: string): string {
    if (!this.extraRoots.has(path.dirname(absPath))) {
      throw new RpcError('INTERNAL', `resource root for ${absPath} was not registered before use`);
    }
    return this.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
  }

  /**
   * Changing `localResourceRoots` reloads the webview (spec §4.2, §14), which
   * destroys the igv browser. So: widen the roots, reload, wait for the new
   * "ready", recreate the browser at the same loci and re-add the existing
   * tracks. Called from inside the operation queue.
   */
  private async reloadWithRoots(dirs: string[]): Promise<void> {
    for (const d of dirs) this.extraRoots.add(d);
    const genome = this.genome;
    const loci = this.loci;
    const previous = this.trackSpecs();
    this.deps.log.info(`webviewUri transport: adding resource root(s) ${dirs.join(', ')} and reloading the viewer (${previous.length} track(s) replayed)`, this.id);
    await this.forgetAllTracks();
    this.resetReady();
    this.encoding = undefined;
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.deps.extensionUri, 'media'),
        vscode.Uri.joinPath(this.deps.extensionUri, 'dist'),
        ...[...this.extraRoots].map((d) => vscode.Uri.file(d)),
      ],
    };
    this.loadHtml();
    await this.ready.promise;
    if (this.restoreKey) this.rpc.emit('state.set', { key: this.restoreKey });
    await this.ensureEncoding();
    if (!genome) return;
    const result = await this.rpc.request<BrowserCreateResult>('browser.create', {
      reference: await this.localize(genome.reference),
      locus: loci.length === 1 ? loci[0] : loci.length > 1 ? loci : undefined,
      genomeList: this.deps.genomeList(),
      transport: this.transportSettings(),
    });
    this.loci = result.loci;
    this.chromosomeNames = result.chromosomeNames;
    if (previous.length > 0) {
      const r = await this.addTracksInner(previous, {});
      for (const w of r.warnings) this.deps.log.warn(`after reload: ${w}`, this.id);
    }
  }

  /** Decide how a URL track reaches igv: directly from the browser, or through the host proxy. */
  private async configureRemote(config: TrackConfig, track: ResolvedTrack, files: FileHandleInfo[], spec: TrackSpec): Promise<void> {
    const url = track.url!;
    const { mode, proxy } = this.deps.remote();
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      // keep ''
    }
    const useProxy = mode === 'proxy' || (mode === 'auto' && origin !== '' && this.deps.proxiedOrigins.has(origin));
    if (!useProxy) {
      config.url = url;
      if (track.indexUrl) config.indexURL = track.indexUrl;
      return;
    }
    if (!proxy) throw new RpcError('INTERNAL', 'igv.remote.mode is "proxy" but no proxy is configured');
    const h = await this.deps.broker.registerUrl(this.id, url);
    files.push(h);
    config.url = fileRef(h);
    let indexUrl = track.indexUrl;
    if (!indexUrl && (track.format_.indexable || track.format_.compressed) && !track.format_.selfIndexed) {
      for (const cand of indexCandidates(url)) {
        if (await proxy.exists(cand)) {
          indexUrl = cand;
          break;
        }
      }
      if (!indexUrl && (track.format === 'bam' || track.format === 'cram')) {
        throw new RpcError('INDEX_REQUIRED', `No index found next to ${url}`, {
          hint: `Pass the index URL explicitly (e.g. "index": "${url}.bai"). Tried: ${indexCandidates(url).join(', ')}`,
        });
      }
    }
    if (indexUrl) {
      const hi = await this.deps.broker.registerUrl(this.id, indexUrl);
      files.push(hi);
      config.indexURL = fileRef(hi);
    } else if (!track.format_.selfIndexed) {
      config.indexed = false;
    }
    this.deps.log.info(`loading ${url} through the remote proxy${indexUrl ? ` (index ${indexUrl})` : ''}`, this.id);
    void spec;
  }

  /** "auto" remote mode: when a direct URL load fails like a CORS/network error, retry once via the proxy. */
  private async retryViaProxy(result: TracksAddResult, configs: TrackConfig[], resolved: { spec: TrackSpec; track: ResolvedTrack }[], records: TrackRecord[]): Promise<TracksAddResult> {
    const { mode, proxy } = this.deps.remote();
    if (mode !== 'auto' || !proxy) return result;
    const retries: { index: number; config: TrackConfig }[] = [];
    for (let i = 0; i < result.added.length; i++) {
      const w = result.added[i]!;
      const r = resolved[i];
      if (!w.error || !r?.track.url || typeof configs[i]!.url !== 'string' || !looksLikeNetworkError(w.error)) continue;
      const origin = new URL(r.track.url).origin;
      this.deps.proxiedOrigins.add(origin);
      this.deps.log.warn(`direct load of ${r.track.url} failed (${w.error}); retrying through the proxy and remembering ${origin}`, this.id);
      const config: TrackConfig = { ...configs[i]! };
      delete config.indexURL;
      await this.configureRemote(config, r.track, records[i]!.files, r.spec);
      retries.push({ index: i, config });
    }
    if (retries.length === 0) return result;
    await this.rpc.request<TracksRemoveResult>('tracks.remove', { ids: retries.map((r) => r.config.id) });
    const again = await this.rpc.request<TracksAddResult>('tracks.add', { tracks: retries.map((r) => r.config) });
    const added = [...result.added];
    retries.forEach((r, k) => {
      added[r.index] = again.added[k]!;
    });
    return { added };
  }

  private async forgetAllTracks(): Promise<void> {
    const files = [...this.tracks.values()].flatMap((t) => t.files);
    this.tracks.clear();
    for (const f of files) await this.deps.broker.unregister(this.id, f.fileId);
  }

  private mergeTrackState(rec: TrackRecord, w: WebviewTrackState): void {
    if (rec.state.inViewReason === 'genomeMismatch') {
      rec.state.error = w.error;
      return;
    }
    rec.state.inView = w.inView;
    rec.state.inViewReason = w.inViewReason;
    rec.state.error = w.error;
    if (w.name) rec.state.name = w.name;
  }

  private applyWebviewState(result: BrowserStateResult): void {
    this.loci = result.loci;
    for (const w of result.tracks) {
      const rec = this.tracks.get(w.id);
      if (rec) this.mergeTrackState(rec, w);
    }
  }

  /** Replace local-path markers in a reference with broker handles. */
  private localize<T>(value: T): Promise<T> {
    return replaceLocalPaths(value, async (absPath) => fileRef(await this.deps.broker.register(this.id, absPath, absPath)));
  }

  private genomeHasSequence(): boolean {
    const r = this.genome?.reference;
    return !!(r && (r.fastaURL || r.twoBitURL));
  }

  private async handleRead(params: ReadParams): Promise<Uint8Array | string> {
    this.readsInFlight++;
    try {
      const bytes = await this.deps.broker.read(this.id, params.fileId, params.start, params.end);
      if (this.encoding === 'base64') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
      return bytes;
    } finally {
      this.readsInFlight--;
      this.lastReadFinished = Date.now();
    }
  }

  /** Startup capability probe (spec §4.1): binary payloads, else base64. */
  private async ensureEncoding(): Promise<void> {
    if (this.encoding) return;
    const bytes = new Uint8Array(256).map((_, i) => i);
    try {
      const r = await this.rpc.request<ProbeResult>('transport.probe', { bytes }, 10_000);
      const echo = r.echo as unknown;
      const echoOk = echo instanceof Uint8Array && echo.length === 256 && echo.every((b, i) => b === i);
      this.encoding = r.receivedBinary && echoOk ? 'binary' : 'base64';
    } catch (err) {
      this.deps.log.warn(`transport probe failed (${String(err)}); using base64`, this.id);
      this.encoding = 'base64';
    }
    if (this.encoding === 'base64') {
      this.deps.log.warn('binary payloads do not round-trip through this webview; falling back to base64 for the session', this.id);
    } else {
      this.deps.log.debug('transport probe: binary payloads OK', this.id);
    }
  }

  private transportSettings(): TransportSettings {
    return { ...this.deps.transport(), encoding: this.encoding ?? 'base64' };
  }

  private titleFor(): string {
    const g = this.genome ? ` · ${this.genome.id}` : '';
    return `IGV ${this.name}${g}`;
  }

  private trackListHint(): string {
    const list = [...this.tracks.values()].map((t) => `${t.state.id} "${t.state.name}"`);
    return list.length ? `Tracks in this viewer: ${list.join(', ')}` : 'This viewer has no tracks.';
  }

  private ensureBrowser(): void {
    if (!this.genome) {
      throw new RpcError('INTERNAL', `viewer ${this.id} has no genome loaded`, {
        hint: 'Call viewer.setGenome (or "IGV: Set Genome…") first.',
      });
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new RpcError('VIEWER_NOT_FOUND', `viewer ${this.id} has been closed`));
    }
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private wireEvents(): void {
    const log = this.deps.log;
    this.rpc.on('ready', () => {
      log.debug('webview ready', this.id);
      this.ready.resolve();
    });
    this.rpc.on('log', (p) => {
      const e = p as LogEvent;
      log.log(e.level, `webview: ${e.message}`, this.id);
    });
    this.rpc.on('error', (p) => {
      const e = p as ErrorEvent;
      log.error(`webview ${e.source}: ${e.message}${e.stack ? `\n${e.stack}` : ''}`, this.id);
    });
    this.rpc.on('alert', (p) => {
      const e = p as AlertEvent;
      log.warn(`igv alert: ${e.message}`, this.id);
      void vscode.window.showWarningMessage(`IGV (${this.name}): ${e.message}`);
    });
    this.rpc.on('locuschange', (p) => {
      const e = p as LocusChangeEvent;
      this.loci = e.loci;
      this._onDidChangeState.fire(this.getState());
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
