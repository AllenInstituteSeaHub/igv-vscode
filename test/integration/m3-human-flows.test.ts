import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { IgvExtensionApi } from '../../src/extension';

const FIXTURES = resolve(__dirname, '../../test/fixtures/generated');
const fx = (n: string) => join(FIXTURES, n);
async function getApi(): Promise<IgvExtensionApi> {
  const ext = vscode.extensions.getExtension<IgvExtensionApi>('alleninstituteseahub.igv-vscode');
  return ext!.activate();
}
async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const d = Date.now() + ms;
  while (Date.now() < d) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}

suite('human flows (regressions from checkpoint 2)', () => {
  test('double-clicking a CRAM opens where its reads are, not the whole-genome view', async function () {
    if (!existsSync(fx('small.cram'))) return;
    const api = await getApi();
    for (const v of api.viewers.list()) api.viewers.resolve(v.id).dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const cfg = vscode.workspace.getConfiguration('igv');
    await cfg.update('defaultGenome', '../generated/ref.fa', vscode.ConfigurationTarget.Workspace); // relative to the test workspace, like the human's setup
    try {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fx('small.cram')), 'igv.editor');
      await waitFor(() => api.viewers.list().length === 1 && api.viewers.list()[0]!.trackCount === 1, 30_000, 'cram viewer');
      const v = api.viewers.resolve();
      await v.settle({ timeoutMs: 20_000 });
      const t = v.getState().tracks[0]!;
      assert.equal(t.error, null);
      assert.match(v.getState().loci[0]!, /^chrT:/, 'opened on the chromosome with reads');
      assert.equal(t.inView, true, JSON.stringify(t));
      const svg = await v.snapshotSvg();
      // Regression guard: CRAM decoding needs WebAssembly, which the CSP must allow ('wasm-unsafe-eval').
      assert.ok((svg.svg.match(/<rect\b/g) ?? []).length > 50, 'CRAM reads drawn');
    } finally {
      await cfg.update('defaultGenome', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('a remote bigWig on the wrong genome is reported as a genome mismatch (needs network)', async () => {
    const api = await getApi();
    for (const v of api.viewers.list()) api.viewers.resolve(v.id).dispose();
    const v = await api.viewers.open({ genome: api.genomes.fromLocalFile(fx('ref.fa')), opener: 'agent', locus: 'chrT:1-5000', name: 'wrong' });
    try {
      const r = await v.addTracks([{ url: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg38/phyloP100way/hg38.phyloP100way.bw' }]);
      assert.equal(r.mismatches.length, 1, JSON.stringify(r));
      assert.ok(r.mismatches[0]!.fileNames.includes('chr1'));
      assert.equal(r.added[0]!.inViewReason, 'genomeMismatch');
    } finally {
      v.dispose();
    }
  });
});
