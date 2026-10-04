/**
 * Serves byte ranges of local files to webviews (spec §4.1).
 *
 * - Per-viewer allow-list: a read must name a fileId registered for that viewer.
 * - Reads are clamped to the file size and capped at `maxChunkBytes`; the
 *   webview splits larger requests (FileLike.ts) and reassembles them.
 * - Overlapping in-flight reads for the same file are coalesced: a request
 *   fully contained in one already in flight waits for it and slices.
 * - Open file handles are kept in an LRU and closed on eviction or when no
 *   viewer references the path any more.
 * - Metrics per viewer (requests, bytes, latency percentiles, per-file bytes).
 *
 * No `vscode` dependency so it can be unit tested.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ViewerMetrics } from '../agent/protocol';
import { RpcError } from '../shared/rpc';
import type { RemoteProxy } from './RemoteProxy';

export interface FileHandleInfo {
  fileId: string;
  /** Basename; igv uses it for format inference and labels. */
  name: string;
  size: number;
  displayPath: string;
}

export interface BrokerOptions {
  maxChunkBytes?: number;
  maxOpenHandles?: number;
  /** Enables registerUrl(). */
  proxy?: RemoteProxy;
}

export const DEFAULT_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OPEN_HANDLES = 32;
const LATENCY_SAMPLES = 2000;

interface Registered {
  fileId: string;
  /** Absolute path for local files, or the URL for proxied remote files. */
  absPath: string;
  url?: string;
  name: string;
  size: number;
  displayPath: string;
  bytesRead: number;
  requests: number;
}

interface InFlight {
  start: number;
  end: number;
  promise: Promise<Uint8Array>;
}

interface ViewerMetricsState {
  requests: number;
  bytes: number;
  latencies: number[];
}

export class FileAccessBroker {
  private readonly maxChunkBytes: number;
  private readonly maxOpenHandles: number;
  private readonly viewers = new Map<string, Map<string, Registered>>();
  /** path → open handle, in LRU order (oldest first). */
  private readonly handles = new Map<string, Promise<fs.FileHandle>>();
  private readonly inFlight = new Map<string, InFlight[]>();
  private readonly metrics = new Map<string, ViewerMetricsState>();
  private disposed = false;

  constructor(options: BrokerOptions = {}) {
    this.maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    this.maxOpenHandles = options.maxOpenHandles ?? DEFAULT_MAX_OPEN_HANDLES;
    this.proxy = options.proxy;
  }

  private readonly proxy: RemoteProxy | undefined;

  /**
   * Allow a viewer to read a remote URL through the RemoteProxy (spec §4.3).
   * The size comes from HEAD or Content-Range; an unknown size is an error
   * because igv needs it.
   */
  async registerUrl(viewerId: string, url: string): Promise<FileHandleInfo> {
    this.ensureLive();
    if (!this.proxy) throw new RpcError('INTERNAL', 'remote proxy is not configured');
    let files = this.viewers.get(viewerId);
    if (!files) {
      files = new Map();
      this.viewers.set(viewerId, files);
      this.metrics.set(viewerId, { requests: 0, bytes: 0, latencies: [] });
    }
    for (const r of files.values()) if (r.url === url) return this.info(r);
    const stat = await this.proxy.stat(url);
    if (stat.size === undefined) {
      throw new RpcError('REMOTE_UNREACHABLE', `The server for ${url} does not report the file size (no Content-Length or Content-Range)`, {
        hint: 'igv needs the size to read by byte range. Use a server that reports Content-Length.',
      });
    }
    const reg: Registered = {
      fileId: `f_${randomBytes(8).toString('hex')}`,
      absPath: url,
      url,
      name: urlBaseName(url),
      size: stat.size,
      displayPath: url,
      bytesRead: 0,
      requests: 0,
    };
    files.set(reg.fileId, reg);
    return this.info(reg);
  }

  get chunkLimit(): number {
    return this.maxChunkBytes;
  }

  /** Allow a viewer to read a file. Re-registering the same path returns the same fileId. */
  async register(viewerId: string, absPath: string, displayPath = absPath): Promise<FileHandleInfo> {
    this.ensureLive();
    if (!path.isAbsolute(absPath)) {
      throw new RpcError('INTERNAL', `broker.register needs an absolute path, got ${absPath}`);
    }
    let files = this.viewers.get(viewerId);
    if (!files) {
      files = new Map();
      this.viewers.set(viewerId, files);
      this.metrics.set(viewerId, { requests: 0, bytes: 0, latencies: [] });
    }
    for (const r of files.values()) {
      if (r.absPath === absPath) return this.info(r);
    }
    let size: number;
    try {
      const st = await fs.stat(absPath);
      if (!st.isFile()) throw new Error('not a regular file');
      size = st.size;
    } catch (err) {
      throw new RpcError('FILE_NOT_FOUND', `Cannot read ${absPath}: ${(err as Error).message}`);
    }
    const reg: Registered = {
      fileId: `f_${randomBytes(8).toString('hex')}`,
      absPath,
      name: path.basename(absPath),
      size,
      displayPath,
      bytesRead: 0,
      requests: 0,
    };
    files.set(reg.fileId, reg);
    return this.info(reg);
  }

  /** Forget a single file for a viewer (e.g. the track was removed). */
  async unregister(viewerId: string, fileId: string): Promise<void> {
    const files = this.viewers.get(viewerId);
    const reg = files?.get(fileId);
    if (!files || !reg) return;
    files.delete(fileId);
    await this.closeIfUnreferenced(reg.absPath);
  }

  /** Forget everything a viewer could read and close handles nobody else uses. */
  async releaseViewer(viewerId: string): Promise<void> {
    const files = this.viewers.get(viewerId);
    this.viewers.delete(viewerId);
    this.metrics.delete(viewerId);
    if (!files) return;
    await Promise.all([...files.values()].map((r) => this.closeIfUnreferenced(r.absPath)));
  }

  /** Paths a viewer may currently read (for session saving and tests). */
  listFiles(viewerId: string): FileHandleInfo[] {
    return [...(this.viewers.get(viewerId)?.values() ?? [])].map((r) => this.info(r));
  }

  pathFor(viewerId: string, fileId: string): string | undefined {
    return this.viewers.get(viewerId)?.get(fileId)?.absPath;
  }

  /**
   * Read [start, end) of a registered file. `end` is exclusive, clamped to the
   * file size. Requests larger than `maxChunkBytes` are rejected: the webview
   * is responsible for chunking.
   */
  async read(viewerId: string, fileId: string, start: number, end: number): Promise<Uint8Array> {
    this.ensureLive();
    const reg = this.viewers.get(viewerId)?.get(fileId);
    if (!reg) {
      throw new RpcError('FILE_NOT_FOUND', `Viewer ${viewerId} is not allowed to read file ${fileId}`, {
        hint: 'Only files added to this viewer can be read.',
      });
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0) {
      throw new RpcError('INTERNAL', `Invalid byte range ${start}-${end}`);
    }
    const s = Math.min(start, reg.size);
    const e = Math.min(Math.max(end, s), reg.size);
    if (e - s > this.maxChunkBytes) {
      throw new RpcError('INTERNAL', `Range ${s}-${e} exceeds the chunk limit of ${this.maxChunkBytes} bytes`, {
        hint: 'Split the request into chunks of at most igv.transport.maxChunkBytes.',
      });
    }
    const t0 = performance.now();
    const m = this.metrics.get(viewerId);
    if (m) m.requests++;
    reg.requests++;
    const bytes = await this.readCoalesced(reg, s, e);
    const dt = performance.now() - t0;
    if (m) {
      m.bytes += bytes.byteLength;
      if (m.latencies.length >= LATENCY_SAMPLES) m.latencies.shift();
      m.latencies.push(dt);
    }
    reg.bytesRead += bytes.byteLength;
    return bytes;
  }

  getMetrics(viewerId: string): ViewerMetrics {
    const m = this.metrics.get(viewerId) ?? { requests: 0, bytes: 0, latencies: [] };
    const sorted = [...m.latencies].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0);
    return {
      requests: m.requests,
      bytes: m.bytes,
      p50LatencyMs: round(pct(50)),
      p95LatencyMs: round(pct(95)),
      files: [...(this.viewers.get(viewerId)?.values() ?? [])].map((r) => ({
        fileId: r.fileId,
        displayPath: r.displayPath,
        size: r.size,
        bytesRead: r.bytesRead,
        requests: r.requests,
      })),
    };
  }

  get openHandleCount(): number {
    return this.handles.size;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const all = [...this.handles.values()];
    this.handles.clear();
    this.viewers.clear();
    this.metrics.clear();
    await Promise.all(all.map((p) => p.then((h) => h.close()).catch(() => undefined)));
  }

  private info(r: Registered): FileHandleInfo {
    return { fileId: r.fileId, name: r.name, size: r.size, displayPath: r.displayPath };
  }

  private ensureLive(): void {
    if (this.disposed) throw new RpcError('INTERNAL', 'file broker has been disposed');
  }

  private async readCoalesced(reg: Registered, start: number, end: number): Promise<Uint8Array> {
    const key = reg.absPath;
    const list = this.inFlight.get(key) ?? [];
    const container = list.find((f) => f.start <= start && f.end >= end);
    if (container) {
      const whole = await container.promise;
      return whole.subarray(start - container.start, end - container.start);
    }
    const entry: InFlight = { start, end, promise: this.readRaw(reg, start, end) };
    list.push(entry);
    this.inFlight.set(key, list);
    try {
      return await entry.promise;
    } finally {
      const cur = this.inFlight.get(key);
      if (cur) {
        const i = cur.indexOf(entry);
        if (i >= 0) cur.splice(i, 1);
        if (cur.length === 0) this.inFlight.delete(key);
      }
    }
  }

  private async readRaw(reg: Registered, start: number, end: number): Promise<Uint8Array> {
    const length = end - start;
    if (length === 0) return new Uint8Array(0);
    if (reg.url) {
      if (!this.proxy) throw new RpcError('INTERNAL', 'remote proxy is not configured');
      return this.proxy.read(reg.url, start, end);
    }
    const handle = await this.handleFor(reg.absPath);
    const buf = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buf, offset, length - offset, start + offset);
      if (bytesRead === 0) break; // file shrank underneath us
      offset += bytesRead;
    }
    return offset === length ? new Uint8Array(buf.buffer, buf.byteOffset, length) : new Uint8Array(buf.buffer, buf.byteOffset, offset);
  }

  private handleFor(absPath: string): Promise<fs.FileHandle> {
    const existing = this.handles.get(absPath);
    if (existing) {
      // Refresh LRU position.
      this.handles.delete(absPath);
      this.handles.set(absPath, existing);
      return existing;
    }
    const opened = fs.open(absPath, 'r').catch((err) => {
      this.handles.delete(absPath);
      throw new RpcError('FILE_NOT_FOUND', `Cannot open ${absPath}: ${(err as Error).message}`);
    });
    this.handles.set(absPath, opened);
    while (this.handles.size > this.maxOpenHandles) {
      const oldest = this.handles.keys().next().value as string;
      const h = this.handles.get(oldest)!;
      this.handles.delete(oldest);
      void h.then((fh) => fh.close()).catch(() => undefined);
    }
    return opened;
  }

  private async closeIfUnreferenced(absPath: string): Promise<void> {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(absPath)) return; // URLs have no handle
    for (const files of this.viewers.values()) {
      for (const r of files.values()) if (r.absPath === absPath) return;
    }
    const h = this.handles.get(absPath);
    if (!h) return;
    this.handles.delete(absPath);
    await h.then((fh) => fh.close()).catch(() => undefined);
  }
}

function urlBaseName(url: string): string {
  const noQuery = url.split(/[?#]/)[0] ?? url;
  const seg = noQuery.split('/').filter(Boolean).pop() ?? url;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
