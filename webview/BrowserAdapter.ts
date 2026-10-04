/**
 * The only module that touches the igv API (spec §3.2). Creates a fresh
 * container element for every browser instance because igv 3.x renders into
 * a shadow root on the parent div and reuses it (spec §14 #7).
 */
import type { IgvBrowser, IgvReferenceFrame, IgvTrack } from './igv';
import { svgToPng, type PngSnapshot } from './Snapshot';
import type {
  BrowserCreateParams,
  BrowserCreateResult,
  BrowserStateResult,
  SnapshotSvgResult,
  TrackConfig,
  TracksStateResult,
  TracksAddResult,
  TransportSettings,
  WebviewTrackState,
} from '../src/shared/webviewProtocol';
import { RangeCache, hydrateFileRefs, type FileHandleInfo, type ReadTransport } from './FileLike';

/** igv.version is a function in 3.8.9 and a string in some older builds. */
export function igvVersion(): string {
  const v = (igv as { version?: unknown }).version;
  if (typeof v === 'function') {
    try {
      return String((v as () => unknown)());
    } catch {
      return '';
    }
  }
  return typeof v === 'string' ? v : '';
}

export interface BrowserAdapterEvents {
  onLocusChange(loci: string[]): void;
  onAlert(message: string): void;
  onLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

interface TrackEntry {
  id: string;
  config: TrackConfig;
  track: IgvTrack | null;
  files: FileHandleInfo[];
  error: string | null;
}

export class BrowserAdapter {
  private browser: IgvBrowser | null = null;
  private container: HTMLElement | null = null;
  private readonly tracks = new Map<string, TrackEntry>();
  private transport: TransportSettings = { maxChunkBytes: 8 * 1024 * 1024, encoding: 'binary', cacheMaxEntryBytes: 1024 * 1024, cacheTotalBytes: 64 * 1024 * 1024 };
  private cache = new RangeCache();
  private pendingLoads = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly reads: ReadTransport,
    private readonly events: BrowserAdapterEvents,
  ) {}

  get hasBrowser(): boolean {
    return this.browser !== null;
  }

  get cacheStats(): { hits: number; misses: number; bytes: number; entries: number } {
    return { hits: this.cache.hits, misses: this.cache.misses, bytes: this.cache.bytes, entries: this.cache.size };
  }

  async create(params: BrowserCreateParams): Promise<BrowserCreateResult> {
    await this.destroy();
    this.transport = params.transport;
    this.cache = new RangeCache(params.transport.cacheMaxEntryBytes, params.transport.cacheTotalBytes);

    const container = document.createElement('div');
    container.className = 'igv-container';
    this.root.replaceChildren(container);
    this.container = container;

    const reference = hydrateFileRefs(params.reference, this.reads, this.fileOptions());
    const config: Record<string, unknown> = {
      reference,
      genomeList: params.genomeList,
      loadDefaultGenomes: false,
      showSVGButton: false,
      tracks: [],
    };
    if (params.locus !== undefined) config.locus = Array.isArray(params.locus) ? params.locus.join(' ') : params.locus;

    let browser: IgvBrowser;
    try {
      browser = await igv.createBrowser(container, config);
    } catch (err) {
      // Never retry into the same element (spec §10).
      container.remove();
      this.container = null;
      throw err;
    }
    this.browser = browser;
    this.interceptAlerts(browser);
    browser.on('locuschange', (frames: unknown) => {
      this.events.onLocusChange(lociFromFrames(frames as IgvReferenceFrame[] | undefined, browser));
    });
    this.events.onLog('info', `igv browser created (igv ${igvVersion() || 'unknown version'})`);
    return { loci: this.currentLoci(), igvVersion: igvVersion(), chromosomeNames: chromosomeNames(browser) };
  }

  async goto(locus: string | string[]): Promise<BrowserStateResult> {
    const browser = this.require();
    // igv.search takes one string; several loci are space-separated (multi-locus view).
    await browser.search(Array.isArray(locus) ? locus.join(' ') : locus);
    return this.state();
  }

  state(): BrowserStateResult {
    const browser = this.require();
    return { loci: this.currentLoci(), tracks: this.trackStates(browser), pendingLoads: this.pendingLoads };
  }

  async addTracks(configs: TrackConfig[]): Promise<TracksAddResult> {
    const browser = this.require();
    const added: WebviewTrackState[] = [];
    for (const config of configs) {
      const files: FileHandleInfo[] = [];
      const hydrated = hydrateFileRefs(config, this.reads, this.fileOptions(), files);
      const entry: TrackEntry = { id: config.id, config, track: null, files, error: null };
      this.tracks.set(config.id, entry);
      this.pendingLoads++;
      try {
        entry.track = await browser.loadTrack(hydrated as Record<string, unknown>);
        if (!entry.track) throw new Error('igv returned no track');
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
        this.events.onLog('error', `loadTrack ${config.name}: ${entry.error}${err instanceof Error && err.stack ? `\n${err.stack}` : ''}`);
        for (const f of files) this.cache.evictFile(f.fileId);
        // igv may have added the track before a draw error rejected loadTrack; drop it so state stays consistent.
        const zombie = browser.trackViews.find((tv) => tv.track && (tv.track as { config?: { id?: unknown } }).config?.id === config.id)?.track;
        if (zombie) {
          try {
            browser.removeTrack(zombie);
          } catch {
            // best effort
          }
        }
      } finally {
        this.pendingLoads--;
      }
      added.push(this.stateFor(entry, browser));
    }
    return { added };
  }

  removeTracks(ids: string[]): string[] {
    const browser = this.require();
    const removed: string[] = [];
    for (const id of ids) {
      const entry = this.tracks.get(id);
      if (!entry) continue;
      if (entry.track) {
        try {
          browser.removeTrack(entry.track);
        } catch (err) {
          this.events.onLog('warn', `removeTrack ${id}: ${String(err)}`);
        }
      }
      for (const f of entry.files) this.cache.evictFile(f.fileId);
      this.tracks.delete(id);
      removed.push(id);
    }
    return removed;
  }

  /** Apply validated igv options to a loaded track and repaint (spec §6.3 tracks.update). */
  async updateTrack(id: string, options: Record<string, unknown>): Promise<WebviewTrackState> {
    const browser = this.require();
    const entry = this.tracks.get(id);
    if (!entry) throw new Error(`no track with id ${id}`);
    if (!entry.track) throw new Error(`track ${id} failed to load and cannot be updated`);
    const t = entry.track;
    let needsData = false;
    for (const [k, v] of Object.entries(options)) {
      if (k === 'height' && typeof v === 'number') {
        t.trackView?.setTrackHeight?.(v, true);
        t.height = v;
        continue;
      }
      if (k === 'name' && typeof v === 'string') {
        t.name = v;
        continue;
      }
      t[k] = v;
      if (k === 'visibilityWindow' || k === 'samplingDepth' || k === 'samplingWindowSize' || k === 'filter' || k === 'colorBy' || k === 'displayMode' || k === 'sort') needsData = true;
    }
    entry.config = { ...entry.config, ...options };
    if (needsData) {
      // Clear cached features so the new window/sampling takes effect, then reload the view.
      const anyTrack = t as { clearCachedFeatures?: () => void; featureSource?: { clearCache?: () => void } };
      anyTrack.clearCachedFeatures?.();
      anyTrack.featureSource?.clearCache?.();
      await (t.trackView?.updateViews?.() ?? browser.updateViews());
    } else {
      t.trackView?.checkContentHeight?.();
      (t.trackView?.repaintViews ?? browser.repaintViews.bind(browser))();
    }
    return this.stateFor(entry, browser);
  }

  snapshotSvg(): SnapshotSvgResult {
    const browser = this.require();
    const svg = browser.toSVG();
    const w = /\swidth="([\d.]+)/.exec(svg);
    const h = /\sheight="([\d.]+)/.exec(svg);
    return { svg, width: w ? Number(w[1]) : 0, height: h ? Number(h[1]) : 0 };
  }

  async snapshotPng(scale = 2): Promise<PngSnapshot> {
    const { svg } = this.snapshotSvg();
    return svgToPng(svg, scale);
  }

  /** Current igv state per track, sanitised for session saving. */
  tracksState(): TracksStateResult {
    this.require();
    const out: TracksStateResult['tracks'] = [];
    for (const entry of this.tracks.values()) {
      const t = entry.track as (IgvTrack & { getState?: () => Record<string, unknown> }) | null;
      let raw: Record<string, unknown> = {};
      if (t && typeof t.getState === 'function') {
        try {
          raw = t.getState() ?? {};
        } catch (err) {
          this.events.onLog('warn', `getState failed for ${entry.id}: ${String(err)}`);
        }
      }
      out.push({ id: entry.id, state: sanitizeState(raw) });
    }
    return { tracks: out };
  }

  async destroy(): Promise<void> {
    if (this.browser) {
      try {
        igv.removeBrowser(this.browser);
      } catch (err) {
        this.events.onLog('warn', `removeBrowser failed: ${String(err)}`);
      }
      this.browser = null;
    }
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    this.tracks.clear();
    this.cache.clear();
  }

  private fileOptions() {
    return { maxChunkBytes: this.transport.maxChunkBytes, encoding: this.transport.encoding, cache: this.cache };
  }

  private require(): IgvBrowser {
    if (!this.browser) throw new Error('no igv browser has been created in this viewer');
    return this.browser;
  }

  private currentLoci(): string[] {
    return lociFromFrames(this.require().referenceFrameList, this.require());
  }

  private trackStates(browser: IgvBrowser): WebviewTrackState[] {
    return [...this.tracks.values()].map((e) => this.stateFor(e, browser));
  }

  private stateFor(entry: TrackEntry, browser: IgvBrowser): WebviewTrackState {
    const frames = browser.referenceFrameList ?? [];
    const widest = frames.reduce((max, f) => Math.max(max, f.end - f.start), 0);
    const t = entry.track;
    const vw =
      t && typeof t.visibilityWindow === 'number'
        ? t.visibilityWindow
        : typeof entry.config.visibilityWindow === 'number'
          ? (entry.config.visibilityWindow as number)
          : undefined;
    const outside = vw !== undefined && vw > 0 && widest > vw;
    return {
      id: entry.id,
      name: t?.name ?? entry.config.name,
      type: t?.type ?? entry.config.type,
      format: entry.config.format,
      inView: !outside && entry.error === null,
      inViewReason: outside ? 'outsideVisibilityWindow' : undefined,
      error: entry.error,
    };
  }

  /** Route igv's alert dialogs to the host instead of showing them (spec §10). */
  private interceptAlerts(browser: IgvBrowser): void {
    if (!browser.alert) return;
    browser.alert.present = (alert: unknown, callback?: () => void) => {
      const message =
        typeof alert === 'string'
          ? alert
          : alert && typeof (alert as { message?: unknown }).message === 'string'
            ? (alert as { message: string }).message
            : String(alert);
      this.events.onAlert(message);
      callback?.();
    };
  }
}

/**
 * Locus strings in IGV display convention: 1-based, inclusive, thousands
 * separators. igv's own currentLoci() can return fractional coordinates
 * (e.g. "chrT:1000-3999.9999999999995"), so we format from the frames.
 */
export function formatLocus(chr: string, start0: number, end: number): string {
  const s = Math.round(start0) + 1;
  const e = Math.max(s, Math.round(end));
  return `${chr}:${s.toLocaleString('en-US')}-${e.toLocaleString('en-US')}`;
}

const STATE_SKIP = new Set(['url', 'indexURL', 'id', 'name', 'type', 'format', 'sourceType', 'filename', 'file']);

/** Keep only JSON primitives (and arrays/objects of them), drop igv internals. */
export function sanitizeState(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_') || STATE_SKIP.has(k)) continue;
    const clean = plain(v, 0);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

function plain(v: unknown, depth: number): unknown {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return Number.isFinite(v as number) ? v : undefined;
  if (depth >= 3 || t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') return undefined;
  if (Array.isArray(v)) {
    const arr = v.map((x) => plain(x, depth + 1)).filter((x) => x !== undefined);
    return arr.length === v.length ? arr : undefined;
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return undefined; // class instances (File-likes, Maps, …)
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const c = plain(x, depth + 1);
      if (c !== undefined) o[k] = c;
    }
    return o;
  }
  return undefined;
}

function lociFromFrames(frames: IgvReferenceFrame[] | undefined, browser: IgvBrowser): string[] {
  if (Array.isArray(frames) && frames.length > 0) {
    return frames.map((f) => formatLocus(f.chr, f.start, f.end));
  }
  const loci = browser.currentLoci();
  return Array.isArray(loci) ? loci : loci ? [loci] : [];
}

function chromosomeNames(browser: IgvBrowser): string[] {
  const g = browser.genome;
  if (!g) return [];
  if (Array.isArray(g.chromosomeNames)) return [...g.chromosomeNames];
  const c = g.chromosomes;
  if (c instanceof Map) return [...c.keys()];
  if (c && typeof c === 'object') return Object.keys(c);
  return [];
}
