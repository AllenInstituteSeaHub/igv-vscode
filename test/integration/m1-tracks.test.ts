import * as assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { IgvExtensionApi } from '../../src/extension';
import type { RpcError } from '../../src/shared/rpc';

const EXTENSION_ID = 'alleninstituteseahub.igv-vscode';
const FIXTURES = resolve(__dirname, '../../test/fixtures/generated');
const fx = (name: string) => join(FIXTURES, name);

async function getApi(): Promise<IgvExtensionApi> {
  const ext = vscode.extensions.getExtension<IgvExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} is not installed in the test host`);
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

suite('M1 tracks and data access', function () {
  suiteSetup(function () {
    if (!existsSync(fx('small.bam'))) {
      console.error(`fixtures missing in ${FIXTURES}; run .venv/bin/python scripts/make-fixtures.py`);
      this.skip();
    }
  });

  test('local FASTA genome, all small fixtures load, oversized unindexed BED is refused', reporting(async () => {
    const api = await getApi();
    const genome = api.genomes.fromLocalFile(fx('ref.fa'));
    assert.equal(genome.source, 'local-file');
    const viewer = await api.viewers.open({ genome, opener: 'agent', locus: 'chrT:1,000-4,000', name: 'm1' });
    try {
      assert.equal(viewer.transportEncoding, 'binary', 'binary payloads should round-trip through the desktop webview');
      assert.deepEqual(viewer.chromosomes, ['chrS', 'chrT']);
      assert.match(viewer.getState().loci[0]!, /^chrT:1,?000-4,?000$/);

      const r = await viewer.addTracks(
        [
          { path: fx('small.bam') },
          { path: fx('coverage.bw'), name: 'Coverage' },
          { path: fx('genes.bed') },
          { path: fx('genes.gff3'), name: 'GFF' },
          { path: fx('variants.vcf.gz') },
          { path: fx('noindex.bam'), name: 'NoIndex' },
        ],
        { baseDir: FIXTURES },
      );
      assert.deepEqual(r.warnings, []);
      assert.equal(r.added.length, 6);
      const byName = Object.fromEntries(r.added.map((t) => [t.name, t]));
      assert.ok(byName.small, 'name inferred from file name');
      assert.equal(byName.small!.type, 'alignment');
      assert.equal(byName.small!.indexed, true);
      assert.equal(byName.Coverage!.format, 'bigwig');
      assert.equal(byName.genes!.format, 'bed');
      assert.equal(byName.genes!.indexed, false);
      assert.equal(byName.GFF!.format, 'gff3');
      assert.equal(byName.variants!.indexed, true);
      assert.equal(byName.NoIndex!.indexed, false);
      for (const t of r.added) {
        assert.equal(t.error, null, `${t.name} error`);
        assert.equal(t.inView, true, `${t.name} inView`);
        assert.ok(t.id.startsWith('t'));
      }

      // Oversized unindexed text is refused with a concrete hint; nothing is read.
      const err = await rejection(viewer.addTracks([{ path: fx('unindexed_big.bed') }]));
      assert.equal(err.code, 'INDEX_REQUIRED');
      assert.match((err.data as { hint: string }).hint, /bgzip.*tabix -p bed/);
      assert.equal(viewer.getState().tracks.length, 6);

      // Unsupported and missing files.
      assert.equal((await rejection(viewer.addTracks([{ path: fx('MANIFEST.json') }]))).code, 'UNSUPPORTED_FORMAT');
      assert.equal((await rejection(viewer.addTracks([{ path: fx('nope.bam') }]))).code, 'FILE_NOT_FOUND');

      // Allow-list: the broker knows exactly the files added to this viewer (data + indexes + reference).
      const names = api.broker.listFiles(viewer.id).map((f) => f.name).sort();
      assert.deepEqual(names, ['coverage.bw', 'genes.bed', 'genes.gff3', 'noindex.bam', 'ref.fa', 'ref.fa.fai', 'small.bam', 'small.bam.bai', 'variants.vcf.gz', 'variants.vcf.gz.tbi']);

      // Snapshot has content.
      const snap = await viewer.snapshotSvg();
      assert.ok(snap.svg.startsWith('<svg'));
      assert.ok((snap.svg.match(/<rect\b/g) ?? []).length > 50, 'SVG should contain many rects');
      assert.ok(snap.width > 100 && snap.height > 100);

      // Remove by name releases its files.
      const removed = await viewer.removeTracks({ names: ['Coverage', 'NoIndex'] });
      assert.equal(removed.removed.length, 2);
      assert.equal(viewer.getState().tracks.length, 4);
      assert.ok(!api.broker.listFiles(viewer.id).some((f) => f.name === 'coverage.bw'));
      assert.equal((await rejection(viewer.removeTracks({ names: ['Coverage'] }))).code, 'VIEWER_NOT_FOUND');
    } finally {
      viewer.dispose();
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(api.broker.listFiles(viewer.id), []);
  }));

  test('planted SNP is visible in the snapshot SVG and large.bam reads stay under 3% over 5 navigations', reporting(async () => {
    const api = await getApi();
    const manifest = JSON.parse(readFileSync(fx('MANIFEST.json'), 'utf8')) as { facts: { snp: { alt: string } } };
    const altColor: Record<string, RegExp> = {
      A: /fill="rgb\(\s*0\s*,\s*200\s*,\s*0\s*\)"/g,
      C: /fill="rgb\(\s*0\s*,\s*0\s*,\s*200\s*\)"/g,
      G: /fill="rgb\(\s*209\s*,\s*113\s*,\s*5\s*\)"/g,
      T: /fill="rgb\(\s*255\s*,\s*0\s*,\s*0\s*\)"/g,
    };
    const genome = api.genomes.fromLocalFile(fx('ref.fa'));
    const viewer = await api.viewers.open({ genome, opener: 'agent', locus: 'chrS:999,950-1,000,050', name: 'snp' });
    try {
      const r = await viewer.addTracks([{ path: fx('large.bam') }, { path: fx('variants.vcf.gz') }]);
      assert.deepEqual(r.warnings, []);
      assert.ok(await viewer.settle({ timeoutMs: 20_000 }), 'viewer should settle');
      const snap = await viewer.snapshotSvg();
      const hits = (snap.svg.match(altColor[manifest.facts.snp.alt]!) ?? []).length;
      assert.ok(hits >= 5, `expected ≥5 mismatch marks for alt ${manifest.facts.snp.alt}, got ${hits}`);

      const size = statSync(fx('large.bam')).size;
      const bamMetrics = () => viewer.getState(true).metrics!.files.find((f) => f.displayPath.endsWith('large.bam'))!;
      const before = bamMetrics().bytesRead;
      for (const locus of ['chrS:2,000,000-2,002,000', 'chrS:3,500,000-3,502,000', 'chrS:100,000-102,000', 'chrS:4,900,000-4,902,000', 'chrS:999,900-1,000,100']) {
        await viewer.goto(locus);
        assert.ok(await viewer.settle({ timeoutMs: 20_000 }));
      }
      const after = bamMetrics();
      const navPct = (100 * (after.bytesRead - before)) / size;
      const m = viewer.getState(true).metrics!;
      console.log(`[M1 perf] large.bam: ${after.requests} requests, ${after.bytesRead} bytes total (${((100 * after.bytesRead) / size).toFixed(2)}%), 5 navigations ${navPct.toFixed(2)}%; p50 ${m.p50LatencyMs} ms, p95 ${m.p95LatencyMs} ms over ${m.requests} reads`);
      assert.ok(navPct < 3, `5 navigations read ${navPct.toFixed(2)}% of large.bam`);

      // Wide view: alignment track reports inView=false with a reason, variant track stays in view.
      await viewer.goto('chrS:1-200,000');
      assert.ok(await viewer.settle({ timeoutMs: 20_000 }));
      const tracks = viewer.getState().tracks;
      const bam = tracks.find((t) => t.format === 'bam')!;
      assert.equal(bam.inView, false);
      assert.equal(bam.inViewReason, 'outsideVisibilityWindow');
      assert.equal(tracks.find((t) => t.format === 'vcf')!.inView, true);
    } finally {
      viewer.dispose();
    }
  }));

  test('commands: Add to Viewer with Explorer URIs, Go to Locus with an argument, Set Genome keeps tracks', reporting(async () => {
    const api = await getApi();
    const genome = api.genomes.fromLocalFile(fx('ref.fa'));
    const viewer = await api.viewers.open({ genome, opener: 'human', locus: 'chrT:1-5,000', name: 'cmds' });
    try {
      const uris = [vscode.Uri.file(fx('small.bam')), vscode.Uri.file(fx('genes.bed'))];
      await vscode.commands.executeCommand('igv.addToViewer', uris[0], uris);
      assert.deepEqual(viewer.getState().tracks.map((t) => t.name), ['small', 'genes']);
      await vscode.commands.executeCommand('igv.gotoLocus', 'chrT:10,001-12,000');
      assert.match(viewer.getState().loci[0]!, /^chrT:10,?001-12,?000$/);

      const result = await viewer.setGenome(api.genomes.fromLocalFile(fx('ref.fa')), 'chrT:1-2,000', { keepTracks: true });
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(result.tracks.map((t) => t.name), ['small', 'genes']);
      assert.equal(api.viewers.resolve('cmds').id, viewer.id);
    } finally {
      viewer.dispose();
    }
  }));

  test('genome mismatch is reported when a track uses sequence names the genome lacks', reporting(async () => {
    const api = await getApi();
    const viewer = await api.viewers.open({ genome: api.genomes.resolve('sacCer3'), opener: 'agent', locus: 'chrI:1-10000', name: 'mismatch' });
    try {
      const r = await viewer.addTracks([{ path: fx('small.bam') }, { path: fx('coverage.bw') }]);
      assert.equal(r.mismatches.length, 2);
      assert.deepEqual(r.mismatches.map((m) => m.fileNames), [['chrS', 'chrT'], ['chrS', 'chrT']]);
      assert.ok(r.warnings.some((w) => w.startsWith('GENOME_MISMATCH:') && w.includes('small')), JSON.stringify(r.warnings));
      for (const t of r.added) {
        assert.equal(t.inView, false);
        assert.equal(t.inViewReason, 'genomeMismatch');
      }
      // Switching to the right genome with keepTracks clears the mismatch.
      const fixed = await viewer.setGenome(api.genomes.fromLocalFile(fx('ref.fa')), 'chrT:1-5000', { keepTracks: true });
      assert.equal(fixed.mismatches.length, 0);
      assert.ok(fixed.tracks.every((t) => t.inView && t.inViewReason === undefined), JSON.stringify(fixed.tracks));
    } finally {
      viewer.dispose();
    }
  }));

  test('custom genomes from settings resolve with local paths and configured tracks', reporting(async () => {
    const api = await getApi();
    api.genomes.setCustomGenomes([{ id: 'fixture', name: 'Fixture genome', fastaPath: 'ref.fa', tracks: [{ path: 'genes.bed', name: 'Genes' }] }], FIXTURES);
    try {
      const g = api.genomes.resolve('fixture');
      assert.equal(g.source, 'custom');
      const viewer = await api.viewers.open({ genome: g, opener: 'agent', locus: 'chrT:1-5000' });
      try {
        const r = await viewer.addTracks(api.genomes.tracksFor('fixture'));
        assert.deepEqual(r.added.map((t) => [t.name, t.error]), [['Genes', null]]);
      } finally {
        viewer.dispose();
      }
    } finally {
      api.genomes.setCustomGenomes([], FIXTURES);
    }
  }));
});
