import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ControlServer, defaultEndpoint } from '../../src/agent/ControlServer';
import { createMcpServer } from '../../src/agent/mcp';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'igv-mcp-'));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function connected(server: ControlServer) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer({ endpoint: async () => ({ endpoint: server.endpoint, token: server.token, source: 'env' }), cwd: home });
  await mcp.connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  return { client, mcp };
}

describe('MCP server', () => {
  it('exposes the eleven tools with coordinate guidance and examples', async () => {
    const server = new ControlServer({ handler: async () => ({}), log: () => undefined, endpoint: defaultEndpoint('m1', { XDG_RUNTIME_DIR: home }) }, 'm1');
    await server.start();
    try {
      const { client } = await connected(server);
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(['igv_add_tracks', 'igv_close', 'igv_goto', 'igv_list_genomes', 'igv_list_viewers', 'igv_load_session', 'igv_open', 'igv_remove_tracks', 'igv_save_session', 'igv_snapshot', 'igv_state']);
      for (const t of tools) expect(t.description, t.name).toMatch(/Example:/);
      expect(tools.find((t) => t.name === 'igv_goto')!.description).toMatch(/1-based, inclusive/);
      await client.close();
    } finally {
      await server.stop();
    }
  });

  it('forwards calls with cwd, returns JSON text, images for snapshots, and structured errors', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const server = new ControlServer(
      {
        log: () => undefined,
        endpoint: defaultEndpoint('m2', { XDG_RUNTIME_DIR: home }),
        handler: async (method, params) => {
          calls.push({ method, params });
          if (method === 'ping') return {};
          if (method === 'viewer.open') return { id: 'v1', loci: ['chr1:1-100'], tracks: [] };
          if (method === 'viewer.snapshot') return { path: '/tmp/x.png', format: 'png', width: 1, height: 1, locus: ['chr1:1-100'], base64: PNG_1x1 };
          if (method === 'viewer.state') throw Object.assign(new Error('No IGV viewer is open'), { code: 'NO_VIEWER', data: { hint: 'open one' } });
          return {};
        },
      },
      'm2',
    );
    await server.start();
    try {
      const { client } = await connected(server);
      const open = await client.callTool({ name: 'igv_open', arguments: { genome: 'hg38', locus: 'chr1:1-100', tracks: [{ path: 'a.bam', options: { color: '#cc0000' } }] } });
      expect(open.isError).toBeFalsy();
      expect(JSON.parse((open.content as { text: string }[])[0]!.text)).toMatchObject({ id: 'v1' });
      expect(calls.find((c) => c.method === 'viewer.open')!.params).toMatchObject({ genome: 'hg38', cwd: home, tracks: [{ path: 'a.bam' }] });

      const snap = await client.callTool({ name: 'igv_snapshot', arguments: {} });
      const content = snap.content as { type: string; data?: string; mimeType?: string; text?: string }[];
      expect(content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PNG_1x1 });
      expect(content[1]!.text).toMatch(/Snapshot saved to \/tmp\/x\.png .*chr1:1-100/);
      expect(calls.find((c) => c.method === 'viewer.snapshot')!.params).toMatchObject({ inline: true });

      const state = await client.callTool({ name: 'igv_state', arguments: {} });
      expect(state.isError).toBe(true);
      expect(JSON.parse((state.content as { text: string }[])[0]!.text).error.message).toMatch(/No IGV viewer/);
      await client.close();
    } finally {
      await server.stop();
    }
  });

  it('explains clearly when no VS Code instance is reachable', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcp = createMcpServer({ endpoint: async () => { throw new Error('No running VS Code with the IGV extension was found.'); }, cwd: home });
    await mcp.connect(serverT);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientT);
    const r = await client.callTool({ name: 'igv_list_viewers', arguments: {} });
    expect(r.isError).toBe(true);
    const err = JSON.parse((r.content as { text: string }[])[0]!.text).error;
    expect(err.code).toBe('AGENT_DISABLED');
    expect(err.message).toMatch(/VS Code with the IGV Viewer extension must be open/);
    await client.close();
  });
});
