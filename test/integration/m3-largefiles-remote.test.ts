import * as assert from 'node:assert/strict';
import { copyFileSync, createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { IgvExtensionApi } from '../../src/extension';
import type { RpcError } from '../../src/shared/rpc';

const EXTENSION_ID = 'igv-vscode-dev.igv-vscode';
const ROOT = resolve(__dirname, '../..');
const FIXTURES = join(ROOT, 'test/fixtures/generated');
const fx = (name: string) => join(FIXTURES, name);
const SHIMS = join(ROOT, 'test/tools/bin');
const VENV_BIN = join(ROOT, '.venv/bin');

async function getApi(): Promise<IgvExtensionApi> {
  const ext = vscode.extensions.getExtension<IgvExtensionApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}
function reporting<T>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      console.error('[TEST FAILURE]', err instanceof Error ? `${err.message}\n${err.stack}` : String(err), JSON.stringify((err as { data?: unknown })?.data ?? null));
      throw err;
    }
  };
}
async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    return e as RpcError;
  }
  throw new Error('expected rejection');
}
async function closeAllViewers(api: IgvExtensionApi): Promise<void> {
  for (const v of api.viewers.list()) api.viewers.resolve(v.id).dispose();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Static file server with Range support; CORS headers optional. */
function startServer(cors: boolean): Promise<{ base: string; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const file = fx(decodeURIComponent((req.url ?? '/').split('?')[0]!.replace(/^\//, '')));
    hits.push(`${req.method} ${basename(file)} ${req.headers.range ?? ''}`.trim());
    const headers: Record<string, string> = { 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' };
    if (cors) {
      headers['access-control-allow-origin'] = '*';
      headers['access-control-allow-headers'] = 'Range';
      headers['access-control-expose-headers'] = 'Content-Range, Content-Length, Accept-Ranges';
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(cors ? 204 : 403, headers).end();
      return;
    }
    if (!existsSync(file)) {
      res.writeHead(404, headers).end();
      return;
    }
    const size = statSync(file).size;
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'content-length': String(size) }).end();
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (m) {
      const s = Number(m[1]);
      const e = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, { ...headers, 'content-range': `bytes ${s}-${e}/${size}`, 'content-length': String(e - s + 1) });
      createReadStream(file, { start: s, end: e }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': String(size) });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveStart) =>
    server.listen(0, '127.0.0.1', () =>
      resolveStart({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise((r) => server.close(() => r())),
        hits,
      }),
    ),
  );
}

suite('M3 large files, remote data, CRAM', function () {
  const config = () => vscode.workspace.getConfiguration('igv');
  suiteSetup(function () {
    if (!existsSync(fx('small.bam'))) this.skip();
  });
  teardown(async () => {
    await config().update('remote.mode', undefined, vscode.ConfigurationTarget.Workspace);
    await config().update('remote.allowHttp', undefined, vscode.ConfigurationTarget.Workspace);
    await config().update('transport.mode', undefined, vscode.ConfigurationTarget.Workspace);
  });

  test('remote BAM: direct mode (browser fetch with CORS) and proxy mode (host fetch) both render reads', reporting(async () => {
    const api = await getApi();
    await closeAllViewers(api);
    const server = await startServer(true);
    try {
      // Direct: http:// needs allowHttp in the CSP; panel HTML is built at creation so set it first.
      await config().update('remote.allowHttp', true, vscode.ConfigurationTarget.Workspace);
      await config().update('remote.mode', 'direct', vscode.ConfigurationTarget.Workspace);
      const v1 = await api.viewers.open({ genome: api.genomes.fromLocalFile(fx('ref.fa')), opener: 'agent', locus: 'chrT:1,001-3,000', name: 'direct' });
      try {
        const r = await v1.addTracks([{ url: `${server.base}/small.bam`, index: `${server.base}/small.bam.bai`, name: 'remote' }]);
        assert.deepEqual(r.warnings, []);
        assert.ok(await v1.settle({ timeoutMs: 30_000 }));
        const svg = await v1.snapshotSvg();
        assert.ok((svg.svg.match(/<rect\b/g) ?? []).length > 50, 'direct: reads drawn');
        assert.ok(server.hits.some((h) => h.startsWith('GET small.bam bytes=')), `direct: browser used Range requests: ${server.hits.slice(0, 5).join(' | ')}`);
        assert.deepEqual(api.broker.listFiles(v1.id).map((f) => f.name).sort(), ['ref.fa', 'ref.fa.fai'], 'direct mode: only the reference goes through the broker');
      } finally {
        v1.dispose();
      }

      // Proxy: the host fetches; the index is discovered by probing <url>.bai.
      server.hits.length = 0;
      await config().update('remote.mode', 'proxy', vscode.ConfigurationTarget.Workspace);
      const v2 = await api.viewers.open({ genome: api.genomes.fromLocalFile(fx('ref.fa')), opener: 'agent', locus: 'chrT:1,001-3,000', name: 'proxy' });
      try {
        const r = await v2.addTracks([{ url: `${server.base}/small.bam`, name: 'proxied' }]);
        assert.deepEqual(r.warnings, []);
        assert.ok(await v2.settle({ timeoutMs: 30_000 }));
        const svg = await v2.snapshotSvg();
        assert.ok((svg.svg.match(/<rect\b/g) ?? []).length > 50, 'proxy: reads drawn');
        const files = api.broker.listFiles(v2.id).map((f) => f.name).sort();
        assert.deepEqual(files, ['ref.fa', 'ref.fa.fai', 'small.bam', 'small.bam.bai']);
        const m = v2.getState(true).metrics!;
        const bam = m.files.find((f) => f.displayPath.endsWith('small.bam'))!;
        assert.ok(bam.bytesRead > 0, 'proxy served the BAM bytes');
        // Missing remote index for a BAM is an INDEX_REQUIRED error with the tried URLs.
        const err = await rejection(v2.addTracks([{ url: `${server.base}/noindex.bam` }]));
        assert.equal(err.code, 'INDEX_REQUIRED');
        assert.match((err.data as { hint: string }).hint, /noindex\.bam\.bai/);
        // 404 data file.
        assert.equal((await rejection(v2.addTracks([{ url: `${server.base}/missing.bw` }]))).code, 'REMOTE_UNREACHABLE');
      } finally {
        v2.dispose();
      }
    } finally {
      await server.close();
    }
  }));

  test('remote auto mode: a server without CORS fails directly and is retried through the proxy, origin remembered', reporting(async () => {
    const api = await getApi();
    await closeAllViewers(api);
    const server = await startServer(false);
    try {
      await config().update('remote.allowHttp', true, vscode.ConfigurationTarget.Workspace);
      await config().update('remote.mode', 'auto', vscode.ConfigurationTarget.Workspace);
      const v = await api.viewers.open({ genome: api.genomes.fromLocalFile(fx('ref.fa')), opener: 'agent', locus: 'chrT:1,001-3,000', name: 'auto' });
      try {
        const r = await v.addTracks([{ url: `${server.base}/coverage.bw`, name: 'cov' }]);
        assert.equal(r.added[0]!.error, null, `auto: track should load via proxy after direct failure (warnings: ${r.warnings.join('; ')})`);
        assert.ok(api.broker.listFiles(v.id).some((f) => f.name === 'coverage.bw'), 'retried through the proxy');
        // Second track from the same origin goes straight to the proxy.
        const r2 = await v.addTracks([{ url: `${server.base}/genes.bed`, name: 'genes' }]);
        assert.equal(r2.added[0]!.error, null);
        assert.ok(api.broker.listFiles(v.id).some((f) => f.name === 'genes.bed'));
      } finally {
        v.dispose();
      }
    } finally {
      await server.close();
    }
  }));

  test('CRAM loads against a local reference and is refused without a sequence', reporting(async () => {
    const api = await getApi();
    await closeAllViewers(api);
    if (!existsSync(fx('small.cram'))) {
      console.error('small.cram fixture missing; regenerate fixtures');
      return;
    }
    const v = await api.viewers.open({ genome: api.genomes.fromLocalFile(fx('ref.fa')), opener: 'agent', locus: 'chrT:1,001-3,000' });
    try {
      const r = await v.addTracks([{ path: fx('small.cram') }]);
      assert.deepEqual(r.warnings, []);
      assert.equal(r.added[0]!.format, 'cram');
      assert.equal(r.added[0]!.indexed, true);
      assert.ok(await v.settle({ timeoutMs: 30_000 }));
      const svg = await v.snapshotSvg();
      assert.ok((svg.svg.match(/<rect\b/g) ?? []).length > 50, 'CRAM reads drawn');
    } finally {
      v.dispose();
    }
    // A genome without sequence: craft one from the registry's list shape.
    const noSeq = api.viewers.open({ genome: { id: 'noseq', name: 'no sequence', source: 'custom', reference: { id: 'noseq', chromSizesURL: 'https://example.invalid/x.sizes' } }, opener: 'agent' });
    const vv = await noSeq.catch(() => undefined);
    if (vv) {
      try {
        assert.equal((await rejection(vv.addTracks([{ path: fx('small.cram') }]))).code, 'REFERENCE_REQUIRED');
      } finally {
        vv.dispose();
      }
    }
  }));

  test('large-file policy through the API: INDEX_REQUIRED, then autoIndex with samtools (shim) creates the index and loads', reporting(async () => {
    const api = await getApi();
    await closeAllViewers(api);
    const haveVenv = existsSync(join(VENV_BIN, 'python3'));
    if (!existsSync(join(SHIMS, 'samtools')) || !(haveVenv || process.env.CI === 'true')) {
      console.error('tool shims or .venv missing; skipping policy integration test');
      return;
    }
    const work = mkdtempSync(join(tmpdir(), 'igv-m3-'));
    const savedPath = process.env.PATH;
    process.env.PATH = `${SHIMS}:${haveVenv ? `${VENV_BIN}:` : ''}${savedPath ?? ''}`;
    api.tools.invalidate();
    try {
      copyFileSync(fx('noindex.bam'), join(work, 'big.bam'));
      await config().update('largeFile.unindexedMaxBytes', 1024, vscode.ConfigurationTarget.Workspace);
      const v = await api.viewers.open({ genome: api.genomes.fromLocalFile(fx('ref.fa')), opener: 'agent', locus: 'chrT:1,001-3,000' });
      try {
        const err = await rejection(v.addTracks([{ path: join(work, 'big.bam') }]));
        assert.equal(err.code, 'INDEX_REQUIRED');
        const prepared = await api.policy.prepare([{ path: join(work, 'big.bam'), autoIndex: true }], 'agent');
        assert.equal(prepared.specs[0]!.index, join(work, 'big.bam.bai'));
        const r = await v.addTracks(prepared.specs);
        assert.deepEqual(r.warnings, []);
        assert.equal(r.added[0]!.indexed, true);
        // Subsample via the API.
        const sub = await api.policy.prepare([{ path: fx('small.bam'), subsample: { fraction: 0.5, seed: 1 } }], 'agent');
        assert.match(sub.specs[0]!.name!, /subsample 50%/);
        assert.ok(sub.specs[0]!.path!.startsWith(FIXTURES) || sub.specs[0]!.path!.includes('derived'));
        const r2 = await v.addTracks(sub.specs);
        assert.equal(r2.added[0]!.error, null);
        rmSync(sub.specs[0]!.path!, { force: true });
        rmSync(sub.specs[0]!.index!, { force: true });
      } finally {
        v.dispose();
      }
    } finally {
      process.env.PATH = savedPath;
      api.tools.invalidate();
      await config().update('largeFile.unindexedMaxBytes', undefined, vscode.ConfigurationTarget.Workspace);
      rmSync(work, { recursive: true, force: true });
    }
  }));

  test('webviewUri transport (experimental) renders a BAM without going through the broker', reporting(async () => {
    const api = await getApi();
    await closeAllViewers(api);
    await config().update('transport.mode', 'webviewUri', vscode.ConfigurationTarget.Workspace);
    const v = await api.viewers.open({ genome: api.genomes.fromLocalFile(fx('ref.fa')), opener: 'agent', locus: 'chrT:1,001-3,000', name: 'wvuri' });
    try {
      assert.equal(v.transportMode, 'webviewUri');
      const r = await v.addTracks([{ path: fx('small.bam') }, { path: fx('genes.bed') }]);
      assert.deepEqual(r.warnings, []);
      assert.ok(await v.settle({ timeoutMs: 30_000 }));
      const svg = await v.snapshotSvg();
      assert.ok((svg.svg.match(/<rect\b/g) ?? []).length > 50, 'webviewUri: reads drawn');
      const brokered = api.broker.listFiles(v.id).map((f) => f.name).sort();
      assert.deepEqual(brokered, ['ref.fa', 'ref.fa.fai'], 'only the reference uses the shim in webviewUri mode');
    } finally {
      v.dispose();
    }
  }));
});
