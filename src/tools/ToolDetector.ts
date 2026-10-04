/**
 * Finds external tools (samtools, bgzip, tabix, bedtools, sort) on PATH or at
 * configured paths (spec §3.1, §5.2). No `vscode` dependency.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { RpcError } from '../shared/rpc';

export type ToolName = 'samtools' | 'bgzip' | 'tabix' | 'bedtools' | 'sort';

export interface ToolInfo {
  name: ToolName;
  path: string;
  version: string;
}

export interface ToolDetectorOptions {
  /** `igv.tools.paths` setting: tool name → absolute path. */
  configuredPaths?: () => Record<string, string | undefined>;
  env?: NodeJS.ProcessEnv;
  cacheMs?: number;
}

const INSTALL_HINTS: Record<ToolName, string> = {
  samtools: 'Install samtools (https://www.htslib.org/): e.g. "conda install -c bioconda samtools", "brew install samtools" or "apt install samtools". Or set igv.tools.paths.samtools.',
  bgzip: 'Install htslib (provides bgzip and tabix): e.g. "conda install -c bioconda htslib", "brew install htslib" or "apt install tabix". Or set igv.tools.paths.bgzip.',
  tabix: 'Install htslib (provides bgzip and tabix): e.g. "conda install -c bioconda htslib", "brew install htslib" or "apt install tabix". Or set igv.tools.paths.tabix.',
  bedtools: 'Install bedtools: e.g. "conda install -c bioconda bedtools" or "apt install bedtools". Or set igv.tools.paths.bedtools.',
  sort: 'The "sort" utility was not found on PATH.',
};

export class ToolDetector {
  private readonly cache = new Map<ToolName, { at: number; info: ToolInfo | undefined }>();
  private readonly cacheMs: number;

  constructor(private readonly options: ToolDetectorOptions = {}) {
    this.cacheMs = options.cacheMs ?? 60_000;
  }

  invalidate(): void {
    this.cache.clear();
  }

  async find(name: ToolName): Promise<ToolInfo | undefined> {
    const cached = this.cache.get(name);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.info;
    const info = await this.locate(name);
    this.cache.set(name, { at: Date.now(), info });
    return info;
  }

  /** Like find(), but throws TOOL_MISSING with an install hint. */
  async require(name: ToolName, purpose: string): Promise<ToolInfo> {
    const info = await this.find(name);
    if (!info) {
      throw new RpcError('TOOL_MISSING', `${name} is needed to ${purpose} but was not found`, { hint: INSTALL_HINTS[name], tool: name });
    }
    return info;
  }

  async detectAll(): Promise<Record<ToolName, ToolInfo | undefined>> {
    const names: ToolName[] = ['samtools', 'bgzip', 'tabix', 'bedtools', 'sort'];
    const found = await Promise.all(names.map((n) => this.find(n)));
    return Object.fromEntries(names.map((n, i) => [n, found[i]])) as Record<ToolName, ToolInfo | undefined>;
  }

  private async locate(name: ToolName): Promise<ToolInfo | undefined> {
    const configured = this.options.configuredPaths?.()[name];
    if (configured && configured.trim()) {
      const p = configured.trim();
      if (await isExecutable(p)) return { name, path: p, version: await toolVersion(name, p) };
      return undefined;
    }
    const env = this.options.env ?? process.env;
    const found = await whichOnPath(name, env);
    if (!found) return undefined;
    return { name, path: found, version: await toolVersion(name, found) };
  }
}

export async function isExecutable(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function whichOnPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const pathVar = env.PATH ?? env.Path ?? '';
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** First line of `tool --version` (samtools/bgzip/tabix all support it), or "" when it fails. */
export async function toolVersion(name: ToolName, toolPath: string, timeoutMs = 5000): Promise<string> {
  if (name === 'sort') return '';
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      const child = spawn(toolPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill();
        finish('');
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', () => { clearTimeout(timer); finish(''); });
      child.on('close', () => { clearTimeout(timer); finish(out.split(/\r?\n/)[0]?.trim() ?? ''); });
    } catch {
      finish('');
    }
  });
}
