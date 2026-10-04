import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteProxy, looksLikeNetworkError } from '../../src/data/RemoteProxy';
import { FileAccessBroker } from '../../src/data/FileAccessBroker';
import type { RpcError } from '../../src/shared/rpc';

const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
let server: http.Server;
let base: string;
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers.range ?? ''}`.trim());
    const url = req.url ?? '/';
    if (url.startsWith('/missing')) {
      res.writeHead(404).end();
      return;
    }
    if (url.startsWith('/forbidden')) {
      res.writeHead(403).end();
      return;
    }
    if (url.startsWith('/norange')) {
      // Ignores Range entirely.
      res.writeHead(200, { 'content-length': String(data.length) });
      res.end(req.method === 'HEAD' ? undefined : data);
      return;
    }
    if (url.startsWith('/nohead')) {
      if (req.method === 'HEAD') {
        res.writeHead(405).end();
        return;
      }
    }
    const range = req.headers.range;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(data.length), 'accept-ranges': 'bytes' }).end();
      return;
    }
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range)!;
      const s = Number(m[1]);
      const e = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
      if (s >= data.length) {
        res.writeHead(416, { 'content-range': `bytes */${data.length}` }).end();
        return;
      }
      res.writeHead(206, { 'content-range': `bytes ${s}-${e}/${data.length}`, 'content-length': String(e - s + 1), 'accept-ranges': 'bytes' });
      res.end(data.subarray(s, e + 1));
      return;
    }
    res.writeHead(200, { 'content-length': String(data.length) }).end(data);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    return e as RpcError;
  }
  throw new Error('expected rejection');
}

describe('RemoteProxy', () => {
  it('stats via HEAD and reads exact ranges with 206', async () => {
    const p = new RemoteProxy();
    const s = await p.stat(`${base}/data.bam`);
    expect(s).toMatchObject({ size: 5000, acceptsRanges: true });
    const bytes = await p.read(`${base}/data.bam`, 100, 110);
    expect([...bytes]).toEqual([...data.subarray(100, 110)]);
    expect((await p.read(`${base}/data.bam`, 4990, 6000)).length).toBe(10);
    expect((await p.read(`${base}/data.bam`, 6000, 7000)).length).toBe(0);
    expect((await p.read(`${base}/data.bam`, 10, 10)).length).toBe(0);
  });

  it('falls back to a ranged GET when HEAD is not allowed', async () => {
    const p = new RemoteProxy();
    const s = await p.stat(`${base}/nohead/x.bam`);
    expect(s).toMatchObject({ size: 5000, acceptsRanges: true, status: 206 });
  });

  it('detects servers that ignore Range and slices small bodies, refusing large ones', async () => {
    const p = new RemoteProxy({ maxFullBodyBytes: 10_000 });
    expect([...(await p.read(`${base}/norange/x.bed`, 5, 8))]).toEqual([5, 6, 7]);
    const strict = new RemoteProxy({ maxFullBodyBytes: 1000 });
    const err = await rejection(strict.read(`${base}/norange/x.bed`, 0, 10));
    expect(err.code).toBe('REMOTE_UNREACHABLE');
    expect(err.message).toMatch(/ignores Range/);
  });

  it('reports 404/403 clearly and exists() answers for index discovery', async () => {
    const p = new RemoteProxy();
    expect((await rejection(p.stat(`${base}/missing.bai`))).code).toBe('REMOTE_UNREACHABLE');
    expect((await rejection(p.stat(`${base}/forbidden.bam`))).message).toMatch(/HTTP 403/);
    expect(await p.exists(`${base}/data.bam.bai`)).toBe(true);
    expect(await p.exists(`${base}/missing.bai`)).toBe(false);
  });

  it('times out unreachable hosts', async () => {
    const p = new RemoteProxy({ timeoutMs: 300 });
    const err = await rejection(p.stat('http://10.255.255.1:9/x.bam'));
    expect(err.code).toBe('REMOTE_UNREACHABLE');
  }, 10_000);

  it('looksLikeNetworkError recognises browser CORS/network failures', () => {
    expect(looksLikeNetworkError('TypeError: Failed to fetch')).toBe(true);
    expect(looksLikeNetworkError('Access to fetch has been blocked by CORS policy')).toBe(true);
    expect(looksLikeNetworkError('Error accessing resource: http://127.0.0.1:5/x.bw status: 0')).toBe(true);
    expect(looksLikeNetworkError('Unknown file format')).toBe(false);
  });
});

describe('FileAccessBroker with remote URLs', () => {
  it('registers a URL handle, reads through the proxy, tracks metrics', async () => {
    const b = new FileAccessBroker({ proxy: new RemoteProxy(), maxChunkBytes: 1000 });
    const h = await b.registerUrl('v1', `${base}/dir/sample.bam?token=abc`);
    expect(h).toMatchObject({ name: 'sample.bam', size: 5000, displayPath: `${base}/dir/sample.bam?token=abc` });
    const bytes = await b.read('v1', h.fileId, 10, 20);
    expect([...bytes]).toEqual([...data.subarray(10, 20)]);
    expect((await b.registerUrl('v1', `${base}/dir/sample.bam?token=abc`)).fileId).toBe(h.fileId);
    expect(b.getMetrics('v1').files[0]).toMatchObject({ bytesRead: 10, requests: 1 });
    expect((await rejection(b.read('v1', h.fileId, 0, 2000))).message).toMatch(/chunk limit/);
    await b.releaseViewer('v1');
    expect((await rejection(b.read('v1', h.fileId, 0, 10))).code).toBe('FILE_NOT_FOUND');
    await b.dispose();
  });
  it('refuses URLs without a size and brokers without a proxy', async () => {
    const noProxy = new FileAccessBroker();
    expect((await rejection(noProxy.registerUrl('v1', `${base}/x.bam`))).message).toMatch(/proxy is not configured/);
    await noProxy.dispose();
  });
});
