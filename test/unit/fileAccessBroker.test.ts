import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileAccessBroker } from '../../src/data/FileAccessBroker';
import type { RpcError } from '../../src/shared/rpc';

let dir: string;
let fileA: string;
let fileB: string;
const dataA = new Uint8Array(10_000).map((_, i) => i % 251);
const dataB = new Uint8Array(500).map((_, i) => 255 - (i % 256));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'igv-broker-'));
  fileA = join(dir, 'a.bam');
  fileB = join(dir, 'b.bai');
  writeFileSync(fileA, dataA);
  writeFileSync(fileB, dataB);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    return e as RpcError;
  }
  throw new Error('expected rejection');
}

describe('FileAccessBroker', () => {
  it('registers files per viewer and serves exact ranges', async () => {
    const b = new FileAccessBroker();
    const h = await b.register('v1', fileA, 'a.bam');
    expect(h).toMatchObject({ name: 'a.bam', size: 10_000, displayPath: 'a.bam' });
    expect(h.fileId).toMatch(/^f_[0-9a-f]{16}$/);
    const bytes = await b.read('v1', h.fileId, 100, 110);
    expect([...bytes]).toEqual([...dataA.slice(100, 110)]);
    // Same path again → same id.
    expect((await b.register('v1', fileA)).fileId).toBe(h.fileId);
    await b.dispose();
  });

  it('enforces the per-viewer allow-list', async () => {
    const b = new FileAccessBroker();
    const h = await b.register('v1', fileA);
    expect((await rejection(b.read('v2', h.fileId, 0, 10))).code).toBe('FILE_NOT_FOUND');
    expect((await rejection(b.read('v1', 'f_bogus', 0, 10))).code).toBe('FILE_NOT_FOUND');
    await b.releaseViewer('v1');
    expect((await rejection(b.read('v1', h.fileId, 0, 10))).code).toBe('FILE_NOT_FOUND');
    await b.dispose();
  });

  it('clamps ranges to the file size and rejects invalid or oversized ranges', async () => {
    const b = new FileAccessBroker({ maxChunkBytes: 1000 });
    const h = await b.register('v1', fileA);
    expect((await b.read('v1', h.fileId, 9_990, 20_000)).length).toBe(10);
    expect((await b.read('v1', h.fileId, 20_000, 30_000)).length).toBe(0);
    expect((await b.read('v1', h.fileId, 50, 50)).length).toBe(0);
    expect((await rejection(b.read('v1', h.fileId, 0, 1001))).message).toMatch(/chunk limit/);
    expect((await rejection(b.read('v1', h.fileId, -1, 10))).message).toMatch(/Invalid byte range/);
    expect((await rejection(b.read('v1', h.fileId, 0.5, 10))).message).toMatch(/Invalid byte range/);
    await b.dispose();
  });

  it('fails registration for missing files and relative paths', async () => {
    const b = new FileAccessBroker();
    expect((await rejection(b.register('v1', join(dir, 'missing.bam')))).code).toBe('FILE_NOT_FOUND');
    expect((await rejection(b.register('v1', 'relative.bam'))).code).toBe('INTERNAL');
    await b.dispose();
  });

  it('coalesces a read contained in an in-flight read of the same file', async () => {
    const b = new FileAccessBroker();
    const h = await b.register('v1', fileA);
    const [big, small] = await Promise.all([b.read('v1', h.fileId, 0, 5000), b.read('v1', h.fileId, 1000, 1010)]);
    expect(big.length).toBe(5000);
    expect([...small]).toEqual([...dataA.slice(1000, 1010)]);
    const m = b.getMetrics('v1');
    expect(m.requests).toBe(2);
    expect(m.bytes).toBe(5010);
    await b.dispose();
  });

  it('tracks metrics per viewer and per file', async () => {
    const b = new FileAccessBroker();
    const a = await b.register('v1', fileA, 'a.bam');
    const bb = await b.register('v1', fileB, 'b.bai');
    await b.read('v1', a.fileId, 0, 100);
    await b.read('v1', a.fileId, 100, 300);
    await b.read('v1', bb.fileId, 0, 500);
    const m = b.getMetrics('v1');
    expect(m.requests).toBe(3);
    expect(m.bytes).toBe(800);
    expect(m.p50LatencyMs).toBeGreaterThanOrEqual(0);
    expect(m.p95LatencyMs).toBeGreaterThanOrEqual(m.p50LatencyMs);
    expect(m.files).toEqual([
      { fileId: a.fileId, displayPath: 'a.bam', size: 10_000, bytesRead: 300, requests: 2 },
      { fileId: bb.fileId, displayPath: 'b.bai', size: 500, bytesRead: 500, requests: 1 },
    ]);
    expect(b.getMetrics('nobody')).toMatchObject({ requests: 0, bytes: 0, files: [] });
    await b.dispose();
  });

  it('closes handles when the last viewer referencing a path is released, keeps shared ones', async () => {
    const b = new FileAccessBroker();
    const h1 = await b.register('v1', fileA);
    const h2 = await b.register('v2', fileA);
    await b.read('v1', h1.fileId, 0, 10);
    expect(b.openHandleCount).toBe(1);
    await b.releaseViewer('v1');
    expect(b.openHandleCount).toBe(1);
    await b.read('v2', h2.fileId, 0, 10);
    await b.unregister('v2', h2.fileId);
    expect(b.openHandleCount).toBe(0);
    await b.dispose();
  });

  it('evicts the least recently used handle beyond the limit', async () => {
    const b = new FileAccessBroker({ maxOpenHandles: 1 });
    const a = await b.register('v1', fileA);
    const bb = await b.register('v1', fileB);
    await b.read('v1', a.fileId, 0, 10);
    await b.read('v1', bb.fileId, 0, 10);
    expect(b.openHandleCount).toBe(1);
    // Reading A again reopens it transparently.
    expect([...(await b.read('v1', a.fileId, 5, 8))]).toEqual([...dataA.slice(5, 8)]);
    await b.dispose();
    expect((await rejection(b.read('v1', a.fileId, 0, 1))).message).toMatch(/disposed/);
  });
});
