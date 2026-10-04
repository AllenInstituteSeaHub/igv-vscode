/**
 * Local JSON-RPC 2.0 control endpoint (spec §6.2): newline-delimited JSON
 * over a Unix domain socket (mode 0600) or a Windows named pipe. Never TCP.
 * Every request carries a 32-byte random token, compared in constant time.
 * No `vscode` dependency; the extension wires the method handler.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { RpcError } from '../shared/rpc';
import { JSONRPC, type JsonRpcError, type JsonRpcRequest, type JsonRpcResponse } from './protocol';

export type MethodHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface ControlServerOptions {
  handler: MethodHandler;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Override for tests. */
  endpoint?: string;
  token?: string;
  /** Called after each successful request (used to refresh lastActiveAt). */
  onActivity?: () => void;
}

export function defaultEndpoint(id: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\igv-vscode-${id}`;
  const base = env.XDG_RUNTIME_DIR?.trim() || os.tmpdir();
  return path.join(base, `igv-vscode-${id}.sock`);
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function newInstanceId(): string {
  return randomBytes(6).toString('hex');
}

/** Constant-time token comparison that does not leak length differences. */
export function tokensEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function toJsonRpcError(err: unknown): JsonRpcError {
  const e = RpcError.from(err);
  const data = { ...(typeof e.data === 'object' && e.data !== null ? (e.data as Record<string, unknown>) : {}), code: e.code } as JsonRpcError['data'];
  return { code: e.code === 'UNAUTHORIZED' ? JSONRPC.UNAUTHORIZED : JSONRPC.APP_ERROR, message: e.message, data };
}

export class ControlServer {
  readonly token: string;
  readonly endpoint: string;
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly options: ControlServerOptions, id = newInstanceId()) {
    this.token = options.token ?? newToken();
    this.endpoint = options.endpoint ?? defaultEndpoint(id);
  }

  get listening(): boolean {
    return this.server?.listening === true;
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (process.platform !== 'win32') {
      await fs.rm(this.endpoint, { force: true }).catch(() => undefined);
    }
    const server = net.createServer((socket) => this.onConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.endpoint, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') await fs.chmod(this.endpoint, 0o600).catch(() => undefined);
    server.on('error', (err) => this.options.log('error', `control server error: ${err.message}`));
    this.options.log('info', `agent control channel listening at ${this.endpoint}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await fs.rm(this.endpoint, { force: true }).catch(() => undefined);
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      void this.handleLine(line).then((response) => {
        if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
      });
    });
  }

  /** Exposed for tests: process one NDJSON line and return the response object. */
  async handleLine(line: string): Promise<JsonRpcResponse> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: JSONRPC.PARSE_ERROR, message: 'Parse error' } };
    }
    const id = typeof req?.id === 'number' || typeof req?.id === 'string' ? req.id : null;
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: JSONRPC.INVALID_REQUEST, message: 'Invalid request: expected {jsonrpc:"2.0", id, method, params?, token}' } };
    }
    if (!tokensEqual(req.token, this.token)) {
      this.options.log('warn', `rejected request for ${req.method}: bad or missing token`);
      return { jsonrpc: '2.0', id, error: { code: JSONRPC.UNAUTHORIZED, message: 'Unauthorized: missing or invalid token', data: { code: 'UNAUTHORIZED', hint: 'Use the igv-vscode CLI from a VS Code terminal, or pass the token from ~/.igv-vscode/instances/<id>.json.' } } };
    }
    const params = typeof req.params === 'object' && req.params !== null ? req.params : {};
    try {
      const result = await this.options.handler(req.method, params);
      this.options.onActivity?.();
      return { jsonrpc: '2.0', id, result: result ?? null };
    } catch (err) {
      const e = RpcError.from(err);
      if (e.code === 'INTERNAL' && /^unknown method/.test(e.message)) {
        return { jsonrpc: '2.0', id, error: { code: JSONRPC.METHOD_NOT_FOUND, message: e.message, data: { code: 'INTERNAL' } } };
      }
      this.options.log(e.code === 'INTERNAL' ? 'error' : 'debug', `${req.method} failed: ${e.code}: ${e.message}`);
      return { jsonrpc: '2.0', id, error: toJsonRpcError(e) };
    }
  }
}
