/**
 * M6 hardening: resource cleanup over many open/close cycles and the error
 * codes not covered elsewhere (spec §12 M6: "every data.code reachable").
 */
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { IgvExtensionApi } from '../../src/extension';

const FIXTURES = resolve(__dirname, '../../test/fixtures/generated');
const fx = (n: string) => join(FIXTURES, n);

async function getApi(): Promise<IgvExtensionApi> {
  const ext = vscode.extensions.getExtension<IgvExtensionApi>('igv-vscode-dev.igv-vscode');
  assert.ok(ext);
  return ext.activate();
}

function cli(launcher: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; json: { error?: { code: string; hint?: string } } & Record<string, unknown> }> {
  return new Promise((r) =>
    execFile(launcher, [...args, '--json'], { env, cwd }, (err, stdout, stderr) => {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(stdout || stderr);
      } catch {
        json = { raw: stdout + stderr };
      }
      r({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json: json as never });
    }),
  );
}

suite('M6 hardening', function () {
  this.timeout(10 * 60_000);
  let api: IgvExtensionApi;
  suiteSetup(async function () {
    if (!existsSync(fx('small.bam'))) this.skip();
    api = await getApi();
    for (const v of api.viewers.list()) api.viewers.resolve(v.id).dispose();
  });

  test('20 open/close cycles free file handles, broker entries and viewers; memory growth stays bounded', async () => {
    const genome = api.genomes.fromLocalFile(fx('ref.fa'));
    const before = process.memoryUsage().heapUsed;
    let peakHandles = 0;
    for (let i = 0; i < 20; i++) {
      const v = await api.viewers.open({ genome, opener: 'agent', locus: 'chrT:1,001-3,000', name: `cycle${i}` });
      await v.addTracks([{ path: fx('small.bam') }, { path: fx('coverage.bw') }, { path: fx('genes.bed') }]);
      await v.settle({ timeoutMs: 20_000 });
      if (i % 5 === 0) await v.snapshotPng(1);
      peakHandles = Math.max(peakHandles, api.broker.openHandleCount);
      v.dispose();
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(api.broker.listFiles(v.id), [], `cycle ${i}: allow-list released`);
    }
    assert.equal(api.viewers.list().length, 0);
    assert.equal(api.broker.openHandleCount, 0, 'all file handles closed after the last viewer');
    assert.ok(peakHandles <= 6, `handles never exceeded the files of one viewer (peak ${peakHandles})`);
    if (typeof global.gc === 'function') global.gc();
    await new Promise((r) => setTimeout(r, 500));
    const after = process.memoryUsage().heapUsed;
    const growthMb = (after - before) / 1048576;
    console.log(`[M6 memory] heap before ${(before / 1048576).toFixed(1)} MB, after 20 cycles ${(after / 1048576).toFixed(1)} MB (growth ${growthMb.toFixed(1)} MB), peak open handles ${peakHandles}`);
    assert.ok(growthMb < 60, `extension-host heap grew ${growthMb.toFixed(1)} MB over 20 cycles`);
  });

  test('error codes not covered elsewhere: UNSUPPORTED_FORMAT, GENOME_NOT_FOUND, TOOL_MISSING, REFERENCE_REQUIRED; settle timeout is not an error', async () => {
    for (let i = 0; i < 50 && !api.agent.enabled; i++) await new Promise((r) => setTimeout(r, 100));
    const launcher = api.agent.launcherPaths!.posix;
    const work = mkdtempSync(join(tmpdir(), 'igv-m6-'));
    // No tools on PATH at all for this process tree.
    const env = { ...process.env, IGV_VSCODE_ENDPOINT: api.agent.endpoint!, IGV_VSCODE_TOKEN: api.agent.token!, PATH: '/nonexistent' };
    try {
      const unsupported = await cli(launcher, ['open', '--genome', fx('ref.fa'), join(FIXTURES, 'MANIFEST.json')], env, work);
      assert.equal(unsupported.code, 2);
      assert.equal(unsupported.json.error?.code, 'UNSUPPORTED_FORMAT');
      assert.match(unsupported.json.error!.hint!, /type.*format/i);
      await cli(launcher, ['close', '--all'], env, work);

      const genome = await cli(launcher, ['open', '--genome', 'not-a-genome-at-all'], env, work);
      assert.equal(genome.json.error?.code, 'GENOME_NOT_FOUND');
      assert.match(genome.json.error!.hint!, /igv-vscode genomes/);

      const v = await cli(launcher, ['open', '--genome', fx('ref.fa'), '--locus', 'chrT:1-2,000'], env, work);
      assert.equal(v.code, 0, JSON.stringify(v.json));
      writeFileSync(join(work, 'big.bam'), readFileSync(fx('noindex.bam')));
      await vscode.workspace.getConfiguration('igv').update('largeFile.unindexedMaxBytes', 1024, vscode.ConfigurationTarget.Workspace);
      try {
        api.tools.invalidate();
        const tool = await cli(launcher, ['add', join(work, 'big.bam'), '--auto-index'], env, work);
        assert.equal(tool.json.error?.code, 'TOOL_MISSING', JSON.stringify(tool.json));
        assert.match(tool.json.error!.hint!, /samtools/);
      } finally {
        await vscode.workspace.getConfiguration('igv').update('largeFile.unindexedMaxBytes', undefined, vscode.ConfigurationTarget.Workspace);
        api.tools.invalidate();
      }
      // Sequence-less genome → CRAM needs a reference.
      const noSeq = await api.viewers.open({ genome: { id: 'noseq', name: 'no sequence', source: 'custom', reference: { id: 'noseq', chromSizesURL: 'https://example.invalid/x.sizes' } }, opener: 'agent' }).catch(() => undefined);
      if (noSeq) {
        const ref = await cli(launcher, ['add', fx('small.cram'), '--viewer', noSeq.id], env, work);
        assert.equal(ref.json.error?.code, 'REFERENCE_REQUIRED');
        noSeq.dispose();
      }
      // A waitForRender timeout is never an error: the call returns with a boolean `settled` (true here, since nothing was left to load).
      const slow = await cli(launcher, ['goto', 'chrT:1-30,000', '--timeout', '0.001'], env, work);
      assert.equal(slow.code, 0, JSON.stringify(slow.json));
      assert.equal(typeof slow.json.settled, 'boolean');
      await cli(launcher, ['close', '--all'], env, work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('agent API reports why it is disabled', () => {
    // In this trusted test workspace the channel is on; the reasons are exercised by the unit layer.
    assert.equal(api.agent.disabledReason, undefined);
    assert.equal(api.agent.enabled, true);
  });
});
