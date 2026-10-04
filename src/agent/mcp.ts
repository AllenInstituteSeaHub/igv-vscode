/**
 * MCP stdio server (spec §6.5): a thin wrapper over the control-channel
 * client. `igv_snapshot` returns the PNG as image content so the agent can
 * look at the view. Started as `igv-vscode mcp`.
 */
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CliError, ControlClient, EXIT_NO_INSTANCE, EXIT_OK, discover, type EndpointInfo } from './client';
import type { ViewerSnapshotResult } from './protocol';

export interface McpOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  instance?: string;
}

const COORDS = 'Coordinates are 1-based, inclusive, as IGV displays them (commas allowed), e.g. "chr8:127,736,588-127,739,371".';
const NO_INSTANCE_HINT = 'VS Code with the IGV Viewer extension must be open (and not in Restricted Mode, igv.agent.enabled true). From a VS Code terminal the connection is automatic; elsewhere the server looks in ~/.igv-vscode/instances/.';

const trackSpecSchema = z
  .object({
    path: z.string().optional().describe('Local file path (relative to the working directory or absolute)'),
    url: z.string().optional().describe('http(s) URL instead of a path'),
    index: z.string().optional().describe('Explicit index file or URL (.bai, .tbi, .crai, …)'),
    name: z.string().optional().describe('Track name shown in the viewer'),
    type: z.string().optional().describe('igv track type, inferred from the extension when omitted'),
    format: z.string().optional().describe('igv format, inferred when omitted'),
    options: z.record(z.unknown()).optional().describe('igv track options, e.g. {"color":"#cc0000","height":300,"displayMode":"SQUISHED","visibilityWindow":100000}'),
    autoIndex: z.boolean().optional().describe('Run samtools/tabix when a large file has no index'),
    subsample: z.object({ fraction: z.number().optional(), reads: z.number().optional(), seed: z.number().optional(), region: z.string().optional() }).optional().describe('Create and load a subsampled BAM instead'),
    loadAnyway: z.boolean().optional().describe('Load a large unindexed file whole anyway'),
  })
  .describe('A track: {"path": "tumor.bam"} or {"url": "https://…"} plus options');

const viewerArg = z.string().optional().describe('Viewer id (v1, v2, …) or name; default: the active viewer');
const locusArg = z.union([z.string(), z.array(z.string())]).describe(`Locus string, gene name, or several loci for a multi-locus view. ${COORDS}`);

export interface McpDeps {
  /** Resolve the control endpoint (lazily, on first tool call). */
  endpoint: () => Promise<EndpointInfo>;
  cwd: string;
  readFile?: (path: string) => Promise<Buffer>;
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'igv-vscode', version: '1' }, { instructions: `Control the IGV genome viewer running inside VS Code. Open files with igv_open, navigate with igv_goto, then call igv_snapshot and look at the image. ${COORDS} Check igv_state: a track with inView=false and inViewReason=outsideVisibilityWindow needs a narrower locus; genomeMismatch means the wrong genome. In snapshots igv colours bases A green, C blue, G orange, T red; coloured columns in reads are mismatches, grey means match.` });
  let client: ControlClient | undefined;
  const call = async <T,>(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<T> => {
    if (!client) {
      let ep: EndpointInfo;
      try {
        ep = await deps.endpoint();
      } catch (err) {
        throw new CliError(`${(err as Error).message} ${NO_INSTANCE_HINT}`, EXIT_NO_INSTANCE);
      }
      client = new ControlClient(ep, { timeoutMs });
    }
    try {
      return await client.request<T>(method, { ...params, cwd: deps.cwd }, timeoutMs);
    } catch (err) {
      if (err instanceof CliError && err.exitCode === EXIT_NO_INSTANCE) {
        client.close();
        client = undefined;
        throw new CliError(`${err.message} ${NO_INSTANCE_HINT}`, EXIT_NO_INSTANCE, err.data);
      }
      throw err;
    }
  };
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  const failure = (err: unknown) => {
    const e = err instanceof CliError ? err : new CliError(err instanceof Error ? err.message : String(err), 2);
    const body = { error: { code: e.data?.code ?? (e.exitCode === EXIT_NO_INSTANCE ? 'AGENT_DISABLED' : 'INTERNAL'), message: e.message, hint: e.data?.hint } };
    return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }], isError: true };
  };
  const wrap = <A,>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return text(await fn(args));
    } catch (err) {
      return failure(err);
    }
  };

  server.registerTool(
    'igv_open',
    {
      title: 'Open an IGV viewer',
      description: `Open a genome viewer beside the editor, optionally loading tracks and navigating to a locus. Returns the viewer state (id, genome, loci, tracks with inView flags) once rendering settled. ${COORDS} Example: {"genome":"hg38","locus":"chr17:7,668,402-7,687,550","tracks":[{"path":"tumor.bam"},{"path":"normal.bam"}]}`,
      inputSchema: {
        genome: z.string().optional().describe('Genome id (hg38, mm10, …) or a local FASTA/2bit path; default: igv.defaultGenome'),
        locus: locusArg.optional(),
        tracks: z.array(trackSpecSchema).optional(),
        name: z.string().optional().describe('Viewer name to refer to it later'),
        reuse: z.enum(['new', 'active', 'byName']).optional().describe('new (default): open another viewer; active: reuse the active one; byName: reuse the viewer with this name if it exists'),
        waitForRender: z.boolean().optional().describe('Wait until igv has finished loading (default true)'),
        timeoutMs: z.number().optional(),
      },
    },
    wrap((a) => call('viewer.open', a as Record<string, unknown>)),
  );
  server.registerTool(
    'igv_goto',
    { title: 'Navigate', description: `Navigate the viewer to a locus or gene. ${COORDS} Example: {"locus":"chr8:127,740,000-127,745,000"} or {"locus":"TP53"} or {"locus":["chr1:1-10,000","chr2:1-10,000"]}`, inputSchema: { locus: locusArg, viewer: viewerArg, waitForRender: z.boolean().optional() } },
    wrap((a) => call('viewer.goto', a as Record<string, unknown>)),
  );
  server.registerTool(
    'igv_add_tracks',
    { title: 'Add tracks', description: `Add data files or URLs to a viewer. Example: {"tracks":[{"path":"peaks.bed"},{"url":"https://host/cov.bw","name":"Coverage"}]}. Large unindexed files return INDEX_REQUIRED with the fixing command; pass "autoIndex": true to run it.`, inputSchema: { tracks: z.array(trackSpecSchema).min(1), viewer: viewerArg, waitForRender: z.boolean().optional() } },
    wrap((a) => call('tracks.add', a as Record<string, unknown>)),
  );
  server.registerTool(
    'igv_remove_tracks',
    { title: 'Remove tracks', description: 'Remove tracks by name or id. Example: {"names":["Tumor"]}', inputSchema: { names: z.array(z.string()).optional(), ids: z.array(z.string()).optional(), viewer: viewerArg } },
    wrap((a) => call('tracks.remove', a as Record<string, unknown>)),
  );
  server.registerTool(
    'igv_state',
    { title: 'Viewer state', description: `Current genome, loci and tracks of a viewer. Tracks report inView and inViewReason ("outsideVisibilityWindow": zoom in; "genomeMismatch": wrong genome). ${COORDS} Example: {"verbose":true} adds read metrics.`, inputSchema: { viewer: viewerArg, verbose: z.boolean().optional() } },
    wrap((a) => call('viewer.state', a as Record<string, unknown>)),
  );
  server.registerTool('igv_list_viewers', { title: 'List viewers', description: 'List open viewers with id, name, genome, loci and track count. Example: {}', inputSchema: {} }, wrap(() => call('viewer.list', {})));
  server.registerTool(
    'igv_snapshot',
    {
      title: 'Snapshot',
      description: `Render the current view to PNG (default) or SVG and return the image so you can look at it, plus the saved path and locus. ${COORDS} Example: {"viewer":"v1"} or {"format":"svg","out":"view.svg"}`,
      inputSchema: { viewer: viewerArg, format: z.enum(['png', 'svg']).optional(), out: z.string().optional().describe('Output path; default <workspace>/.igv/snapshots/<viewer>-<timestamp>.png'), scale: z.number().optional().describe('PNG scale factor, default 2') },
    },
    async (a) => {
      try {
        const r = await call<ViewerSnapshotResult>('viewer.snapshot', { ...(a as Record<string, unknown>), inline: true });
        const summary = `Snapshot saved to ${r.path} (${r.width}×${r.height}); locus ${r.locus.join('  ')}`;
        if (r.format === 'png' && r.base64) {
          return { content: [{ type: 'image' as const, data: r.base64, mimeType: 'image/png' }, { type: 'text' as const, text: summary }] };
        }
        const svg = r.base64 ? Buffer.from(r.base64, 'base64').toString('utf8') : await (deps.readFile ?? fs.readFile)(r.path).then((b) => b.toString('utf8'));
        return { content: [{ type: 'text' as const, text: `${summary}\n${svg.length > 20000 ? `${svg.slice(0, 20000)}…(truncated, full SVG at ${r.path})` : svg}` }] };
      } catch (err) {
        return failure(err);
      }
    },
  );
  server.registerTool(
    'igv_save_session',
    { title: 'Save session', description: 'Save the viewer as an .igv.json session file with paths relative to the file. Example: {"path":"analysis.igv.json"}', inputSchema: { path: z.string(), viewer: viewerArg, relativePaths: z.boolean().optional() } },
    wrap((a) => call('session.save', a as Record<string, unknown>)),
  );
  server.registerTool(
    'igv_load_session',
    { title: 'Load session', description: 'Load an .igv.json (or igv.js) session into a viewer. Example: {"path":"analysis.igv.json"}', inputSchema: { path: z.string(), viewer: viewerArg, reuse: z.enum(['new', 'active', 'byName']).optional() } },
    wrap((a) => call('session.load', a as Record<string, unknown>)),
  );
  server.registerTool('igv_close', { title: 'Close viewer', description: 'Close a viewer, or all viewers. Example: {"all":true}', inputSchema: { viewer: viewerArg, all: z.boolean().optional() } }, wrap((a) => call('viewer.close', a as Record<string, unknown>)));
  server.registerTool('igv_list_genomes', { title: 'List genomes', description: 'List known genome ids and names, optionally filtered. Example: {"filter":"mouse"}', inputSchema: { filter: z.string().optional() } }, wrap((a) => call('genomes.list', a as Record<string, unknown>)));
  server.server.onclose = () => client?.close();
  return server;
}

/** `igv-vscode mcp`: serve over stdio until the client disconnects. */
export async function runMcpServer(options: McpOptions, transport?: Transport): Promise<number> {
  const server = createMcpServer({
    endpoint: () => discover({ cwd: options.cwd, env: options.env, instance: options.instance, verify: true }),
    cwd: options.cwd,
  });
  const t = transport ?? new StdioServerTransport();
  await server.connect(t);
  await new Promise<void>((resolve) => {
    t.onclose = () => resolve();
  });
  return EXIT_OK;
}
