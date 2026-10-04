/**
 * Messages exchanged between the extension host (ViewerController) and the
 * webview (main.ts) over the Rpc class. Host→webview calls are requests on the
 * `browser.*`, `tracks.*`, `snapshot.*` and `transport.*` namespaces;
 * webview→host traffic is `read` requests and events.
 */
import type { IgvReference } from '../agent/protocol';

export type PayloadEncoding = 'binary' | 'base64';

export interface TransportSettings {
  maxChunkBytes: number;
  encoding: PayloadEncoding;
  cacheMaxEntryBytes: number;
  cacheTotalBytes: number;
}

/** Host → webview requests. */
export interface BrowserCreateParams {
  /** Reference object; local files appear as `{__igvVscodeFile}` markers. */
  reference: IgvReference;
  locus?: string | string[];
  /** Merged genome list passed as `genomeList` with `loadDefaultGenomes:false` (spec §7). */
  genomeList: IgvReference[];
  transport: TransportSettings;
}

export interface BrowserCreateResult {
  loci: string[];
  igvVersion: string;
  /** Sequence names known to the loaded genome (for mismatch checks and locus validation). */
  chromosomeNames: string[];
}

export interface BrowserGotoParams {
  locus: string | string[];
}

export interface WebviewTrackState {
  /** Host-assigned id (t1, t2, …). */
  id: string;
  name: string;
  type: string;
  format: string;
  inView: boolean;
  inViewReason?: 'outsideVisibilityWindow' | 'genomeMismatch';
  error: string | null;
}

export interface BrowserStateResult {
  loci: string[];
  tracks: WebviewTrackState[];
  /** Number of igv track loads still pending, as far as the webview can tell. */
  pendingLoads: number;
}

/** An igv track config with a host-assigned id; file inputs are `{__igvVscodeFile}` markers. */
export type TrackConfig = Record<string, unknown> & { id: string; name: string; type: string; format: string };

export interface TracksAddParams {
  tracks: TrackConfig[];
}

export interface TracksAddResult {
  added: WebviewTrackState[];
}

export interface TracksRemoveParams {
  ids: string[];
}

export interface TracksUpdateParams {
  id: string;
  /** Validated igv track options to apply live. */
  options: Record<string, unknown>;
}

export interface TracksRemoveResult {
  removed: string[];
}

export interface SnapshotSvgResult {
  svg: string;
  width: number;
  height: number;
}

export interface SnapshotPngParams {
  /** Device scale factor; 2 by default (spec §6.3). */
  scale?: number;
}

export interface SnapshotPngResult {
  png: Uint8Array;
  width: number;
  height: number;
}

/** Per-track igv state (`track.getState()`), sanitised to JSON primitives. */
export interface TracksStateResult {
  tracks: { id: string; state: Record<string, unknown> }[];
}

export interface ProbeParams {
  bytes: Uint8Array;
}

export interface ProbeResult {
  /** True when `bytes` arrived as a Uint8Array with the expected content. */
  receivedBinary: boolean;
  echo: Uint8Array;
}

/** Webview → host requests. */
export interface ReadParams {
  fileId: string;
  start: number;
  end: number;
}

/** Webview → host events. */
export interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface ErrorEvent {
  message: string;
  stack?: string;
  source: 'onerror' | 'unhandledrejection' | 'securitypolicyviolation' | 'igv';
}

export interface LocusChangeEvent {
  loci: string[];
}

export interface AlertEvent {
  message: string;
}

export interface ReadyEvent {
  igvVersion: string;
}
