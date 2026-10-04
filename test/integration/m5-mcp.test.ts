/**
 * M5 acceptance: an MCP client connects over stdio to `igv-vscode mcp`
 * (through the generated launcher), calls every tool and receives a PNG.
 */
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { IgvExtensionApi } from '../../src/extension';

const FIXTURES = resolve(__dirname, '../../test/fixtures/generated');
const fx = (n: string) => join(FIXTURES, n);

async function getApi(): Promise<IgvExtensionApi> {
  const ext = vscode.extensions.getExtension<IgvExtensionApi>('igv-vscode-dev.igv-vscode');
  assert.ok(ext);
  return ext.activate();
}

type Content = { type: string; text?: string; data?: string; mimeType?: string }[];
const textOf = (r: unknown) => JSON.parse((((r as { content?: Content }).content ?? []).find((c) => c.type === 'text')?.text) ?? 'null');

suite('M5 MCP server over stdio', function () {
  let api: IgvExtensionApi;
  let client: Client;
  let work: string;

  suiteSetup(async function () {
    if (!existsSync(fx('small.bam'))) this.skip();
    api = await getApi();
    for (let i = 0; i < 50 && !api.agent.enabled; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(api.agent.enabled);
    for (const v of api.viewers.list()) api.viewers.resolve(v.id).dispose();
    work = mkdtempSync(join(tmpdir(), 'igv-mcp-it-'));
    const launcher = api.agent.launcherPaths!.posix;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.IGV_VSCODE_ENDPOINT = api.agent.endpoint!;
    env.IGV_VSCODE_TOKEN = api.agent.token!;
    client = new Client({ name: 'integration-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: launcher, args: ['mcp'], env, cwd: FIXTURES, stderr: 'pipe' }));
  });
  suiteTeardown(async () => {
    await client?.close().catch(() => undefined);
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test('lists tools and runs the full workflow, receiving a PNG from igv_snapshot', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['igv_add_tracks', 'igv_close', 'igv_goto', 'igv_list_genomes', 'igv_list_viewers', 'igv_load_session', 'igv_open', 'igv_remove_tracks', 'igv_save_session', 'igv_snapshot', 'igv_state']);

    const open = await client.callTool({ name: 'igv_open', arguments: { genome: fx('ref.fa'), locus: 'chrT:1,001-3,000', tracks: [{ path: 'small.bam' }], name: 'mcp' } });
    assert.ok(!open.isError, JSON.stringify(open.content));
    const opened = textOf(open);
    assert.equal(opened.name, 'mcp');
    assert.equal(opened.tracks.length, 1);
    assert.equal(opened.settled, true);
    assert.equal(api.viewers.list().length, 1);

    const added = textOf(await client.callTool({ name: 'igv_add_tracks', arguments: { tracks: [{ path: 'genes.bed' }, { path: 'coverage.bw', name: 'cov', options: { height: 60 } }] } }));
    assert.deepEqual(added.added.map((t: { name: string }) => t.name), ['genes', 'cov']);

    const moved = textOf(await client.callTool({ name: 'igv_goto', arguments: { locus: 'chrT:10,001-12,000' } }));
    assert.match(moved.loci[0], /^chrT:10,001-12,000$/);

    const snap = await client.callTool({ name: 'igv_snapshot', arguments: { out: join(work, 'mcp.png') } });
    assert.ok(!snap.isError, JSON.stringify(snap.content));
    const content = snap.content as Content;
    const image = content.find((c) => c.type === 'image');
    assert.ok(image, 'image content present');
    assert.equal(image!.mimeType, 'image/png');
    const bytes = Buffer.from(image!.data!, 'base64');
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(bytes.length > 10_000);
    assert.match(content.find((c) => c.type === 'text')!.text!, /Snapshot saved to .*mcp\.png .*chrT:10,001-12,000/);
    assert.ok(existsSync(join(work, 'mcp.png')));
    const svg = await client.callTool({ name: 'igv_snapshot', arguments: { format: 'svg', out: join(work, 'mcp.svg') } });
    assert.match((svg.content as Content)[0]!.text!, /<svg/);

    const state = textOf(await client.callTool({ name: 'igv_state', arguments: { verbose: true } }));
    assert.equal(state.tracks.length, 3);
    assert.ok(state.metrics.requests > 0);
    const removed = textOf(await client.callTool({ name: 'igv_remove_tracks', arguments: { names: ['cov'] } }));
    assert.equal(removed.removed.length, 1);
    const saved = textOf(await client.callTool({ name: 'igv_save_session', arguments: { path: join(work, 'mcp.igv.json') } }));
    assert.ok(existsSync(saved.path));
    const list = textOf(await client.callTool({ name: 'igv_list_viewers', arguments: {} }));
    assert.equal(list.length, 1);
    const genomes = textOf(await client.callTool({ name: 'igv_list_genomes', arguments: { filter: 'human' } }));
    assert.ok(genomes.genomes.some((g: { id: string }) => g.id === 'hg38'));
    const closed = textOf(await client.callTool({ name: 'igv_close', arguments: { all: true } }));
    assert.equal(closed.closed.length, 1);
    const loaded = textOf(await client.callTool({ name: 'igv_load_session', arguments: { path: join(work, 'mcp.igv.json') } }));
    assert.deepEqual(loaded.tracks.map((t: { name: string }) => t.name), ['small', 'genes']);
    await client.callTool({ name: 'igv_close', arguments: { all: true } });

    // Errors come back as structured tool errors, not protocol failures.
    const err = await client.callTool({ name: 'igv_state', arguments: {} });
    assert.equal(err.isError, true);
    assert.equal(textOf(err).error.code, 'NO_VIEWER');
  });
});
