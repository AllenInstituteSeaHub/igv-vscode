/**
 * Minimal bidirectional JSON-RPC-style messaging used between the extension
 * host and the webview (spec §3.2 `rpc.ts`). Transport-agnostic: the caller
 * supplies `post` and feeds incoming messages to `dispatch`.
 *
 * The same class is used on both ends so framing, timeouts and error
 * propagation are tested once.
 */

export interface RpcErrorShape {
  message: string;
  code: string;
  data?: unknown;
}

export interface RpcRequestMessage {
  kind: 'req';
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponseMessage {
  kind: 'res';
  id: number;
  result?: unknown;
  error?: RpcErrorShape;
}

export interface RpcEventMessage {
  kind: 'evt';
  event: string;
  payload?: unknown;
}

export type RpcMessage = RpcRequestMessage | RpcResponseMessage | RpcEventMessage;

export class RpcError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
  toShape(): RpcErrorShape {
    return { code: this.code, message: this.message, data: this.data };
  }
  static from(err: unknown, fallbackCode = 'INTERNAL'): RpcError {
    if (err instanceof RpcError) return err;
    if (err instanceof Error) return new RpcError(fallbackCode, err.message, { stack: err.stack });
    return new RpcError(fallbackCode, String(err));
  }
}

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;
export type RpcEventListener = (payload: unknown) => void;

export interface RpcDisposable {
  dispose(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: RpcError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  method: string;
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'req' || kind === 'res' || kind === 'evt';
}

export class Rpc {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly listeners = new Map<string, Set<RpcEventListener>>();
  private disposed = false;

  constructor(
    private readonly post: (message: RpcMessage) => void,
    private readonly options: { defaultTimeoutMs?: number; onError?: (err: unknown) => void } = {},
  ) {}

  /** Register a handler for incoming requests. Replaces any existing handler. */
  handle(method: string, handler: RpcHandler): RpcDisposable {
    this.handlers.set(method, handler);
    return { dispose: () => { if (this.handlers.get(method) === handler) this.handlers.delete(method); } };
  }

  /** Listen for incoming events (fire-and-forget notifications). */
  on(event: string, listener: RpcEventListener): RpcDisposable {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return { dispose: () => { set?.delete(listener); } };
  }

  /** Send an event to the other side. */
  emit(event: string, payload?: unknown): void {
    if (this.disposed) return;
    this.post({ kind: 'evt', event, payload });
  }

  /** Send a request and wait for its response. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new RpcError('INTERNAL', `rpc disposed; cannot call ${method}`));
    }
    const id = this.nextId++;
    const timeout = timeoutMs ?? this.options.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeout !== undefined && timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new RpcError('TIMEOUT', `${method} timed out after ${timeout} ms`));
            }, timeout)
          : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.post({ kind: 'req', id, method, params });
    });
  }

  /** Feed an incoming message. Unknown shapes are ignored. */
  async dispatch(message: unknown): Promise<void> {
    if (!isRpcMessage(message)) return;
    switch (message.kind) {
      case 'req':
        await this.handleRequest(message);
        return;
      case 'res':
        this.handleResponse(message);
        return;
      case 'evt': {
        const set = this.listeners.get(message.event);
        if (!set) return;
        for (const listener of [...set]) {
          try {
            listener(message.payload);
          } catch (err) {
            this.options.onError?.(err);
          }
        }
        return;
      }
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Reject every pending request and stop sending. */
  dispose(reason = 'rpc disposed'): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError('INTERNAL', `${p.method}: ${reason}`));
      this.pending.delete(id);
    }
    this.handlers.clear();
    this.listeners.clear();
  }

  private async handleRequest(message: RpcRequestMessage): Promise<void> {
    const handler = this.handlers.get(message.method);
    if (!handler) {
      this.post({
        kind: 'res',
        id: message.id,
        error: { code: 'METHOD_NOT_FOUND', message: `unknown method: ${message.method}` },
      });
      return;
    }
    try {
      const result = await handler(message.params);
      if (!this.disposed) this.post({ kind: 'res', id: message.id, result });
    } catch (err) {
      this.options.onError?.(err);
      if (!this.disposed) this.post({ kind: 'res', id: message.id, error: RpcError.from(err).toShape() });
    }
  }

  private handleResponse(message: RpcResponseMessage): void {
    const p = this.pending.get(message.id);
    if (!p) return;
    this.pending.delete(message.id);
    if (p.timer) clearTimeout(p.timer);
    if (message.error) {
      p.reject(new RpcError(message.error.code, message.error.message, message.error.data));
    } else {
      p.resolve(message.result);
    }
  }
}
