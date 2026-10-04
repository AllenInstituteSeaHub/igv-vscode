/**
 * Fetches HTTP(S) byte ranges from the extension host (spec §4.3 "proxy"
 * mode), for URLs the browser cannot reach because of CORS or network
 * restrictions. Uses Node `fetch` with an AbortController timeout.
 */
import { RpcError } from '../shared/rpc';

export interface RemoteStat {
  size: number | undefined;
  acceptsRanges: boolean;
  status: number;
  contentType?: string;
}

export interface RemoteProxyOptions {
  timeoutMs?: number;
  /** Servers that ignore Range and return the whole body: abort above this size. */
  maxFullBodyBytes?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

export class RemoteProxy {
  private readonly timeoutMs: number;
  private readonly maxFullBodyBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly statCache = new Map<string, RemoteStat>();

  constructor(options: RemoteProxyOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxFullBodyBytes = options.maxFullBodyBytes ?? 64 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal, headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) } });
    } catch (err) {
      const aborted = controller.signal.aborted;
      throw new RpcError('REMOTE_UNREACHABLE', `${aborted ? 'Timed out' : 'Failed'} fetching ${url}: ${(err as Error).message}`, {
        hint: 'Check the URL, network access from the machine running VS Code, and that the server allows Range requests.',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Size and Range support, via HEAD, falling back to a 1-byte ranged GET. */
  async stat(url: string): Promise<RemoteStat> {
    const cached = this.statCache.get(url);
    if (cached) return cached;
    let stat: RemoteStat | undefined;
    try {
      const head = await this.request(url, { method: 'HEAD' });
      if (head.ok) {
        const len = head.headers.get('content-length');
        stat = {
          size: len !== null && len !== '' ? Number(len) : undefined,
          acceptsRanges: (head.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes'),
          status: head.status,
          contentType: head.headers.get('content-type') ?? undefined,
        };
      }
    } catch {
      // fall through to ranged GET
    }
    if (!stat || stat.size === undefined || !stat.acceptsRanges) {
      const r = await this.request(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
      if (r.status === 206) {
        const cr = r.headers.get('content-range') ?? '';
        const m = /\/(\d+)\s*$/.exec(cr);
        stat = { size: m ? Number(m[1]) : stat?.size, acceptsRanges: true, status: 206, contentType: r.headers.get('content-type') ?? stat?.contentType };
      } else if (r.ok) {
        const len = r.headers.get('content-length');
        stat = { size: len ? Number(len) : stat?.size, acceptsRanges: false, status: r.status, contentType: r.headers.get('content-type') ?? stat?.contentType };
      } else {
        throw new RpcError('REMOTE_UNREACHABLE', `HTTP ${r.status} for ${url}`, {
          hint: r.status === 403 || r.status === 401 ? 'The server refused the request. Use a presigned URL or check credentials.' : 'Check that the URL is correct and reachable from the VS Code host.',
          status: r.status,
        });
      }
      try {
        await r.body?.cancel();
      } catch {
        // ignore
      }
    }
    this.statCache.set(url, stat);
    return stat;
  }

  /** True when a ranged 1-byte GET (or HEAD) succeeds: used for index discovery (spec §4.4). */
  async exists(url: string): Promise<boolean> {
    try {
      const s = await this.stat(url);
      return s.status >= 200 && s.status < 300 || s.status === 206;
    } catch {
      return false;
    }
  }

  /** Read [start, end) with a Range GET. Detects servers that ignore Range. */
  async read(url: string, start: number, end: number): Promise<Uint8Array> {
    if (end <= start) return new Uint8Array(0);
    const r = await this.request(url, { method: 'GET', headers: { Range: `bytes=${start}-${end - 1}` } });
    if (r.status === 206) {
      const buf = new Uint8Array(await r.arrayBuffer());
      return buf.length > end - start ? buf.subarray(0, end - start) : buf;
    }
    if (r.status === 200) {
      const len = Number(r.headers.get('content-length') ?? NaN);
      if (Number.isFinite(len) && len > this.maxFullBodyBytes) {
        await r.body?.cancel().catch(() => undefined);
        throw new RpcError('REMOTE_UNREACHABLE', `The server for ${url} ignores Range requests and the file is ${(len / 1048576).toFixed(0)} MiB`, {
          hint: 'Serve the file from a server that supports HTTP Range requests (e.g. S3 presigned URLs, nginx, Apache), or download it locally.',
        });
      }
      const whole = new Uint8Array(await r.arrayBuffer());
      if (whole.length > this.maxFullBodyBytes) {
        throw new RpcError('REMOTE_UNREACHABLE', `The server for ${url} ignores Range requests and returned ${whole.length} bytes`, {
          hint: 'Serve the file from a server that supports HTTP Range requests, or download it locally.',
        });
      }
      return whole.subarray(Math.min(start, whole.length), Math.min(end, whole.length));
    }
    if (r.status === 416) return new Uint8Array(0);
    throw new RpcError('REMOTE_UNREACHABLE', `HTTP ${r.status} reading ${url}`, { status: r.status });
  }
}

/** Heuristic: does a track load error look like a browser-side CORS/network failure? (spec §4.3 "auto") */
export function looksLikeNetworkError(message: string): boolean {
  return /cors|failed to fetch|networkerror|network error|load failed|access-control|typeerror: failed|net::err|ERR_FAILED|status:?\s*(0|403)\b|unable to load|error accessing resource|error loading/i.test(message);
}
