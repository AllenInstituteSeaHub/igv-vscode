/**
 * Single source of truth for the viewer/agent API types (spec §6.3, §15).
 * This file must stay free of `vscode` and Node imports: it is shared by the
 * extension host, the webview bundle, the CLI and the MCP server.
 */

export const PROTOCOL_VERSION = 1;

export type ErrorCode =
  | 'NO_VIEWER'
  | 'VIEWER_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_FORMAT'
  | 'INDEX_REQUIRED'
  | 'REFERENCE_REQUIRED'
  | 'GENOME_NOT_FOUND'
  | 'GENOME_MISMATCH'
  | 'REMOTE_UNREACHABLE'
  | 'TOOL_MISSING'
  | 'TIMEOUT'
  | 'AGENT_DISABLED'
  | 'UNAUTHORIZED'
  | 'INTERNAL';

export type GenomeSource = 'bundled-list' | 'refreshed-list' | 'custom' | 'local-file' | 'url';

export interface GenomeRef {
  id: string;
  name: string;
  source: GenomeSource;
}

export interface GenomeSummary extends GenomeRef {
  description?: string;
}

/** An igv.js reference object. We pass these to createBrowser as `reference` (spec §7). */
export interface IgvReference {
  id: string;
  name?: string;
  fastaURL?: string | object;
  indexURL?: string | object;
  twoBitURL?: string | object;
  twoBitBptURL?: string | object;
  cytobandURL?: string | object;
  cytobandBbURL?: string | object;
  aliasURL?: string | object;
  chromAliasBbURL?: string | object;
  chromSizesURL?: string | object;
  chromosomeOrder?: string | string[];
  wholeGenomeView?: boolean;
  tracks?: Record<string, unknown>[];
  hubs?: string[];
  [key: string]: unknown;
}

export interface ResolvedGenome extends GenomeRef {
  reference: IgvReference;
}

export interface TrackState {
  id: string;
  name: string;
  type: string;
  format: string;
  /** Absolute path or URL. */
  source: string;
  /** Workspace-relative path where possible, for labels. */
  displayPath: string;
  indexed: boolean;
  inView: boolean;
  inViewReason?: 'outsideVisibilityWindow' | 'genomeMismatch';
  error: string | null;
}

export interface ViewerMetrics {
  requests: number;
  bytes: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  /** Bytes read as a fraction of total file size, per file id. */
  files: { fileId: string; displayPath: string; size: number; bytesRead: number; requests: number }[];
}

export interface ViewerState {
  id: string;
  name: string;
  genome: GenomeRef | null;
  loci: string[];
  tracks: TrackState[];
  metrics?: ViewerMetrics;
}

export interface ViewerSummary {
  id: string;
  name: string;
  genome: GenomeRef | null;
  loci: string[];
  trackCount: number;
  visible: boolean;
  active: boolean;
}

export interface TrackSpec {
  path?: string;
  url?: string;
  index?: string;
  name?: string;
  type?: string;
  format?: string;
  options?: Record<string, unknown>;
  autoIndex?: boolean;
  subsample?: { fraction?: number; reads?: number; seed?: number; region?: string };
  /** Load an unindexed file whole even when it exceeds igv.largeFile.unindexedMaxBytes. */
  loadAnyway?: boolean;
}

// ---------------------------------------------------------------------------
// Control channel (spec §6.2, §6.3): JSON-RPC 2.0, newline-delimited.
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
  /** Auth token (spec §6.2). Required on every request. */
  token?: string;
}

export interface JsonRpcErrorData {
  code: ErrorCode;
  hint?: string;
  [key: string]: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonRpcErrorData;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Application error; `data.code` carries the ErrorCode. */
  APP_ERROR: -32000,
  UNAUTHORIZED: -32001,
} as const;

export type HostKind = 'desktop' | 'remote' | 'code-server';

export interface PingResult {
  version: string;
  igvVersion: string;
  vscodeVersion: string;
  host: HostKind;
  workspaceFolders: string[];
  protocolVersion: number;
}

export type ReuseMode = 'new' | 'active' | 'byName';

export interface ViewerOpenParams {
  name?: string;
  genome?: string;
  locus?: string | string[];
  tracks?: TrackSpec[];
  reuse?: ReuseMode;
  show?: boolean;
  waitForRender?: boolean;
  timeoutMs?: number;
  /** Directory relative paths resolve against (the CLI sends its cwd). */
  cwd?: string;
}

export interface ViewerOpenResult extends ViewerState {
  settled: boolean;
  warnings: string[];
}

export interface ViewerTargetParams {
  viewer?: string;
}

export interface ViewerStateParams extends ViewerTargetParams {
  verbose?: boolean;
}

export interface ViewerGotoParams extends ViewerTargetParams {
  locus: string | string[];
  waitForRender?: boolean;
  timeoutMs?: number;
}

export interface ViewerSetGenomeParams extends ViewerTargetParams {
  genome: string;
  keepTracks?: boolean;
  cwd?: string;
}

export interface TracksAddParams extends ViewerTargetParams {
  tracks: TrackSpec[];
  waitForRender?: boolean;
  timeoutMs?: number;
  cwd?: string;
}

export interface TracksAddResult {
  added: TrackState[];
  warnings: string[];
  settled: boolean;
}

export interface TracksRemoveParams extends ViewerTargetParams {
  names?: string[];
  ids?: string[];
}

export interface TracksRemoveResult {
  removed: string[];
}

export interface TracksUpdateParams extends ViewerTargetParams {
  id: string;
  options: Record<string, unknown>;
}

export interface ViewerSnapshotParams extends ViewerTargetParams {
  format?: 'png' | 'svg';
  out?: string;
  scale?: number;
  inline?: boolean;
  cwd?: string;
}

export interface ViewerSnapshotResult {
  path: string;
  format: 'png' | 'svg';
  width: number;
  height: number;
  locus: string[];
  base64?: string;
}

export interface SessionSaveParams extends ViewerTargetParams {
  path: string;
  relativePaths?: boolean;
  cwd?: string;
}

export interface SessionSaveResult {
  path: string;
}

export interface SessionLoadParams extends ViewerTargetParams {
  path: string;
  reuse?: ReuseMode;
  cwd?: string;
}

export interface ViewerCloseParams extends ViewerTargetParams {
  all?: boolean;
}

export interface ViewerCloseResult {
  closed: string[];
}

export interface GenomesListParams {
  filter?: string;
}

export interface GenomesListResult {
  genomes: GenomeSummary[];
}

export const CONTROL_METHODS = [
  'ping',
  'viewer.open',
  'viewer.list',
  'viewer.state',
  'viewer.goto',
  'viewer.setGenome',
  'tracks.add',
  'tracks.remove',
  'tracks.update',
  'viewer.snapshot',
  'session.save',
  'session.load',
  'viewer.close',
  'genomes.list',
] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

/** Instance registry entry: ~/.igv-vscode/instances/<id>.json (spec §6.2). */
export interface InstanceRecord {
  id: string;
  endpoint: string;
  token: string;
  pid: number;
  workspaceFolders: string[];
  startedAt: string;
  lastActiveAt: string;
  version: string;
  host: HostKind;
}
