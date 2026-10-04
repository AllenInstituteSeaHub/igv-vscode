/**
 * Perf job (spec §5.4, §11.2). Runs only when IGV_PERF=1 and the ≥5 GB
 * fixture exists (`.venv/bin/python scripts/make-fixtures.py --perf-bam-gb 5`).
 * Prints a markdown table to stdout and writes it to test/fixtures/generated/PERF.md
 * for PROGRESS.md.
 */
import * as assert from 'node:assert/strict';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { IgvExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'igv-vscode-dev.igv-vscode';
const FIXTURES = resolve(__dirname, '../../test/fixtures/generated');
const fx = (name: string) => join(FIXTURES, name);
const PERF_BAM = process.env.IGV_PERF_BAM ?? fx('perf.bam');
const PERF_REF = process.env.IGV_PERF_REF ?? fx('perf_ref.fa');

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0;
}

suite('perf (IGV_PERF=1)', function () {
  suiteSetup(function () {
    if (process.env.IGV_PERF !== '1' || !existsSync(PERF_BAM) || !existsSync(`${PERF_BAM}.bai`) || !existsSync(PERF_REF)) this.skip();
  });

  test('≥5 GB BAM: open + first render, navigations, bytes read', async () => {
    const ext = vscode.extensions.getExtension<IgvExtensionApi>(EXTENSION_ID);
    assert.ok(ext);
    const api = await ext.activate();
    const size = statSync(PERF_BAM).size;
    const host = vscode.env.remoteName ? `remote (${vscode.env.remoteName})` : vscode.env.appHost === 'desktop' ? 'desktop' : vscode.env.appHost;

    const t0 = performance.now();
    const genome = api.genomes.fromLocalFile(PERF_REF);
    const viewer = await api.viewers.open({ genome, opener: 'agent', name: 'perf' });
    const chroms = viewer.chromosomes;
    assert.ok(chroms.length > 0);
    await viewer.goto(`${chroms[0]}:1,000,001-1,002,000`);
    try {
      const r = await viewer.addTracks([{ path: PERF_BAM, name: 'perf' }]);
      assert.deepEqual(r.warnings, []);
      assert.ok(await viewer.settle({ timeoutMs: 60_000 }), 'first render settled');
      const firstRenderMs = performance.now() - t0;
      const m0 = viewer.getState(true).metrics!;
      const bam0 = m0.files.find((f) => f.displayPath.endsWith('perf.bam'))!;
      const bai = m0.files.find((f) => f.displayPath.endsWith('.bai'))!;

      const navMs: number[] = [];
      const rng = (() => { let x = 12345; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; })();
      for (let i = 0; i < 10; i++) {
        const chr = chroms[Math.floor(rng() * chroms.length)]!;
        const start = 1 + Math.floor(rng() * 14_990_000);
        const t = performance.now();
        await viewer.goto(`${chr}:${start.toLocaleString('en-US')}-${(start + 1999).toLocaleString('en-US')}`);
        assert.ok(await viewer.settle({ timeoutMs: 60_000 }), `navigation ${i} settled`);
        navMs.push(performance.now() - t);
      }
      const m1 = viewer.getState(true).metrics!;
      const bam1 = m1.files.find((f) => f.displayPath.endsWith('perf.bam'))!;
      const navBytes = bam1.bytesRead - bam0.bytesRead;
      const navPct = (100 * navBytes) / size;
      const p50 = percentile(navMs, 50);
      const p95 = percentile(navMs, 95);
      const table = [
        `| Scenario (${host}, VS Code ${vscode.version}) | Result | Target |`,
        '|---|---|---|',
        `| BAM size | ${(size / 1e9).toFixed(2)} GB | ≥ 5 GB |`,
        `| Open + first render at a 2 kb locus | ${(firstRenderMs / 1000).toFixed(2)} s | < 3 s local, < 5 s code-server |`,
        `| 10 subsequent 2 kb navigations | median ${(p50 / 1000).toFixed(2)} s, p95 ${(p95 / 1000).toFixed(2)} s | median < 0.5 s, p95 < 1.5 s |`,
        `| Bytes read for 10 navigations | ${(navBytes / 1e6).toFixed(1)} MB = ${navPct.toFixed(3)} % of file (${bam1.requests - bam0.requests} reads) | < 1 % |`,
        `| BAI (${(bai.size / 1e6).toFixed(1)} MB) | read ${bai.requests}× (${(bai.bytesRead / 1e6).toFixed(1)} MB) | loaded once per viewer |`,
        `| Read latency (broker, all files) | p50 ${m1.p50LatencyMs} ms, p95 ${m1.p95LatencyMs} ms over ${m1.requests} reads | |`,
      ].join('\n');
      console.log(`\n[PERF]\n${table}\n`);
      writeFileSync(fx('PERF.md'), `${table}\n`);
      assert.ok(navPct < 1, `bytes for 10 navigations ${navPct.toFixed(3)}% ≥ 1%`);
      assert.ok(p50 < 500, `median navigation ${p50.toFixed(0)} ms ≥ 500 ms`);
      assert.ok(p95 < 1500, `p95 navigation ${p95.toFixed(0)} ms ≥ 1500 ms`);
      assert.ok(firstRenderMs < 3000, `first render ${firstRenderMs.toFixed(0)} ms ≥ 3 s`);
    } finally {
      viewer.dispose();
    }
  });
});
