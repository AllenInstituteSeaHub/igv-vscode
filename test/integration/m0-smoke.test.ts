import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IgvExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'igv-vscode-dev.igv-vscode';

async function getApi(): Promise<IgvExtensionApi> {
  const ext = vscode.extensions.getExtension<IgvExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} is not installed in the test host`);
  return ext.activate();
}

/** Mocha's failure summary can be lost when the extension host exits; print failures eagerly. */
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

suite('M0 smoke', () => {
  test('activates and registers commands', async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('igv.newViewer'));
    assert.ok(commands.includes('igv.showOutput'));
  });

  test('bundled genome list resolves common genomes', async () => {
    const api = await getApi();
    assert.ok(api.genomes.list().length > 10);
    assert.equal(api.genomes.resolve('hg38').id, 'hg38');
    assert.equal(api.genomes.resolve('HG19').id, 'hg19');
    assert.throws(() => api.genomes.resolve('not-a-genome'), /GENOME_NOT_FOUND|Unknown genome/);
  });

  test('opens a viewer on a bundled genome and navigates (needs network)', reporting(async () => {
    const api = await getApi();
    const genome = api.genomes.resolve('sacCer3');
    const viewer = await api.viewers.open({ genome, opener: 'agent', locus: 'chrI:1-20000', name: 'smoke' });
    try {
      const state = viewer.getState();
      assert.match(state.id, /^v\d+$/);
      assert.equal(state.name, 'smoke');
      assert.equal(state.genome?.id, 'sacCer3');
      assert.equal(state.genome?.source, 'bundled-list');
      assert.ok(state.loci.length === 1, `expected one locus, got ${JSON.stringify(state.loci)}`);
      // igv reports the canonical sequence name (NC_001133.9 for chrI in sacCer3), so check coordinates only.
      assert.match(state.loci[0]!, /^[^:]+:1-20,?000$/);

      const after = await viewer.goto('chrII:100,001-110,000');
      assert.match(after.loci[0]!, /^[^:]+:100,?001-110,?000$/);
      assert.notEqual(after.loci[0]!.split(':')[0], state.loci[0]!.split(':')[0], 'navigation should change chromosome');

      const list = api.viewers.list();
      assert.equal(list.length, 1);
      assert.equal(list[0]!.active, true);
      assert.equal(api.viewers.resolve('smoke').id, viewer.id);
      assert.equal(api.viewers.resolve(undefined).id, viewer.id);
    } finally {
      viewer.dispose();
    }
    assert.equal(api.viewers.size, 0);
    assert.throws(() => api.viewers.resolve(undefined), /NO_VIEWER|No IGV viewer/);
  }));

  test('opening a data file uses igv.defaultGenome without prompting (needs network)', reporting(async () => {
    // "IGV: New Viewer" always shows the genome picker (default listed first), so the
    // silent-default path is exercised through "Open in New Viewer" with a file argument.
    const api = await getApi();
    for (const v of api.viewers.list()) api.viewers.resolve(v.id).dispose();
    const config = vscode.workspace.getConfiguration('igv');
    await config.update('defaultGenome', 'sacCer3', vscode.ConfigurationTarget.Workspace);
    try {
      const bed = vscode.Uri.file(path.resolve(__dirname, '../../test/fixtures/generated/genes.bed'));
      await vscode.commands.executeCommand('igv.openInNewViewer', bed, [bed]);
      const viewers = api.viewers.list();
      assert.equal(viewers.length, 1);
      assert.equal(viewers[0]!.genome?.id, 'sacCer3');
      assert.ok(viewers[0]!.loci.length > 0);
      api.viewers.resolve(viewers[0]!.id).dispose();
    } finally {
      await config.update('defaultGenome', undefined, vscode.ConfigurationTarget.Workspace);
    }
  }));
});
