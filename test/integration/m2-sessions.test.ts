import * as assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { IgvExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'alleninstituteseahub.igv-vscode';
const FIXTURES = resolve(__dirname, '../../test/fixtures/generated');
const fx = (name: string) => join(FIXTURES, name);

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

async function closeAllViewers(api: IgvExtensionApi): Promise<void> {
  for (const v of api.viewers.list()) api.viewers.resolve(v.id).dispose();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

suite('M2 sessions, custom editors, snapshots', function () {
  const tmpRoots: string[] = [];
  suiteSetup(function () {
    if (!existsSync(fx('small.bam'))) this.skip();
  });
  suiteTeardown(() => {
    for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  });

  test('session round trip survives moving the whole directory', reporting(async () => {
    const api = await getApi();
    await closeAllViewers(api);
    const root = mkdtempSync(join(tmpdir(), 'igv-session-'));
    tmpRoots.push(root);
    const projA = join(root, 'projA');
    cpSync(FIXTURES, join(projA, 'data'), { recursive: true, filter: (src) => !/large\.bam|unindexed_big/.test(src) });

    const genome = api.genomes.fromLocalFile(join(projA, 'data', 'ref.fa'));
    const v1 = await api.viewers.open({ genome, opener: 'agent', locus: 'chrT:2,001-3,000', name: 'rt' });
    await v1.addTracks([
      { path: join(projA, 'data', 'small.bam'), name: 'Reads', options: { color: '#c00', height: 150 } },
      { path: join(projA, 'data', 'genes.bed') },
      { path: join(projA, 'data', 'variants.vcf.gz') },
    ]);
    const sessionPath = join(projA, 'sessions', 'view.igv.json');
    const saved = await api.sessions.save(v1, sessionPath, true);
    v1.dispose();
    const json = JSON.parse(readFileSync(saved, 'utf8'));
    assert.deepEqual(json.igvVscode, { version: 1 });
    assert.deepEqual(json.reference, { id: 'ref', name: 'ref.fa', fastaPath: '../data/ref.fa', indexPath: '../data/ref.fa.fai' });
    assert.equal(json.locus, 'chrT:2,001-3,000');
    assert.equal(json.tracks[0].path, '../data/small.bam');
    assert.equal(json.tracks[0].indexPath, '../data/small.bam.bai');
    assert.equal(json.tracks[0].color, '#cc0000');
    assert.equal(json.tracks[0].height, 150);
    assert.equal(json.tracks[0].name, 'Reads');
    assert.ok(!JSON.stringify(json).includes(projA), 'session must not contain absolute paths');

    // Move everything.
    const projB = join(root, 'elsewhere', 'projB');
    cpSync(projA, projB, { recursive: true });
    rmSync(projA, { recursive: true, force: true });
    assert.ok(!existsSync(projA));

    const v2 = await api.viewers.open({ genome: api.genomes.resolve('sacCer3'), opener: 'agent', name: 'loader' });
    try {
      const result = await api.sessions.loadFile(v2, join(projB, 'sessions', 'view.igv.json'));
      assert.deepEqual(result.warnings, []);
      assert.equal(result.state.genome?.source, 'local-file');
      assert.equal(result.state.genome?.id, 'ref');
      assert.match(result.state.loci[0]!, /^chrT:2,001-3,000$/);
      assert.deepEqual(result.state.tracks.map((t) => [t.name, t.format, t.indexed, t.error]), [
        ['Reads', 'bam', true, null], ['genes', 'bed', false, null], ['variants', 'vcf', true, null],
      ]);
      assert.ok(result.state.tracks[0]!.source.startsWith(projB));
      // Saving again preserves the explicit options and relative layout.
      const again = await api.sessions.build(v2, join(projB, 'sessions'), true);
      assert.equal(again.tracks[0]!.path, '../data/small.bam');
      assert.equal(again.tracks[0]!.color, '#cc0000');
    } finally {
      v2.dispose();
    }
  }));

  test('custom editor: a data file becomes a viewer, a second file joins the active viewer, a session file opens as a viewer', reporting(async () => {
    const api = await getApi();
    await closeAllViewers(api);
    const config = vscode.workspace.getConfiguration('igv');
    await config.update('defaultGenome', fx('ref.fa'), vscode.ConfigurationTarget.Workspace);
    try {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fx('small.bam')), 'igv.editor');
      await waitFor(() => api.viewers.list().length === 1 && api.viewers.list()[0]!.trackCount === 1, 20_000, 'viewer from custom editor');
      const v = api.viewers.resolve();
      assert.equal(v.name, 'small.bam');
      assert.equal(v.getState().genome?.id, 'ref');
      assert.deepEqual(v.getState().tracks.map((t) => t.name), ['small']);

      // Second file with openBehavior=addToActive joins the same viewer; no second viewer appears.
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fx('coverage.bw')), 'igv.editor');
      await waitFor(() => v.getState().tracks.length === 2, 20_000, 'track added via custom editor');
      assert.equal(api.viewers.list().length, 1);
      assert.deepEqual(v.getState().tracks.map((t) => t.name), ['small', 'coverage']);

      // Opening the same file again must not duplicate the track.
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fx('coverage.bw')), 'igv.editor');
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(v.getState().tracks.map((t) => t.name), ['small', 'coverage'], 'no duplicate track');

      // Text-format option editor works too.
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fx('genes.bed')), 'igv.editorOption');
      await waitFor(() => v.getState().tracks.length === 3, 20_000, 'bed added via option editor');

      // A session file always opens as its own viewer.
      const sessionPath = join(mkdtempSync(join(tmpdir(), 'igv-sess-')), 'fixture.igv.json');
      tmpRoots.push(resolve(sessionPath, '..'));
      await api.sessions.save(v, sessionPath, false);
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(sessionPath), 'igv.editor');
      await waitFor(() => api.viewers.list().length === 2 && api.viewers.list()[1]!.trackCount === 3, 30_000, 'session viewer');
      const sv = api.viewers.resolve('fixture');
      assert.deepEqual(sv.getState().tracks.map((t) => t.name), ['small', 'coverage', 'genes']);

      // A remembered locus from another genome must not break re-opening the file.
      await closeAllViewers(api);
      await config.update('defaultGenome', 'sacCer3', vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fx('small.bam')), 'igv.editor');
      await waitFor(() => api.viewers.list().length === 1 && api.viewers.list()[0]!.trackCount === 1, 30_000, 'viewer on sacCer3');
      const mism = api.viewers.resolve();
      assert.equal(mism.getState().genome?.id, 'sacCer3');
      await mism.goto('chrII:1-5000');
      await closeAllViewers(api);
      await config.update('defaultGenome', fx('ref.fa'), vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fx('small.bam')), 'igv.editor');
      await waitFor(() => api.viewers.list().length === 1 && api.viewers.list()[0]!.trackCount === 1, 30_000, 'viewer back on ref');
      const back = api.viewers.resolve();
      assert.equal(back.getState().genome?.id, 'ref');
      assert.match(back.getState().loci[0]!, /^chr[ST]:/);
      assert.equal(back.getState().tracks[0]!.inView, true);
    } finally {
      await config.update('defaultGenome', undefined, vscode.ConfigurationTarget.Workspace);
      await closeAllViewers(api);
    }
  }));

  test('PNG snapshot is a real PNG at the requested scale; SVG snapshot matches', reporting(async () => {
    const api = await getApi();
    await closeAllViewers(api);
    const v = await api.viewers.open({ genome: api.genomes.fromLocalFile(fx('ref.fa')), opener: 'agent', locus: 'chrT:1,001-2,000' });
    try {
      await v.addTracks([{ path: fx('small.bam') }]);
      const svg = await v.snapshotSvg();
      const png = await v.snapshotPng(2);
      assert.deepEqual([...png.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.equal(png.width, Math.round(Math.ceil(svg.width) * 2));
      assert.ok(png.height >= svg.height * 2 - 2);
      assert.ok(png.png.length > 10_000, `png is only ${png.png.length} bytes`);
    } finally {
      v.dispose();
    }
  }));

  test('Go to Locus from Selection parses the selected BED line and a VCF line', reporting(async () => {
    const api = await getApi();
    await closeAllViewers(api);
    const v = await api.viewers.open({ genome: api.genomes.fromLocalFile(fx('ref.fa')), opener: 'agent', locus: 'chrT:1-100' });
    try {
      const doc = await vscode.workspace.openTextDocument({ content: '# header\nchrT\t5000\t6000\tgene1\t0\t+\nchrS\t1000000\tsnp\tA\tC\t.\tPASS\t.\n', language: 'plaintext' });
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      editor.selection = new vscode.Selection(1, 0, 1, 10);
      await vscode.commands.executeCommand('igv.gotoLocusFromSelection');
      assert.match(v.getState().loci[0]!, /^chrT:5,001-6,000$/);
      // Cursor on the VCF line, no selection → current line.
      const editor2 = await vscode.window.showTextDocument(doc, { preview: false });
      editor2.selection = new vscode.Selection(2, 3, 2, 3);
      await vscode.commands.executeCommand('igv.gotoLocusFromSelection');
      assert.match(v.getState().loci[0]!, /^chrS:999,950-1,000,050$/);
    } finally {
      v.dispose();
    }
  }));

  test('restore entries round-trip through workspace state', reporting(async () => {
    const api = await getApi();
    await closeAllViewers(api);
    const v = await api.viewers.open({ genome: api.genomes.fromLocalFile(fx('ref.fa')), opener: 'agent', locus: 'chrT:3,001-4,000', name: 'before-reload' });
    await v.addTracks([{ path: fx('small.bam') }, { path: fx('genes.bed') }]);
    await api.sessions.rememberForRestore('test-key', v);
    v.dispose();
    const entry = await api.sessions.takeRestoreEntry('test-key');
    assert.ok(entry);
    assert.equal(entry.name, 'before-reload');
    assert.equal(await api.sessions.takeRestoreEntry('test-key'), undefined, 'entry is consumed');
    const v2 = await api.viewers.open({ genome: api.genomes.resolve('sacCer3'), opener: 'agent' });
    try {
      const r = await api.sessions.applyRestoreEntry(v2, entry);
      assert.deepEqual(r.warnings, []);
      assert.match(r.state.loci[0]!, /^chrT:3,001-4,000$/);
      assert.deepEqual(r.state.tracks.map((t) => basename(t.source)), ['small.bam', 'genes.bed']);
      assert.ok(statSync(r.state.tracks[0]!.source).isFile());
    } finally {
      v2.dispose();
    }
  }));
});

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
