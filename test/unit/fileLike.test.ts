import { describe, expect, it } from 'vitest';
import {
  RangeCache,
  decodePayload,
  fileLike,
  hydrateFileRefs,
  readRange,
  type FileHandleInfo,
  type ReadParams,
} from '../../webview/FileLike';

const data = new Uint8Array(100).map((_, i) => i);
const handle: FileHandleInfo = { fileId: 'f1', name: 'x.bam', size: data.length, displayPath: 'x.bam' };

function transport(encoding: 'binary' | 'base64' = 'binary') {
  const calls: ReadParams[] = [];
  return {
    calls,
    read: async (p: ReadParams) => {
      calls.push(p);
      const slice = data.slice(p.start, p.end);
      return encoding === 'binary' ? slice : Buffer.from(slice).toString('base64');
    },
  };
}

describe('fileLike', () => {
  it('has the shape igv.js detects: own name, slice and arrayBuffer', () => {
    const f = fileLike(handle, transport(), { maxChunkBytes: 1000, encoding: 'binary' });
    expect(Object.prototype.hasOwnProperty.call(f, 'name')).toBe(true);
    expect(typeof f.slice).toBe('function');
    expect(typeof f.arrayBuffer).toBe('function');
    expect(f.size).toBe(100);
  });

  it('slice(start,end).arrayBuffer() returns exactly that range as an ArrayBuffer', async () => {
    const t = transport();
    const f = fileLike(handle, t, { maxChunkBytes: 1000, encoding: 'binary' });
    const ab = await f.slice(10, 20).arrayBuffer();
    expect(ab).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(ab)]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(t.calls).toEqual([{ fileId: 'f1', start: 10, end: 20 }]);
  });

  it('clamps to the file size and treats missing/non-finite end as EOF', async () => {
    const t = transport();
    const f = fileLike(handle, t, { maxChunkBytes: 1000, encoding: 'binary' });
    expect(new Uint8Array(await f.slice(95, 500).arrayBuffer()).length).toBe(5);
    expect(new Uint8Array(await f.slice(90).arrayBuffer()).length).toBe(10);
    expect(new Uint8Array(await f.slice(90, Infinity).arrayBuffer()).length).toBe(10);
    expect(new Uint8Array(await f.arrayBuffer()).length).toBe(100);
    expect(new Uint8Array(await f.slice(200, 300).arrayBuffer()).length).toBe(0);
  });

  it('splits large reads into sequential chunks and reassembles them', async () => {
    const t = transport();
    const out = await readRange(t, handle, 5, 95, { maxChunkBytes: 30, encoding: 'binary' });
    expect(t.calls.map((c) => [c.start, c.end])).toEqual([[5, 35], [35, 65], [65, 95]]);
    expect([...out]).toEqual([...data.slice(5, 95)]);
  });

  it('decodes base64 payloads in base64 mode and rejects strings in binary mode', async () => {
    const out = await readRange(transport('base64'), handle, 0, 10, { maxChunkBytes: 1000, encoding: 'base64' });
    expect([...out]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await expect(readRange(transport('base64'), handle, 0, 10, { maxChunkBytes: 1000, encoding: 'binary' })).rejects.toThrow(/string payload/);
    expect([...decodePayload({ type: 'Buffer', data: [1, 2] } as unknown as Uint8Array, 'binary')]).toEqual([1, 2]);
  });

  it('caches small ranges and serves repeats without a transport call', async () => {
    const t = transport();
    const cache = new RangeCache(50, 1000);
    const opts = { maxChunkBytes: 1000, encoding: 'binary' as const, cache };
    await readRange(t, handle, 0, 10, opts);
    await readRange(t, handle, 0, 10, opts);
    expect(t.calls.length).toBe(1);
    expect(cache.hits).toBe(1);
    await readRange(t, handle, 0, 60, opts); // above maxEntryBytes: not cached
    await readRange(t, handle, 0, 60, opts);
    expect(t.calls.length).toBe(3);
    expect(cache.size).toBe(1);
  });

  it('evicts least recently used entries when over the total budget', () => {
    const cache = new RangeCache(100, 25);
    cache.put('a', 0, 10, new Uint8Array(10));
    cache.put('a', 10, 20, new Uint8Array(10));
    cache.get('a', 0, 10); // refresh a:0:10
    cache.put('b', 0, 10, new Uint8Array(10)); // total 30 > 25 → evict a:10:20
    expect(cache.get('a', 10, 20)).toBeUndefined();
    expect(cache.get('a', 0, 10)).toBeDefined();
    expect(cache.bytes).toBe(20);
    cache.evictFile('a');
    expect(cache.size).toBe(1);
  });

  it('hydrates file markers anywhere in a config and reports the handles found', async () => {
    const t = transport();
    const found: FileHandleInfo[] = [];
    const cfg = hydrateFileRefs(
      { name: 'T', url: { __igvVscodeFile: handle }, indexURL: { __igvVscodeFile: { ...handle, fileId: 'f2' } }, nested: [{ x: 1 }] },
      t,
      { maxChunkBytes: 1000, encoding: 'binary' },
      found,
    );
    expect(found.map((h) => h.fileId)).toEqual(['f1', 'f2']);
    expect(cfg.name).toBe('T');
    expect(cfg.nested).toEqual([{ x: 1 }]);
    const url = cfg.url as unknown as { slice(a: number, b: number): { arrayBuffer(): Promise<ArrayBuffer> } };
    expect(typeof url.slice).toBe('function');
    expect(new Uint8Array(await url.slice(0, 2).arrayBuffer()).length).toBe(2);
  });
});
