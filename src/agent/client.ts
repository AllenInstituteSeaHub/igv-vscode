/**
 * Control-channel client used by the CLI and the MCP server (spec §6.2
 * discovery, §6.4 exit codes). No `vscode` dependency.
 */
import * as net from 'node:net';
import * as readline from 'node:readline';
import type { InstanceRecord, JsonRpcErrorData, JsonRpcResponse } from './protocol';
import { chooseInstance, listInstances } from './registry';

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_OPERATION = 2;
export const EXIT_NO_INSTANCE = 3;
export const EXIT_TIMEOUT = 4;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly data?: JsonRpcErrorData & { rpcCode?: number },
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface EndpointInfo {
  endpoint: string;
  token: string;
  id?: string;
  source: 'env' | 'registry';
}

export interface DiscoverOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  instance?: string;
  /** Verify the endpoint answers `ping` before returning it (default true). */
  verify?: boolean;
  timeoutMs?: number;
}

/** Find a running extension: environment variables first, then the instance registry. */
export async function discover(options: DiscoverOptions): Promise<EndpointInfo> {
  const env = options.env ?? process.env;
  const candidates: EndpointInfo[] = [];
  if (!options.instance && env.IGV_VSCODE_ENDPOINT && env.IGV_VSCODE_TOKEN) {
    candidates.push({ endpoint: env.IGV_VSCODE_ENDPOINT, token: env.IGV_VSCODE_TOKEN, source: 'env' });
  }
  const instances = await listInstances(env);
  const ordered: InstanceRecord[] = [];
  const chosen = chooseInstance(instances, options.cwd, options.instance);
  if (chosen) ordered.push(chosen);
  for (const i of instances) if (i !== chosen) ordered.push(i);
  for (const i of ordered) candidates.push({ endpoint: i.endpoint, token: i.token, id: i.id, source: 'registry' });

  if (options.instance && !chosen) {
    throw new CliError(`No IGV instance with id "${options.instance}". Known: ${instances.map((i) => i.id).join(', ') || 'none'}`, EXIT_NO_INSTANCE);
  }
  if (candidates.length === 0) {
    throw new CliError(
      'No running VS Code with the IGV extension was found. Open VS Code with the extension installed (and the agent API enabled: igv.agent.enabled, not in Restricted Mode), or run this from a VS Code terminal.',
      EXIT_NO_INSTANCE,
    );
  }
  if (options.verify === false) return candidates[0]!;
  const failures: string[] = [];
  for (const c of candidates) {
    try {
      const client = new ControlClient(c, { timeoutMs: options.timeoutMs ?? 5000 });
      try {
        await client.request('ping', {});
        return c;
      } finally {
        client.close();
      }
    } catch (err) {
      failures.push(`${c.id ?? c.source}: ${(err as Error).message}`);
    }
  }
  throw new CliError(`Found ${candidates.length} IGV instance(s) but none answered: ${failures.join('; ')}`, EXIT_NO_INSTANCE);
}

export interface ControlClientOptions {
  timeoutMs?: number;
}

/** One connection; requests are matched to responses by id. */
export class ControlClient {
  private socket: net.Socket | undefined;
  private connecting: Promise<net.Socket> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly endpoint: EndpointInfo,
    private readonly options: ControlClientOptions = {},
  ) {}

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint.endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new CliError(`Timed out connecting to ${this.endpoint.endpoint}`, EXIT_NO_INSTANCE));
      }, this.options.timeoutMs ?? 5000);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
        rl.on('line', (line) => this.onLine(line));
        socket.on('close', () => this.failAll(new CliError('Connection to VS Code closed', EXIT_NO_INSTANCE)));
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new CliError(`Cannot connect to ${this.endpoint.endpoint}: ${err.message}`, EXIT_NO_INSTANCE));
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const socket = await this.connect();
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params, token: this.endpoint.token }) + '\n';
    const timeout = timeoutMs ?? this.options.timeoutMs ?? 120_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError(`${method} timed out after ${timeout} ms`, EXIT_TIMEOUT, { code: 'TIMEOUT' }));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.write(line);
    });
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = undefined;
  }

  private onLine(line: string): void {
    let res: JsonRpcResponse;
    try {
      res = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof res.id !== 'number') return;
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    if (res.error) {
      const code = res.error.data?.code;
      const exit = code === 'TIMEOUT' ? EXIT_TIMEOUT : code === 'AGENT_DISABLED' || code === 'UNAUTHORIZED' ? EXIT_NO_INSTANCE : EXIT_OPERATION;
      p.reject(new CliError(res.error.message, exit, { ...(res.error.data ?? { code: 'INTERNAL' }), rpcCode: res.error.code }));
    } else {
      p.resolve(res.result);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
