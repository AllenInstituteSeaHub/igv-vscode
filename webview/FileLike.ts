/**
 * File-like objects that igv.js reads through `slice(start, end).arrayBuffer()`
 * (spec §4.1). igv 3.8.9 treats any object with an own `name` property and
 * `slice`/`arrayBuffer` functions as a local file.
 *
 * - Reads go to the host as `read` requests carrying an opaque fileId.
 * - Requests above `maxChunkBytes` are split into sequential chunks and
 *   reassembled here.
 * - Ranges up to `cacheMaxEntryBytes` are cached in an LRU keyed by
 *   (fileId, start, end); this removes repeated header and index reads.
 * - Payloads are Uint8Array by default. If the startup probe showed binary
 *   does not round-trip, `encoding: 'base64'` decodes strings instead.
 *
 * No DOM dependencies, so it is unit-tested under Node.
 */

export interface FileHandleInfo {
  fileId: string;
  name: string;
  size: number;
  displayPath: string;
}

export interface ReadParams {
  fileId: string;
  start: number;
  end: number;
}

export interface ReadTransport {
  read(params: ReadParams): Promise<Uint8Array | string>;
}

export type PayloadEncoding = 'binary' | 'base64';

export interface FileLikeOptions {
  maxChunkBytes: number;
  encoding: PayloadEncoding;
  cache?: RangeCache;
}

export interface FileLike {
  name: string;
  size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export const DEFAULT_CACHE_MAX_ENTRY_BYTES = 1024 * 1024;
export const DEFAULT_CACHE_TOTAL_BYTES = 64 * 1024 * 1024;

/** LRU cache of byte ranges. */
export class RangeCache {
  private readonly map = new Map<string, Uint8Array>();
  private total = 0;
  hits = 0;
  misses = 0;

  constructor(
    readonly maxEntryBytes = DEFAULT_CACHE_MAX_ENTRY_BYTES,
    readonly maxTotalBytes = DEFAULT_CACHE_TOTAL_BYTES,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }

  get(fileId: string, start: number, end: number): Uint8Array | undefined {
    const key = `${fileId}:${start}:${end}`;
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
      this.hits++;
    } else {
      this.misses++;
    }
    return v;
  }

  put(fileId: string, start: number, end: number, data: Uint8Array): void {
    if (data.byteLength > this.maxEntryBytes) return;
    const key = `${fileId}:${start}:${end}`;
    const old = this.map.get(key);
    if (old) {
      this.total -= old.byteLength;
      this.map.delete(key);
    }
    this.map.set(key, data);
    this.total += data.byteLength;
    while (this.total > this.maxTotalBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value as string;
      const oldest = this.map.get(oldestKey)!;
      this.map.delete(oldestKey);
      this.total -= oldest.byteLength;
    }
  }

  /** Drop every entry belonging to a file. */
  evictFile(fileId: string): void {
    const prefix = `${fileId}:`;
    for (const [k, v] of [...this.map]) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        this.total -= v.byteLength;
      }
    }
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

export function decodePayload(payload: Uint8Array | string, encoding: PayloadEncoding): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === 'string') {
    if (encoding !== 'base64') {
      throw new Error('received a string payload while in binary mode');
    }
    return base64ToBytes(payload);
  }
  // Some hosts deliver ArrayBuffer or a {type:'Buffer',data:[]} JSON shape.
  const p = payload as unknown;
  if (p instanceof ArrayBuffer) return new Uint8Array(p);
  if (p && typeof p === 'object' && Array.isArray((p as { data?: unknown }).data)) {
    return Uint8Array.from((p as { data: number[] }).data);
  }
  throw new Error(`unexpected read payload of type ${typeof payload}`);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback (unit tests run without atob in some runtimes).
  const nodeBuffer = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (!nodeBuffer) throw new Error('no base64 decoder available');
  return new Uint8Array(nodeBuffer.from(b64, 'base64'));
}

export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** Read [start, end) with chunking and caching. Exported for tests. */
export async function readRange(
  transport: ReadTransport,
  handle: FileHandleInfo,
  start: number,
  end: number,
  options: FileLikeOptions,
): Promise<Uint8Array> {
  const s = Math.max(0, Math.min(Math.floor(start), handle.size));
  const e = Math.max(s, Math.min(Math.floor(end), handle.size));
  if (e === s) return new Uint8Array(0);

  const cache = options.cache;
  const cached = cache?.get(handle.fileId, s, e);
  if (cached) return cached;

  const chunk = Math.max(1, options.maxChunkBytes);
  let result: Uint8Array;
  if (e - s <= chunk) {
    result = decodePayload(await transport.read({ fileId: handle.fileId, start: s, end: e }), options.encoding);
  } else {
    result = new Uint8Array(e - s);
    let offset = s;
    while (offset < e) {
      const next = Math.min(offset + chunk, e);
      const part = decodePayload(await transport.read({ fileId: handle.fileId, start: offset, end: next }), options.encoding);
      result.set(part.subarray(0, next - offset), offset - s);
      offset = next;
    }
  }
  cache?.put(handle.fileId, s, e, result);
  return result;
}

export function fileLike(handle: FileHandleInfo, transport: ReadTransport, options: FileLikeOptions): FileLike {
  const read = (start: number, end: number) => readRange(transport, handle, start, end, options).then(toArrayBuffer);
  const obj: FileLike = {
    name: handle.name,
    size: handle.size,
    slice: (start?: number, end?: number) => {
      const s = typeof start === 'number' && Number.isFinite(start) ? start : 0;
      const e = typeof end === 'number' && Number.isFinite(end) ? Math.min(end, handle.size) : handle.size;
      return { arrayBuffer: () => read(s, e) };
    },
    arrayBuffer: () => read(0, handle.size),
  };
  return obj;
}

/** Marker shape the host embeds in igv configs where a File-like belongs. */
export interface FileRefMarker {
  __igvVscodeFile: FileHandleInfo;
}

export function isFileRefMarker(v: unknown): v is FileRefMarker {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as FileRefMarker).__igvVscodeFile === 'object' &&
    typeof (v as FileRefMarker).__igvVscodeFile?.fileId === 'string'
  );
}

/**
 * Deep-copies `value`, replacing every `{__igvVscodeFile}` marker with a
 * File-like. Returns the hydrated value and the handles found.
 */
export function hydrateFileRefs<T>(
  value: T,
  transport: ReadTransport,
  options: FileLikeOptions,
  found: FileHandleInfo[] = [],
): T {
  if (isFileRefMarker(value)) {
    found.push(value.__igvVscodeFile);
    return fileLike(value.__igvVscodeFile, transport, options) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => hydrateFileRefs(v, transport, options, found)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = hydrateFileRefs(v, transport, options, found);
    }
    return out as T;
  }
  return value;
}
