/**
 * External tool jobs (spec §5.2): indexing, compress+index and subsampling.
 * Each job streams through child processes, supports cancellation via an
 * AbortSignal, reports progress lines, and logs the exact command.
 * No `vscode` dependency; the extension wraps these with withProgress.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { RpcError } from '../shared/rpc';
import type { ToolInfo } from './ToolDetector';

export interface JobContext {
  log: (line: string) => void;
  progress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface RunOptions {
  cwd?: string;
  /** Pipe stdout to this file. */
  stdoutFile?: string;
  /** Feed this readable as stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Collect stdout as text (small outputs only). */
  captureStdout?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function quoteArg(a: string): string {
  return /^[\w./+=:@%,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map(quoteArg).join(' ');
}

/** Run a command to completion. Rejects with TOOL_MISSING-style errors on spawn failure, INTERNAL on non-zero exit. */
export async function runCommand(cmd: string, args: string[], ctx: JobContext, options: RunOptions = {}): Promise<RunResult> {
  ctx.log(`$ ${formatCommand(cmd, args)}${options.stdoutFile ? ` > ${quoteArg(options.stdoutFile)}` : ''}`);
  if (ctx.signal?.aborted) throw new RpcError('INTERNAL', 'cancelled');
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: options.cwd, stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new RpcError('TOOL_MISSING', `cannot start ${cmd}: ${(err as Error).message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const onAbort = () => {
      ctx.log(`cancelled: ${cmd}`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      fail(new RpcError('INTERNAL', 'cancelled'));
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.stdin) options.stdin.pipe(child.stdin!);
    let outStream: fs.WriteStream | undefined;
    if (options.stdoutFile) {
      outStream = fs.createWriteStream(options.stdoutFile);
      child.stdout!.pipe(outStream);
      outStream.on('error', (e) => fail(new RpcError('INTERNAL', `cannot write ${options.stdoutFile}: ${e.message}`)));
    } else if (options.captureStdout) {
      child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    } else {
      child.stdout!.resume();
    }
    const rl = readline.createInterface({ input: child.stderr! });
    rl.on('line', (line) => {
      stderr += `${line}\n`;
      if (line.trim()) ctx.progress?.(line.trim());
    });
    child.on('error', (err) => fail(new RpcError('TOOL_MISSING', `cannot run ${cmd}: ${err.message}`)));
    child.on('close', (code) => {
      ctx.signal?.removeEventListener('abort', onAbort);
      const finish = () => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve({ code: 0, stdout, stderr });
        else reject(new RpcError('INTERNAL', `${path.basename(cmd)} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
      };
      if (outStream) outStream.end(finish);
      else finish();
    });
  });
}

// ---- jobs --------------------------------------------------------------------

/** `samtools index BAM OUT`. Returns the index path. */
export async function indexBam(samtools: ToolInfo, bamPath: string, outPath: string, ctx: JobContext): Promise<string> {
  ctx.progress?.(`Indexing ${path.basename(bamPath)}…`);
  await runCommand(samtools.path, ['index', bamPath, outPath], ctx);
  return outPath;
}

/** `samtools faidx FASTA` (writes FASTA.fai, and .gzi for bgzipped input). */
export async function indexFasta(samtools: ToolInfo, fastaPath: string, ctx: JobContext): Promise<string> {
  ctx.progress?.(`Indexing ${path.basename(fastaPath)}…`);
  await runCommand(samtools.path, ['faidx', fastaPath], ctx);
  return `${fastaPath}.fai`;
}

export type TabixPreset = 'bed' | 'gff' | 'vcf';

export function tabixPresetFor(format: string): TabixPreset {
  if (format === 'vcf') return 'vcf';
  if (format === 'gff' || format === 'gff3' || format === 'gtf') return 'gff';
  return 'bed';
}

/**
 * Sort, bgzip and tabix-index a text file: '#' header lines are kept first,
 * 'track'/'browser' lines are dropped (tabix cannot skip them and igv does not
 * need them), the body is sorted with `sort -k1,1 -kN,Nn`, piped into
 * `bgzip -c`, then `tabix -p PRESET` indexes the result. Returns the .gz path.
 */
export async function sortBgzipTabix(
  tools: { sort: ToolInfo; bgzip: ToolInfo; tabix: ToolInfo },
  textPath: string,
  preset: TabixPreset,
  outGzPath: string,
  ctx: JobContext,
): Promise<{ gz: string; index: string }> {
  const tmpDir = await fsp.mkdtemp(path.join(path.dirname(outGzPath), '.igv-sort-'));
  const headerPath = path.join(tmpDir, 'header.txt');
  const bodyPath = path.join(tmpDir, 'body.txt');
  const sortedPath = path.join(tmpDir, 'sorted.txt');
  try {
    ctx.progress?.(`Splitting header of ${path.basename(textPath)}…`);
    await splitHeader(textPath, headerPath, bodyPath, ctx.signal);
    const posCol = preset === 'gff' ? '4,4n' : '2,2n';
    ctx.progress?.(`Sorting ${path.basename(textPath)}…`);
    await runCommand(tools.sort.path, ['-k1,1', `-k${posCol}`, bodyPath], ctx, { stdoutFile: sortedPath, cwd: tmpDir });
    ctx.progress?.(`Compressing with bgzip…`);
    const concat = concatStreams([headerPath, sortedPath]);
    await runCommand(tools.bgzip.path, ['-c'], ctx, { stdin: concat, stdoutFile: outGzPath });
    ctx.progress?.(`Indexing with tabix…`);
    await runCommand(tools.tabix.path, ['-f', '-p', preset, outGzPath], ctx);
    return { gz: outGzPath, index: `${outGzPath}.tbi` };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

async function splitHeader(src: string, headerOut: string, bodyOut: string, signal?: AbortSignal): Promise<void> {
  const header = fs.createWriteStream(headerOut);
  const body = fs.createWriteStream(bodyOut);
  const rl = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity });
  let inHeader = true;
  for await (const line of rl) {
    if (signal?.aborted) throw new RpcError('INTERNAL', 'cancelled');
    if (inHeader && line.startsWith('#')) {
      if (!header.write(`${line}\n`)) await new Promise<void>((r) => header.once('drain', () => r()));
      continue;
    }
    if (line.startsWith('track ') || line.startsWith('browser ') || line === 'track' || line === 'browser') continue;
    inHeader = false;
    if (!line.trim()) continue;
    if (!body.write(`${line}\n`)) await new Promise<void>((r) => body.once('drain', () => r()));
  }
  await Promise.all([new Promise<void>((r) => header.end(() => r())), new Promise<void>((r) => body.end(() => r()))]);
}

function concatStreams(files: string[]): NodeJS.ReadableStream {
  const out = new PassThrough();
  (async () => {
    for (const f of files) {
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(f);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(out, { end: false });
      });
    }
    out.end();
  })().catch((e) => out.destroy(e));
  return out;
}

export interface SubsampleOptions {
  fraction?: number;
  reads?: number;
  seed?: number;
  region?: string;
}

/** Count reads (`samtools view -c`), used to turn a target read count into a fraction. */
export async function countReads(samtools: ToolInfo, bamPath: string, ctx: JobContext, region?: string): Promise<number> {
  ctx.progress?.(`Counting reads in ${path.basename(bamPath)}…`);
  const args = ['view', '-c', bamPath];
  if (region) args.push(region);
  const r = await runCommand(samtools.path, args, ctx, { captureStdout: true });
  const n = Number(r.stdout.trim());
  if (!Number.isFinite(n)) throw new RpcError('INTERNAL', `could not count reads: ${r.stdout.trim()}`);
  return n;
}

/**
 * `samtools view -b -s SEED.FRAC [-o OUT] BAM [REGION]` followed by `samtools index`.
 * Returns the output BAM, its index and the fraction used.
 */
export async function subsampleBam(samtools: ToolInfo, bamPath: string, options: SubsampleOptions, outPath: string, ctx: JobContext): Promise<{ bam: string; index: string; fraction: number }> {
  let fraction = options.fraction;
  if (fraction === undefined) {
    if (!options.reads || options.reads <= 0) throw new RpcError('INTERNAL', 'subsample needs "fraction" (0-1) or "reads" (> 0)');
    const total = await countReads(samtools, bamPath, ctx, options.region);
    fraction = total > 0 ? Math.min(1, options.reads / total) : 1;
  }
  if (!(fraction > 0 && fraction <= 1)) throw new RpcError('INTERNAL', `subsample fraction must be in (0, 1], got ${fraction}`);
  const seed = Number.isInteger(options.seed) ? (options.seed as number) : 42;
  const fracStr = fraction >= 1 ? '' : fraction.toFixed(6).replace(/^0/, '').replace(/0+$/, '');
  const args = ['view', '-b'];
  if (fracStr) args.push('-s', `${seed}${fracStr}`);
  args.push('-o', outPath, bamPath);
  if (options.region) args.push(options.region);
  ctx.progress?.(`Subsampling ${path.basename(bamPath)} (${(fraction * 100).toFixed(1)}%)…`);
  await runCommand(samtools.path, args, ctx);
  const index = await indexBam(samtools, outPath, `${outPath}.bai`, ctx);
  return { bam: outPath, index, fraction };
}

export function subsampleOutputName(bamPath: string, fraction: number, region?: string): string {
  const base = path.basename(bamPath).replace(/\.bam$/i, '');
  const pct = fraction >= 1 ? '100' : (fraction * 100).toPrecision(2).replace(/\.0$/, '');
  const reg = region ? `.${region.replace(/[^\w.-]+/g, '_')}` : '';
  return `${base}.subsample${pct}pct${reg}.bam`;
}
