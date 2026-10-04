/**
 * Webview entry point: boots the RPC channel, wires global error capture and
 * delegates igv operations to BrowserAdapter. Byte reads for File-like
 * objects go back to the host as `read` requests.
 */
import { Rpc, isRpcMessage } from './rpc';
import { BrowserAdapter, igvVersion } from './BrowserAdapter';
import type { ReadParams } from './FileLike';
import type {
  BrowserCreateParams,
  BrowserGotoParams,
  ErrorEvent,
  LogEvent,
  ProbeParams,
  ProbeResult,
  ReadyEvent,
  SnapshotPngParams,
  TracksAddParams,
  TracksRemoveParams,
  TracksUpdateParams,
} from '../src/shared/webviewProtocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const rpc = new Rpc((m) => vscode.postMessage(m), { defaultTimeoutMs: 0 });

window.addEventListener('message', (e: MessageEvent) => {
  if (isRpcMessage(e.data)) void rpc.dispatch(e.data);
});

function reportError(source: ErrorEvent['source'], message: string, stack?: string): void {
  const payload: ErrorEvent = { source, message, stack };
  rpc.emit('error', payload);
}
window.addEventListener('error', (e) => reportError('onerror', e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  reportError('unhandledrejection', r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined);
});
document.addEventListener('securitypolicyviolation', (e) =>
  reportError('securitypolicyviolation', `${e.violatedDirective} blocked ${e.blockedURI}`),
);

const root = document.getElementById('igv-root');
const status = document.getElementById('igv-status');
if (!root || !status) throw new Error('viewer document is missing #igv-root or #igv-status');

function setStatus(text: string | null): void {
  if (!status) return;
  status.textContent = text ?? '';
  status.hidden = text === null;
}

const reads = {
  read: (p: ReadParams) => rpc.request<Uint8Array | string>('read', p),
};

const adapter = new BrowserAdapter(root, reads, {
  onLocusChange: (loci) => rpc.emit('locuschange', { loci }),
  onAlert: (message) => rpc.emit('alert', { message }),
  onLog: (level, message) => rpc.emit('log', { level, message } satisfies LogEvent),
});

rpc.handle('transport.probe', (params) => {
  const { bytes } = params as ProbeParams;
  const ok = bytes instanceof Uint8Array && bytes.length === 256 && bytes.every((b, i) => b === i);
  const result: ProbeResult = { receivedBinary: ok, echo: ok ? bytes : new Uint8Array(0) };
  return result;
});

rpc.handle('browser.create', async (params) => {
  setStatus('Loading genome…');
  try {
    const result = await adapter.create(params as BrowserCreateParams);
    setStatus(null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`Failed to load genome: ${message}`);
    reportError('igv', message, err instanceof Error ? err.stack : undefined);
    throw err;
  }
});
rpc.handle('browser.goto', (params) => adapter.goto((params as BrowserGotoParams).locus));
rpc.handle('browser.state', () => adapter.state());
rpc.handle('browser.destroy', async () => {
  await adapter.destroy();
  setStatus('No genome loaded');
  return {};
});
rpc.handle('tracks.add', (params) => adapter.addTracks((params as TracksAddParams).tracks));
rpc.handle('tracks.remove', (params) => ({ removed: adapter.removeTracks((params as TracksRemoveParams).ids) }));
rpc.handle('tracks.update', (params) => {
  const p = params as TracksUpdateParams;
  return adapter.updateTrack(p.id, p.options);
});
rpc.handle('snapshot.svg', () => adapter.snapshotSvg());
rpc.handle('snapshot.png', (params) => adapter.snapshotPng((params as SnapshotPngParams | undefined)?.scale ?? 2));
rpc.handle('tracks.state', () => adapter.tracksState());
rpc.handle('cache.stats', () => adapter.cacheStats);
rpc.on('state.set', (p) => vscode.setState({ key: (p as { key: string }).key }));

if (typeof igv === 'undefined') {
  setStatus('igv.js failed to load');
  reportError('igv', 'igv global is undefined; media/igv.min.js did not load');
} else {
  setStatus('Waiting for genome…');
  rpc.emit('ready', { igvVersion: igvVersion() } satisfies ReadyEvent);
}
