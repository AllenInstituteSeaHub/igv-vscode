/**
 * M4 acceptance: every CLI command against a live instance, through the
 * generated launcher (so the Electron-as-Node path is exercised) and via
 * environment discovery and the registry.
 */
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { IgvExtensionApi } from '../../src/extension';

const EXTENSION_ID = 'alleninstituteseahub.igv-vscode';
const FIXTURES = resolve(__dirname, '../../test/fixtures/generated');
const fx = (n: string) => join(FIXTURES, n);

async function getApi(): Promise<IgvExtensionApi> {
  const ext = vscode.extensions.getExtension<IgvExtensionApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

function runCli(launcher: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<CliResult> {
  return new Promise((resolveRun) => {
    execFile(launcher, [...args, '--json'], { env, cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : err ? 1 : 0;
      let json: unknown;
      try {
        json = JSON.parse(stdout || stderr);
      } catch {
        json = undefined;
      }
      resolveRun({ code, stdout, stderr, json });
    });
  });
}

suite('M4 CLI over the control channel', function () {
  let api: IgvExtensionApi;
  let launcher: string;
  let env: NodeJS.ProcessEnv;
  let work: string;

  suiteSetup(async function () {
    if (!existsSync(fx('small.bam'))) this.skip();
    api = await getApi();
    for (let i = 0; i < 50 && !api.agent.enabled; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(api.agent.enabled, 'agent control channel should be listening in the test host');
    launcher = api.agent.launcherPaths!.posix;
    assert.ok(existsSync(launcher), `launcher exists at ${launcher}`);
    env = { ...process.env, IGV_VSCODE_ENDPOINT: api.agent.endpoint!, IGV_VSCODE_TOKEN: api.agent.token! };
    // Never let a stray system node matter: the launcher bakes in process.execPath.
    work = mkdtempSync(join(tmpdir(), 'igv-cli-it-'));
  });
  suiteTeardown(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });
  setup(() => {
    for (const v of api.viewers.list()) api.viewers.resolve(v.id).dispose();
  });

  test('launcher runs dist/cli.js with the extension host runtime; ping reports the host', async () => {
    assert.match(readFileSync(launcher, 'utf8'), /ELECTRON_RUN_AS_NODE=1 exec '.*' '.*dist\/cli\.js' "\$@"/);
    const r = await runCli(launcher, ['ping'], env, FIXTURES);
    assert.equal(r.code, 0, r.stderr);
    assert.match((r.json as { version: string }).version, /^\d+\.\d+\.\d+/);
    assert.equal((r.json as { igvVersion: string }).igvVersion, '3.8.9');
    assert.equal((r.json as { host: string }).host, 'desktop');
    assert.equal((r.json as { source: string }).source, 'env');
    const v = await runCli(launcher, ['--version'], env, FIXTURES);
    assert.equal(v.code, 0);
    const h = await runCli(launcher, ['--help'], env, FIXTURES);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /Usage: igv-vscode/);
  });

  test('open → state → goto → add → update → remove → snapshot → session save/load → set-genome → list → close', async () => {
    const open = await runCli(launcher, ['open', '--genome', fx('ref.fa'), '--locus', 'chrT:1,001-3,000', '--name', 'cli', '--track-opt', 'small.color=#cc0000', 'small.bam', 'genes.bed'], env, FIXTURES);
    assert.equal(open.code, 0, open.stderr);
    const state0 = open.json as { id: string; name: string; genome: { id: string }; loci: string[]; tracks: { name: string; inView: boolean; error: null }[]; settled: boolean; warnings: string[] };
    assert.equal(state0.name, 'cli');
    assert.equal(state0.genome.id, 'ref');
    assert.match(state0.loci[0]!, /^chrT:1,001-3,000$/);
    assert.deepEqual(state0.tracks.map((t) => [t.name, t.inView, t.error]), [['small', true, null], ['genes', true, null]]);
    assert.equal(state0.settled, true);
    assert.deepEqual(state0.warnings, []);
    assert.equal(api.viewers.list().length, 1, 'viewer opened via CLI is visible to the extension');

    const st = await runCli(launcher, ['state', '--verbose'], env, FIXTURES);
    assert.equal(st.code, 0, st.stderr);
    const verbose = st.json as { metrics: { requests: number; files: unknown[] } };
    assert.ok(verbose.metrics.requests > 0);
    assert.ok(verbose.metrics.files.length >= 4);

    const go = await runCli(launcher, ['goto', 'chrT:10,001-12,000'], env, FIXTURES);
    assert.equal(go.code, 0, go.stderr);
    assert.match((go.json as { loci: string[] }).loci[0]!, /^chrT:10,001-12,000$/);
    const multi = await runCli(launcher, ['goto', 'chrT:1-2,000', 'chrT:40,001-42,000'], env, FIXTURES);
    assert.equal((multi.json as { loci: string[] }).loci.length, 2);

    const add = await runCli(launcher, ['add', 'coverage.bw', 'variants.vcf.gz', '--track-opt', 'coverage.height=80'], env, FIXTURES);
    assert.equal(add.code, 0, add.stderr);
    const added = add.json as { added: { name: string; format: string }[]; settled: boolean };
    assert.deepEqual(added.added.map((t) => [t.name, t.format]), [['coverage', 'bigwig'], ['variants', 'vcf']]);

    const upd = await runCli(launcher, ['update', 'small', 'color=#0000cc', 'height=120', 'displayMode=SQUISHED'], env, FIXTURES);
    assert.equal(upd.code, 0, upd.stderr);
    assert.equal((upd.json as { name: string }).name, 'small');
    const badUpd = await runCli(launcher, ['update', 'small', 'bogus=1'], env, FIXTURES);
    assert.equal(badUpd.code, 2);
    assert.match((badUpd.json as { error: { message: string } }).error.message, /Unknown track option/);

    const rm = await runCli(launcher, ['remove', 'variants'], env, FIXTURES);
    assert.equal(rm.code, 0, rm.stderr);
    assert.equal((rm.json as { removed: string[] }).removed.length, 1);
    const rmMissing = await runCli(launcher, ['remove', 'nothing-here'], env, FIXTURES);
    assert.equal(rmMissing.code, 2);
    assert.equal((rmMissing.json as { error: { code: string } }).error.code, 'VIEWER_NOT_FOUND');

    const png = await runCli(launcher, ['snapshot', '--out', join(work, 'view.png')], env, FIXTURES);
    assert.equal(png.code, 0, png.stderr);
    const pngJson = png.json as { path: string; format: string; width: number; height: number; locus: string[] };
    assert.equal(pngJson.format, 'png');
    assert.deepEqual([...readFileSync(pngJson.path).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(pngJson.width > 200 && pngJson.height > 100);
    const svg = await runCli(launcher, ['snapshot', '--format', 'svg', '--inline'], env, FIXTURES);
    assert.equal(svg.code, 0, svg.stderr);
    const svgJson = svg.json as { path: string; base64: string };
    assert.ok(svgJson.path.includes('.igv/snapshots') || svgJson.path.includes('snapshots'), svgJson.path);
    assert.ok(Buffer.from(svgJson.base64, 'base64').toString('utf8').startsWith('<svg'));
    rmSync(svgJson.path, { force: true });

    const save = await runCli(launcher, ['session', 'save', join(work, 'cli.igv.json')], env, FIXTURES);
    assert.equal(save.code, 0, save.stderr);
    const session = JSON.parse(readFileSync(join(work, 'cli.igv.json'), 'utf8'));
    assert.equal(session.tracks.length, 3);
    assert.equal(session.tracks[0].color, '#0000cc');
    assert.equal(session.tracks[0].displayMode, 'SQUISHED');

    const close = await runCli(launcher, ['close'], env, FIXTURES);
    assert.equal(close.code, 0, close.stderr);
    assert.equal(api.viewers.list().length, 0);

    const load = await runCli(launcher, ['session', 'load', join(work, 'cli.igv.json')], env, FIXTURES);
    assert.equal(load.code, 0, load.stderr);
    const loaded = load.json as { name: string; tracks: { name: string }[]; loci: string[] };
    assert.equal(loaded.name, 'cli');
    assert.deepEqual(loaded.tracks.map((t) => t.name), ['small', 'genes', 'coverage']);
    assert.equal(loaded.loci.length, 2);

    const sg = await runCli(launcher, ['set-genome', 'sacCer3'], env, FIXTURES);
    assert.equal(sg.code, 0, sg.stderr);
    assert.equal((sg.json as { genome: { id: string } }).genome.id, 'sacCer3');
    assert.equal((sg.json as { tracks: unknown[] }).tracks.length, 0, 'tracks cleared without --keep-tracks');

    const list = await runCli(launcher, ['list'], env, FIXTURES);
    assert.equal((list.json as unknown[]).length, 1);
    const genomes = await runCli(launcher, ['genomes', 'cer'], env, FIXTURES);
    assert.ok((genomes.json as { id: string }[]).some((g) => g.id === 'sacCer3'));
    const closeAll = await runCli(launcher, ['close', '--all'], env, FIXTURES);
    assert.equal((closeAll.json as { closed: string[] }).closed.length, 1);
  });

  test('error codes: no viewer, unknown viewer, missing file, large unindexed file, timeout exit code', async () => {
    const noViewer = await runCli(launcher, ['state'], env, FIXTURES);
    assert.equal(noViewer.code, 2);
    assert.equal((noViewer.json as { error: { code: string } }).error.code, 'NO_VIEWER');
    const open = await runCli(launcher, ['open', '--genome', fx('ref.fa'), '--new'], env, FIXTURES);
    assert.equal(open.code, 0, open.stderr);
    const unknown = await runCli(launcher, ['state', '--viewer', 'v999'], env, FIXTURES);
    assert.equal((unknown.json as { error: { code: string } }).error.code, 'VIEWER_NOT_FOUND');
    const missing = await runCli(launcher, ['add', 'does-not-exist.bam'], env, FIXTURES);
    assert.equal(missing.code, 2);
    assert.equal((missing.json as { error: { code: string } }).error.code, 'FILE_NOT_FOUND');
    // Use a fresh copy: a human run may have left unindexed_big.bed.gz(.tbi) next to the fixture, which the policy would reuse.
    const bigCopy = join(work, 'big_unindexed.bed');
    copyFileSync(fx('unindexed_big.bed'), bigCopy);
    const big = await runCli(launcher, ['add', bigCopy], env, FIXTURES);
    assert.equal((big.json as { error: { code: string; hint: string } }).error.code, 'INDEX_REQUIRED');
    assert.match((big.json as { error: { hint: string } }).error.hint, /bgzip/);
    const badToken = await runCli(launcher, ['ping'], { ...env, IGV_VSCODE_TOKEN: 'nope' }, FIXTURES);
    assert.equal(badToken.code, 3, badToken.stderr);
    await runCli(launcher, ['close', '--all'], env, FIXTURES);
  });

  test('discovery through the instance registry (no env vars) picks this window by cwd', async () => {
    const r = await runCli(launcher, ['ping'], { ...process.env, IGV_VSCODE_ENDPOINT: undefined, IGV_VSCODE_TOKEN: undefined }, vscode.workspace.workspaceFolders![0]!.uri.fsPath);
    assert.equal(r.code, 0, r.stderr);
    const j = r.json as { source: string; instance: string; endpoint: string };
    assert.equal(j.source, 'registry');
    assert.equal(j.instance, api.agent.instanceId);
    assert.equal(j.endpoint, api.agent.endpoint);
    assert.equal(statSync(api.agent.endpoint!).mode & 0o777, 0o600);
  });
});
