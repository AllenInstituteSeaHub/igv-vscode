#!/usr/bin/env node
/**
 * `igv-vscode` CLI (spec §6.4): talks to the running extension over the
 * local control channel. Human-readable output by default, `--json` (or a
 * non-TTY stdout) for machines. Exit codes: 0 ok, 1 usage, 2 operation
 * error, 3 no reachable instance / agent API disabled, 4 timeout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, ControlClient, EXIT_NO_INSTANCE, EXIT_OK, EXIT_OPERATION, EXIT_TIMEOUT, EXIT_USAGE, discover } from './client';
import type { TrackSpec, ViewerOpenResult, ViewerSnapshotResult, ViewerState, ViewerSummary, GenomesListResult, PingResult, TracksAddResult, TracksRemoveResult, SessionSaveResult, ViewerCloseResult, TrackState } from './protocol';
import { PROTOCOL_VERSION } from './protocol';

export { EXIT_NO_INSTANCE, EXIT_OK, EXIT_OPERATION, EXIT_TIMEOUT, EXIT_USAGE };

const VERSION = readVersion();

function readVersion(): string {
  try {
    // dist/cli.js lives next to dist/extension.js; package.json one level up.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    // fall through
  }
  return process.env.IGV_VSCODE_VERSION ?? '0.0.0';
}

export const HELP = `igv-vscode ${VERSION} — control the IGV genome viewer running inside VS Code

Usage: igv-vscode <command> [options] [--json] [--viewer V] [--instance ID]

Commands
  open [FILES...]        Open a viewer, optionally with tracks
                         --genome G   genome id (hg38, mm10, …) or a local FASTA/2bit path
                         --locus L    one or more loci (repeatable), e.g. chr8:127,736,588-127,739,371
                         --name N     viewer name (used as --viewer later)
                         --new | --reuse-active | --reuse-name   (default: --new)
                         --track-opt NAME.key=value   igv option for the track named NAME (repeatable)
                         --index FILE=INDEX           explicit index for FILE (repeatable)
                         --auto-index  run samtools/tabix when a large file has no index
                         --no-wait     return before rendering settles
                         --timeout S   settle timeout in seconds (default 30)
  goto LOCUS [LOCUS...]  Navigate (gene names work too)
  add FILES...           Add tracks (--index FILE=INDEX, --auto-index, --track-opt, --no-wait)
  remove NAME...         Remove tracks by name (or --id t1 ...)
  update NAME key=value… Change track options live (color=#cc0000 height=300 displayMode=SQUISHED)
  state                  Viewer state as JSON (--verbose adds read metrics)
  list                   Open viewers
  snapshot               Save a picture of the view (--format png|svg, --out PATH, --scale N, --inline)
  session save PATH      Save an .igv.json session (--absolute for absolute paths)
  session load PATH      Load a session (into --viewer, or a new viewer)
  set-genome G           Switch the viewer's genome (--keep-tracks)
  close                  Close a viewer (--all)
  genomes [FILTER]       List known genomes
  ping                   Check that a VS Code instance is reachable
  install-skill [DIR]    Copy the Claude Code skill file to DIR/.claude/skills/igv/SKILL.md
  mcp                    Run the MCP stdio server (for Claude Code: claude mcp add igv -- igv-vscode mcp)

Global options
  --viewer V      target viewer id (v1, v2, …) or name; default: the active viewer
  --instance ID   choose a VS Code window when several are open (see igv-vscode ping --json)
  --json          machine-readable output (default when stdout is not a terminal)
  --help, -h      show help;  --version, -v  show version

Coordinates are 1-based, inclusive, as IGV displays them; commas are allowed.
Relative file paths resolve against the current directory. Protocol v${PROTOCOL_VERSION}.
Examples
  igv-vscode open --genome hg38 --locus chr17:7,668,402-7,687,550 tumor.bam normal.bam
  igv-vscode goto TP53
  igv-vscode snapshot --out view.png
  igv-vscode state --json | jq '.tracks[] | {name, inView}'
`;

interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  isTTY: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const defaultIo: Io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  isTTY: process.stdout.isTTY === true,
  cwd: process.cwd(),
  env: process.env,
};

function parseCliArgs(argv: string[]) {
  return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        viewer: { type: 'string' },
        instance: { type: 'string' },
        genome: { type: 'string' },
        locus: { type: 'string', multiple: true },
        name: { type: 'string' },
        new: { type: 'boolean' },
        'reuse-active': { type: 'boolean' },
        'reuse-name': { type: 'boolean' },
        'track-opt': { type: 'string', multiple: true },
        index: { type: 'string', multiple: true },
        id: { type: 'string', multiple: true },
        'auto-index': { type: 'boolean' },
        'no-wait': { type: 'boolean' },
        timeout: { type: 'string' },
        verbose: { type: 'boolean' },
        format: { type: 'string' },
        out: { type: 'string' },
        scale: { type: 'string' },
        inline: { type: 'boolean' },
        absolute: { type: 'boolean' },
        'keep-tracks': { type: 'boolean' },
        all: { type: 'boolean' },
      },
    });
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    io.stderr(`igv-vscode: ${(err as Error).message}\nRun "igv-vscode --help".\n`);
    return EXIT_USAGE;
  }
  const { values: v, positionals } = parsed;
  const json = v.json === true || !io.isTTY;
  if (v.version) {
    io.stdout(`${VERSION}\n`);
    return EXIT_OK;
  }
  const command = positionals[0];
  if (v.help || !command) {
    io.stdout(HELP);
    return v.help ? EXIT_OK : EXIT_USAGE;
  }
  const args = positionals.slice(1);

  if (command === 'mcp') {
    const mcp = await import('./mcp');
    return mcp.runMcpServer({ cwd: io.cwd, env: io.env, instance: v.instance });
  }
  if (command === 'install-skill') {
    return installSkill(args[0] ?? io.cwd, io, json);
  }

  const emit = (result: unknown, human: () => string) => {
    io.stdout(json ? `${JSON.stringify(result, null, 2)}\n` : human());
  };
  const fail = (err: unknown): number => {
    const e = err instanceof CliError ? err : new CliError(err instanceof Error ? err.message : String(err), EXIT_OPERATION);
    const payload = { error: { code: e.data?.code ?? (e.exitCode === EXIT_NO_INSTANCE ? 'AGENT_DISABLED' : e.exitCode === EXIT_TIMEOUT ? 'TIMEOUT' : 'INTERNAL'), message: e.message, hint: e.data?.hint } };
    if (json) io.stderr(`${JSON.stringify(payload)}\n`);
    else io.stderr(`igv-vscode: ${e.message}${e.data?.hint ? `\n  hint: ${e.data.hint}` : ''}\n`);
    return e.exitCode;
  };

  let client: ControlClient | undefined;
  try {
    const endpoint = await discover({ cwd: io.cwd, env: io.env, instance: v.instance, verify: command !== 'ping' });
    const timeoutMs = v.timeout ? Math.max(1, Number(v.timeout)) * 1000 : 30_000;
    if (v.timeout && !Number.isFinite(Number(v.timeout))) throw new CliError(`--timeout must be a number of seconds, got "${v.timeout}"`, EXIT_USAGE);
    client = new ControlClient(endpoint, { timeoutMs: timeoutMs + 15_000 });
    const viewer = v.viewer;
    const wait = v['no-wait'] !== true;
    const specs = () => buildTrackSpecs(args, v['track-opt'] ?? [], v.index ?? [], v['auto-index'] === true);

    switch (command) {
      case 'ping': {
        const r = await client.request<PingResult>('ping', {});
        emit({ ...r, endpoint: endpoint.endpoint, instance: endpoint.id, source: endpoint.source }, () => `igv-vscode ${r.version} · igv.js ${r.igvVersion} · VS Code ${r.vscodeVersion} (${r.host})\nworkspace: ${r.workspaceFolders.join(', ') || '(none)'}\nendpoint: ${endpoint.endpoint}${endpoint.id ? ` (instance ${endpoint.id})` : ''}\n`);
        return EXIT_OK;
      }
      case 'open': {
        const reuse = v['reuse-active'] ? 'active' : v['reuse-name'] ? 'byName' : 'new';
        const r = await client.request<ViewerOpenResult>('viewer.open', { name: v.name, genome: v.genome, locus: v.locus?.length ? (v.locus.length === 1 ? v.locus[0] : v.locus) : undefined, tracks: specs(), reuse, waitForRender: wait, timeoutMs, cwd: io.cwd }, timeoutMs + 60_000);
        emit(r, () => `${describeState(r)}${r.warnings.length ? `warnings:\n  ${r.warnings.join('\n  ')}\n` : ''}${r.settled ? '' : 'note: rendering had not settled before the timeout\n'}`);
        return EXIT_OK;
      }
      case 'goto': {
        if (args.length === 0) throw new CliError('goto needs a locus, e.g. chr1:1,000-2,000 or a gene name', EXIT_USAGE);
        const r = await client.request<ViewerState & { settled: boolean }>('viewer.goto', { viewer, locus: args.length === 1 ? args[0] : args, waitForRender: wait, timeoutMs }, timeoutMs + 15_000);
        emit(r, () => `${r.id} ${r.name}: ${r.loci.join('  ')}\n`);
        return EXIT_OK;
      }
      case 'add': {
        if (args.length === 0) throw new CliError('add needs at least one file or URL', EXIT_USAGE);
        const r = await client.request<TracksAddResult>('tracks.add', { viewer, tracks: specs(), waitForRender: wait, timeoutMs, cwd: io.cwd }, timeoutMs + 60_000);
        emit(r, () => `${r.added.map(describeTrack).join('')}${r.warnings.length ? `warnings:\n  ${r.warnings.join('\n  ')}\n` : ''}`);
        return EXIT_OK;
      }
      case 'remove': {
        if (args.length === 0 && !(v.id?.length)) throw new CliError('remove needs track names (or --id t1 ...)', EXIT_USAGE);
        const r = await client.request<TracksRemoveResult>('tracks.remove', { viewer, names: args.length ? args : undefined, ids: v.id?.length ? v.id : undefined });
        emit(r, () => `removed ${r.removed.join(', ') || 'nothing'}\n`);
        return EXIT_OK;
      }
      case 'update': {
        const [id, ...pairs] = args;
        if (!id || pairs.length === 0) throw new CliError('update needs a track name/id and key=value pairs, e.g. update Tumor color=#cc0000 height=300', EXIT_USAGE);
        const r = await client.request<TrackState>('tracks.update', { viewer, id, options: parsePairs(pairs) });
        emit(r, () => describeTrack(r));
        return EXIT_OK;
      }
      case 'state': {
        const r = await client.request<ViewerState>('viewer.state', { viewer, verbose: v.verbose === true });
        emit(r, () => describeState(r));
        return EXIT_OK;
      }
      case 'list': {
        const r = await client.request<ViewerSummary[]>('viewer.list', {});
        emit(r, () => (r.length ? r.map((s) => `${s.active ? '*' : ' '} ${s.id}  ${s.name}  ${s.genome?.id ?? '-'}  ${s.loci.join(' ') || '-'}  ${s.trackCount} track(s)${s.visible ? '' : '  (hidden)'}\n`).join('') : 'no viewers open\n'));
        return EXIT_OK;
      }
      case 'snapshot': {
        const format = (v.format ?? (v.out?.toLowerCase().endsWith('.svg') ? 'svg' : 'png')) as 'png' | 'svg';
        if (format !== 'png' && format !== 'svg') throw new CliError('--format must be png or svg', EXIT_USAGE);
        const r = await client.request<ViewerSnapshotResult>('viewer.snapshot', { viewer, format, out: v.out, scale: v.scale ? Number(v.scale) : undefined, inline: v.inline === true, cwd: io.cwd }, timeoutMs + 60_000);
        emit(r, () => `${r.path}  (${r.width}×${r.height}, ${r.locus.join(' ')})\n`);
        return EXIT_OK;
      }
      case 'session': {
        const [sub, file] = args;
        if (sub === 'save' && file) {
          const r = await client.request<SessionSaveResult>('session.save', { viewer, path: file, relativePaths: v.absolute !== true, cwd: io.cwd });
          emit(r, () => `saved ${r.path}\n`);
          return EXIT_OK;
        }
        if (sub === 'load' && file) {
          const r = await client.request<ViewerState & { warnings: string[] }>('session.load', { viewer, path: file, cwd: io.cwd }, timeoutMs + 60_000);
          emit(r, () => `${describeState(r)}${r.warnings.length ? `warnings:\n  ${r.warnings.join('\n  ')}\n` : ''}`);
          return EXIT_OK;
        }
        throw new CliError('usage: igv-vscode session save PATH | session load PATH', EXIT_USAGE);
      }
      case 'set-genome': {
        if (!args[0]) throw new CliError('set-genome needs a genome id or FASTA/2bit path', EXIT_USAGE);
        const r = await client.request<ViewerState & { warnings: string[] }>('viewer.setGenome', { viewer, genome: args[0], keepTracks: v['keep-tracks'] === true, cwd: io.cwd }, timeoutMs + 60_000);
        emit(r, () => describeState(r));
        return EXIT_OK;
      }
      case 'close': {
        const r = await client.request<ViewerCloseResult>('viewer.close', { viewer, all: v.all === true });
        emit(r, () => `closed ${r.closed.join(', ') || 'nothing'}\n`);
        return EXIT_OK;
      }
      case 'genomes': {
        const r = await client.request<GenomesListResult>('genomes.list', { filter: args[0] });
        emit(r.genomes, () => r.genomes.map((g) => `${g.id.padEnd(16)} ${g.name}${g.source !== 'bundled-list' ? `  [${g.source}]` : ''}\n`).join('') || 'no genomes match\n');
        return EXIT_OK;
      }
      default:
        io.stderr(`igv-vscode: unknown command "${command}". Run "igv-vscode --help".\n`);
        return EXIT_USAGE;
    }
  } catch (err) {
    return fail(err);
  } finally {
    client?.close();
  }
}

/** Positional FILES plus --index FILE=IDX, --track-opt NAME.key=value, --auto-index → TrackSpec[] (paths kept relative; the server resolves against cwd). */
export function buildTrackSpecs(files: string[], trackOpts: string[], indexes: string[], autoIndex: boolean): TrackSpec[] {
  const indexFor = new Map<string, string>();
  for (const spec of indexes) {
    const eq = spec.indexOf('=');
    if (eq <= 0) throw new CliError(`--index expects FILE=INDEX, got "${spec}"`, EXIT_USAGE);
    indexFor.set(spec.slice(0, eq), spec.slice(eq + 1));
  }
  const optsFor = new Map<string, Record<string, unknown>>();
  for (const o of trackOpts) {
    const m = /^([^.=]+)\.([^=]+)=(.*)$/.exec(o);
    if (!m) throw new CliError(`--track-opt expects NAME.key=value, got "${o}"`, EXIT_USAGE);
    const bag = optsFor.get(m[1]!) ?? {};
    bag[m[2]!] = coerce(m[3]!);
    optsFor.set(m[1]!, bag);
  }
  return files.map((f) => {
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(f);
    const name = displayName(f);
    const spec: TrackSpec = isUrl ? { url: f } : { path: f };
    const idx = indexFor.get(f);
    if (idx) spec.index = idx;
    const opts = optsFor.get(name) ?? optsFor.get(path.basename(f));
    if (opts) spec.options = opts;
    if (autoIndex) spec.autoIndex = true;
    return spec;
  });
}

export function parsePairs(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq <= 0) throw new CliError(`expected key=value, got "${p}"`, EXIT_USAGE);
    out[p.slice(0, eq)] = coerce(p.slice(eq + 1));
  }
  return out;
}

function coerce(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function displayName(f: string): string {
  let n = f.split(/[?#]/)[0]!.split(/[\\/]/).pop() ?? f;
  for (const ext of ['.gz', '.bgz']) if (n.toLowerCase().endsWith(ext)) n = n.slice(0, -ext.length);
  const dot = n.lastIndexOf('.');
  return dot > 0 ? n.slice(0, dot) : n;
}

function describeTrack(t: TrackState): string {
  const flags = [t.indexed ? 'indexed' : 'unindexed', t.inView ? 'in view' : `not in view${t.inViewReason ? ` (${t.inViewReason})` : ''}`];
  return `  ${t.id}  ${t.name}  ${t.type}/${t.format}  ${flags.join(', ')}${t.error ? `  ERROR: ${t.error}` : ''}\n    ${t.displayPath}\n`;
}

function describeState(s: ViewerState): string {
  const lines = [`${s.id} ${s.name}  genome ${s.genome?.id ?? '-'}  locus ${s.loci.join('  ') || '-'}`];
  for (const t of s.tracks) lines.push(describeTrack(t).trimEnd());
  if (s.metrics) lines.push(`reads: ${s.metrics.requests} requests, ${(s.metrics.bytes / 1048576).toFixed(2)} MiB, p50 ${s.metrics.p50LatencyMs} ms, p95 ${s.metrics.p95LatencyMs} ms`);
  return `${lines.join('\n')}\n`;
}

function installSkill(dir: string, io: Io, json: boolean): number {
  const src = path.join(__dirname, '..', 'agent', 'SKILL.md');
  const dest = path.join(path.resolve(io.cwd, dir), '.claude', 'skills', 'igv', 'SKILL.md');
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } catch (err) {
    io.stderr(`igv-vscode: could not install the skill: ${(err as Error).message}\n`);
    return EXIT_OPERATION;
  }
  io.stdout(json ? `${JSON.stringify({ path: dest })}\n` : `installed ${dest}\n`);
  return EXIT_OK;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`igv-vscode: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = EXIT_OPERATION;
    },
  );
}
