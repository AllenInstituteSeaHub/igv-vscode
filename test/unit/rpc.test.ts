import { describe, expect, it, vi } from 'vitest';
import { Rpc, RpcError, isRpcMessage, type RpcMessage } from '../../src/shared/rpc';

/** Resolves with the rejection reason of `p`, or fails if `p` resolves. */
async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    return e as RpcError;
  }
  throw new Error('expected promise to reject');
}

/** Two Rpc endpoints wired to each other through an async channel. */
function pair(options?: { defaultTimeoutMs?: number }) {
  const sent: RpcMessage[] = [];
  // eslint-disable-next-line prefer-const
  let b: Rpc;
  const a = new Rpc((m) => { sent.push(m); queueMicrotask(() => void b.dispatch(m)); }, options);
  b = new Rpc((m) => { sent.push(m); queueMicrotask(() => void a.dispatch(m)); }, options);
  return { a, b, sent };
}

describe('Rpc', () => {
  it('round-trips a request and response', async () => {
    const { a, b } = pair();
    b.handle('add', (p) => {
      const { x, y } = p as { x: number; y: number };
      return x + y;
    });
    await expect(a.request<number>('add', { x: 2, y: 3 })).resolves.toBe(5);
    expect(a.pendingCount).toBe(0);
  });

  it('propagates handler errors with code and data', async () => {
    const { a, b } = pair();
    b.handle('fail', () => {
      throw new RpcError('FILE_NOT_FOUND', 'nope', { hint: 'create it' });
    });
    const err = await rejection(a.request('fail'));
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe('FILE_NOT_FOUND');
    expect(err.message).toBe('nope');
    expect(err.data).toEqual({ hint: 'create it' });
  });

  it('wraps plain errors as INTERNAL', async () => {
    const { a, b } = pair();
    b.handle('boom', () => Promise.reject(new Error('kaboom')));
    const err = await rejection(a.request('boom'));
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toBe('kaboom');
  });

  it('rejects unknown methods with METHOD_NOT_FOUND', async () => {
    const { a } = pair();
    const err = await rejection(a.request('missing'));
    expect(err.code).toBe('METHOD_NOT_FOUND');
  });

  it('times out when no response arrives', async () => {
    vi.useFakeTimers();
    try {
      const a = new Rpc(() => undefined, { defaultTimeoutMs: 100 });
      const p = a.request('slow');
      const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(101);
      await assertion;
      expect(a.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers events to listeners and supports unsubscribe', async () => {
    const { a, b } = pair();
    const seen: unknown[] = [];
    const sub = b.on('tick', (p) => seen.push(p));
    a.emit('tick', 1);
    await new Promise((r) => setTimeout(r, 0));
    sub.dispose();
    a.emit('tick', 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([1]);
  });

  it('rejects all pending requests on dispose', async () => {
    const a = new Rpc(() => undefined);
    const p1 = a.request('x');
    const p2 = a.request('y');
    a.dispose('gone');
    await expect(p1).rejects.toMatchObject({ code: 'INTERNAL', message: 'x: gone' });
    await expect(p2).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(a.request('z')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('ignores malformed messages', async () => {
    const { a } = pair();
    await a.dispatch(null);
    await a.dispatch({ kind: 'nope' });
    await a.dispatch('string');
    expect(isRpcMessage({ kind: 'evt', event: 'e' })).toBe(true);
    expect(isRpcMessage({ type: 'req' })).toBe(false);
  });

  it('matches responses to requests by id even when out of order', async () => {
    const posts: RpcMessage[] = [];
    const a = new Rpc((m) => posts.push(m));
    const p1 = a.request<string>('first');
    const p2 = a.request<string>('second');
    const [r1, r2] = posts as unknown as [{ id: number }, { id: number }];
    await a.dispatch({ kind: 'res', id: r2.id, result: 'two' });
    await a.dispatch({ kind: 'res', id: r1.id, result: 'one' });
    await expect(p1).resolves.toBe('one');
    await expect(p2).resolves.toBe('two');
  });
});
