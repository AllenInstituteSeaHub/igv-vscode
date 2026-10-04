import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Logger } from './log';
import { GenomeRegistry, parseGenomeList, type GenomeDefaultsStore } from './genome/GenomeRegistry';
import { ViewerManager } from './viewer/ViewerManager';
import type { ViewerController } from './viewer/ViewerController';
import { FileAccessBroker, DEFAULT_MAX_CHUNK_BYTES } from './data/FileAccessBroker';
import { RemoteProxy } from './data/RemoteProxy';
import { ToolDetector } from './tools/ToolDetector';
import { LargeFilePolicy, type PolicyAnswer, type PolicyQuestion } from './tools/LargeFilePolicy';
import type { JobContext } from './tools/jobs';
import type { RemoteMode, TransportMode } from './viewer/ViewerController';
import { AgentService } from './agent/AgentService';
import { createControlApi } from './agent/api';
import type { HostKind } from './agent/protocol';
import { inferFormat } from './data/formats';
import { suggestInitialLocus } from './data/sequenceNames';
import type { ResolverSettings } from './data/TrackResolver';
import { askLocus, chooseGenomeForNewViewer, pickGenome, pickTracks } from './ui/pickers';
import { createStatusBar } from './ui/statusBar';
import { parseLocusFromText } from './ui/locusParser';
import { defaultSnapshotDir, snapshotFileName } from './ui/snapshotDir';
import { SessionService } from './session/SessionService';
import { IgvEditorProvider } from './viewer/IgvEditorProvider';
import { VIEWER_VIEW_TYPE } from './viewer/ViewerManager';
import { RpcError } from './shared/rpc';
import type { ResolvedGenome, TrackSpec } from './agent/protocol';

const RECENT_GENOMES_KEY = 'igv.recentGenomes';

export interface IgvExtensionApi {
  readonly viewers: ViewerManager;
  readonly genomes: GenomeRegistry;
  readonly broker: FileAccessBroker;
  readonly sessions: SessionService;
  readonly tools: ToolDetector;
  readonly policy: LargeFilePolicy;
  readonly proxy: RemoteProxy;
  readonly agent: AgentService;
}

export function activate(context: vscode.ExtensionContext): IgvExtensionApi {
  const log = new Logger('IGV');
  context.subscriptions.push(log);
  log.info(`activating igv-vscode ${context.extension.packageJSON.version} (VS Code ${vscode.version}, ${vscode.env.appHost})`);

  const config = () => vscode.workspace.getConfiguration('igv');
  const workspaceFolders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const baseDir = () => workspaceFolders()[0] ?? process.cwd();

  const genomes = new GenomeRegistry(loadBundledGenomes(context, log), makeGenomeStore(context));
  const loadCustomGenomes = () => {
    genomes.setCustomGenomes(config().get('genomes.custom'), baseDir());
    for (const p of genomes.customProblems) log.warn(p);
  };
  loadCustomGenomes();

  const proxy = new RemoteProxy({ timeoutMs: config().get<number>('remote.timeoutMs', 30_000) });
  const broker = new FileAccessBroker({ maxChunkBytes: config().get<number>('transport.maxChunkBytes', DEFAULT_MAX_CHUNK_BYTES), proxy });
  context.subscriptions.push({ dispose: () => void broker.dispose() });
  const proxiedOrigins = new Set<string>();

  const tools = new ToolDetector({
    configuredPaths: () => {
      const raw = config().get<Record<string, string>>('tools.paths', {});
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v.replace(/\$\{workspaceFolder\}/g, baseDir());
      return out;
    },
  });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('igv.tools.paths')) tools.invalidate(); }));
  const derivedDir = () => {
    const configured = config().get<string>('largeFile.derivedDir', '').trim();
    if (configured) return path.isAbsolute(configured) ? configured : path.join(baseDir(), configured);
    return path.join(context.globalStorageUri.fsPath, 'derived');
  };

  const resolverSettings = (): Partial<ResolverSettings> => ({
    unindexedMaxBytes: config().get<number>('largeFile.unindexedMaxBytes'),
    alignmentVisibilityWindow: config().get<number>('alignment.visibilityWindow'),
    alignmentSamplingDepth: config().get<number>('alignment.samplingDepth'),
    alignmentSamplingWindowSize: config().get<number>('alignment.samplingWindowSize'),
    variantVisibilityWindow: config().get<number>('variant.visibilityWindow'),
  });

  const viewers = new ViewerManager(context.extensionUri, log, {
    broker,
    genomeList: () => genomes.igvGenomeList(),
    resolverSettings,
    workspaceFolders,
    remote: () => ({ mode: config().get<RemoteMode>('remote.mode', 'direct'), proxy, allowHttp: config().get<boolean>('remote.allowHttp', false) }),
    proxiedOrigins,
    transportMode: () => config().get<TransportMode>('transport.mode', 'shim'),
    transport: () => ({
      maxChunkBytes: broker.chunkLimit,
      cacheMaxEntryBytes: 1024 * 1024,
      cacheTotalBytes: config().get<number>('transport.cacheMiB', 64) * 1024 * 1024,
    }),
  });
  context.subscriptions.push(viewers);
  const updateContext = () => void vscode.commands.executeCommand('setContext', 'igv.hasViewer', viewers.size > 0);
  context.subscriptions.push(viewers.onDidChangeActive(updateContext));
  updateContext();

  const sessions = new SessionService(genomes, context.workspaceState, log);

  /** Runs a tool job with a cancellable progress notification; the exact commands go to the IGV output channel. */
  const runJob = <T,>(title: string, task: (ctx: JobContext) => Promise<T>): Promise<T> =>
    Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      return task({
        log: (line) => log.info(line, 'job'),
        progress: (message) => progress.report({ message }),
        signal: controller.signal,
      });
    }));

  const askPolicy = async (q: PolicyQuestion): Promise<PolicyAnswer | undefined> => {
    const labels: Record<string, string> = {
      index: q.problem.format === 'bam' || q.problem.format === 'cram' ? 'Index with samtools' : 'Index with tabix',
      compressIndex: 'Sort, compress and index (bgzip + tabix)',
      subsample: 'Subsample…',
      loadAnyway: 'Load anyway',
      cancel: 'Cancel',
    };
    const missing = q.missingTools.length ? ` (${q.missingTools.join(', ')} not found; see IGV output for install hints)` : '';
    const choice = await vscode.window.showWarningMessage(`IGV: ${q.message}.${missing}`, { modal: true, detail: `Suggested command:
${q.problem.suggestedCommand}` }, ...q.actions.filter((a) => a !== 'cancel').map((a) => labels[a]!));
    if (q.missingTools.length) for (const t of q.missingTools) log.warn(`${t} not found on PATH. Set igv.tools.paths.${t} or install it.`);
    const action = (Object.keys(labels) as (keyof typeof labels)[]).find((k) => labels[k] === choice) as PolicyAnswer['action'] | undefined;
    if (!action) return undefined;
    if (action === 'subsample') {
      const sub = await askSubsample();
      return sub ? { action, subsample: sub } : undefined;
    }
    return { action };
  };

  const askSubsample = async (): Promise<{ fraction?: number; reads?: number; seed: number; region?: string } | undefined> => {
    const value = await vscode.window.showInputBox({
      prompt: 'Subsample: fraction (0-1, e.g. 0.1) or target read count (e.g. 500000), optionally followed by a region',
      placeHolder: '0.1   or   500000 chr1:1,000,000-2,000,000',
      value: '0.1',
      ignoreFocusOut: true,
      validateInput: (v) => (/^\s*\d*\.?\d+(\s+\S+)?\s*$/.test(v) ? undefined : 'Enter a fraction like 0.1 or a read count like 500000, optionally followed by a region'),
    });
    if (!value) return undefined;
    const [num, region] = value.trim().split(/\s+/);
    const n = Number(num);
    return n > 0 && n <= 1 ? { fraction: n, seed: 42, region } : { reads: Math.round(n), seed: 42, region };
  };

  const policy = new LargeFilePolicy({
    tools,
    derivedDir,
    resolveContext: () => ({ baseDir: baseDir(), workspaceFolders: workspaceFolders(), settings: resolverSettings() }),
    log: (line) => log.info(line, 'policy'),
    runJob,
    ask: askPolicy,
  });
  context.subscriptions.push(createStatusBar(viewers));

  // Restore snapshots: every viewer gets a key stored in the webview state; the matching
  // session (absolute paths) lives in workspaceState and is replayed by the serializer.
  const restoreKeys = new Map<string, string>();
  const restoreTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleRestoreSnapshot = (viewerId: string) => {
    const viewer = viewers.list().some((v) => v.id === viewerId) ? viewers.resolve(viewerId) : undefined;
    const key = restoreKeys.get(viewerId);
    if (!viewer || !key) return;
    clearTimeout(restoreTimers.get(viewerId));
    restoreTimers.set(viewerId, setTimeout(() => void sessions.rememberForRestore(key, viewer), 500));
  };
  context.subscriptions.push(
    viewers.onDidChangeActive((v) => {
      if (v && !restoreKeys.has(v.id)) {
        const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        restoreKeys.set(v.id, key);
        v.setRestoreKey(key);
        v.onDidDispose(() => {
          restoreKeys.delete(v.id);
          clearTimeout(restoreTimers.get(v.id));
        });
      }
    }),
    viewers.onDidChangeState((st) => scheduleRestoreSnapshot(st.id)),
    { dispose: () => { for (const t of restoreTimers.values()) clearTimeout(t); } },
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('igv.genomes.custom')) loadCustomGenomes();
    }),
  );

  /** Open a new viewer (asking for a genome) and optionally add tracks. */
  async function openNewViewer(specs: TrackSpec[], genome?: ResolvedGenome, alwaysAsk = false): Promise<ViewerController | undefined> {
    const g = genome ?? (await chooseGenomeForNewViewer(genomes, baseDir(), { alwaysAsk }));
    if (!g) return undefined;
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `IGV: loading ${g.id}…` },
      async () => {
        const viewer = await viewers.open({ genome: g, opener: 'human' });
        const first = specs.find((sp) => sp.path);
        if (first?.path) {
          const locus = await suggestInitialLocus(path.resolve(baseDir(), first.path), viewer.chromosomes);
          if (locus) await viewer.goto(locus).catch((err) => log.warn(`initial locus ${locus} failed: ${String(err)}`, viewer.id));
        }
        const extra = genomes.tracksFor(g.id);
        if (extra.length > 0 || specs.length > 0) await addTracksWithFeedback(viewer, [...extra, ...specs]);
        return viewer;
      },
    );
  }

  /** Human flows: skip files already in the viewer instead of adding duplicate tracks. */
  async function addTracksWithFeedback(viewer: ViewerController, specs: TrackSpec[]): Promise<void> {
    if (specs.length === 0) return;
    const present = new Set(viewer.getState().tracks.map((t) => t.source));
    const fresh = specs.filter((s) => {
      const src = s.url ?? (s.path ? path.resolve(baseDir(), s.path) : undefined);
      return !src || !present.has(src);
    });
    if (fresh.length === 0) {
      const names = specs.map((s) => path.basename(s.url ?? s.path ?? '')).join(', ');
      void vscode.window.setStatusBarMessage(`IGV: ${names} already in viewer ${viewer.name}`, 4000);
      return;
    }
    const prepared = await policy.prepare(fresh, 'interactive');
    for (const n of prepared.notes) log.info(n, 'policy');
    if (prepared.specs.length === 0) return;
    const result = await viewer.addTracks(prepared.specs, { baseDir: baseDir() });
    await showTrackWarnings(result);
  }

  async function showTrackWarnings(result: { warnings: string[]; mismatches: { trackName: string; fileNames: string[]; genomeId: string }[] }): Promise<void> {
    if (result.mismatches.length > 0) {
      const names = result.mismatches.map((m) => m.trackName).join(', ');
      const seqs = [...new Set(result.mismatches.flatMap((m) => m.fileNames))].slice(0, 4).join(', ');
      const genomeId = result.mismatches[0]!.genomeId;
      // Not awaited: a notification stays until dismissed and must not block the command.
      void vscode.window
        .showWarningMessage(
          `IGV: ${names} refer${result.mismatches.length === 1 ? 's' : ''} to sequences (${seqs}) that are not in the genome ${genomeId}. The track will look empty until a matching genome is chosen.`,
          'Set Genome…',
          'Dismiss',
        )
        .then((choice) => (choice === 'Set Genome…' ? vscode.commands.executeCommand('igv.setGenome') : undefined));
    }
    for (const w of result.warnings) {
      if (w.startsWith('GENOME_MISMATCH:')) continue;
      void vscode.window.showWarningMessage(`IGV: ${w}`);
    }
  }

  /** Files from an Explorer invocation (single or multi-select) or a file dialog. */
  async function collectFiles(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<string[]> {
    const list = uris && uris.length > 0 ? uris : uri ? [uri] : [];
    if (list.length > 0) return list.filter((u) => u.scheme === 'file').map((u) => u.fsPath);
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Add to IGV', title: 'Select data files for IGV' });
    return (picked ?? []).map((u) => u.fsPath);
  }

  function partitionFiles(files: string[]): { tracks: TrackSpec[]; references: string[]; skipped: string[] } {
    const tracks: TrackSpec[] = [];
    const references: string[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const info = inferFormat(f);
      if (info.kind === 'reference') references.push(f);
      else if (info.kind === 'track') tracks.push({ path: f });
      else skipped.push(path.basename(f));
    }
    return { tracks, references, skipped };
  }

  context.subscriptions.push(
    IgvEditorProvider.register(context, {
      viewers, genomes, sessions, log,
      workspaceState: context.workspaceState,
      extensionUri: context.extensionUri,
      chooseGenome: () => chooseGenomeForNewViewer(genomes, baseDir()),
      openBehavior: () => config().get<'addToActive' | 'newViewer'>('openBehavior', 'addToActive'),
      addTracksWithFeedback,
    }),
    vscode.window.registerWebviewPanelSerializer(VIEWER_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        const key = (state as { key?: unknown } | undefined)?.key;
        const entry = typeof key === 'string' ? await sessions.takeRestoreEntry(key) : undefined;
        if (!entry) {
          log.warn(`cannot restore viewer panel: no saved state${typeof key === 'string' ? ` for ${key}` : ''}`);
          panel.dispose();
          return;
        }
        panel.webview.options = {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'dist')],
        };
        const viewer = viewers.adopt(panel, { name: entry.name, opener: 'human' });
        try {
          const r = await sessions.applyRestoreEntry(viewer, entry);
          for (const w of r.warnings) log.warn(`restore: ${w}`, viewer.id);
          log.info(`restored viewer "${entry.name}" after reload`, viewer.id);
        } catch (err) {
          log.error(err instanceof Error ? err : String(err), viewer.id);
          void vscode.window.showErrorMessage(`IGV: could not restore viewer "${entry.name}": ${RpcError.from(err).message}`);
        }
      },
    }),
  );

  async function pickSessionTarget(): Promise<ViewerController | undefined> {
    const active = viewers.active;
    if (active) return active;
    const genome = await chooseGenomeForNewViewer(genomes, baseDir());
    return genome ? viewers.open({ genome, opener: 'human' }) : undefined;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('igv.gotoLocusFromSelection', () =>
      runCommand(log, 'Go to Locus from Selection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) throw new RpcError('INTERNAL', 'No active text editor', { hint: 'Select a locus, VCF/BED/GFF/SAM line or gene name in an editor first.' });
        const sel = editor.selection;
        let parsed = parseLocusFromText(sel.isEmpty ? editor.document.lineAt(sel.active.line).text : editor.document.getText(sel));
        if (parsed.kind === 'none' && !sel.isEmpty) {
          // A partial selection: fall back to the full lines it spans.
          const lines = editor.document.getText(new vscode.Range(sel.start.line, 0, sel.end.line, editor.document.lineAt(sel.end.line).text.length));
          parsed = parseLocusFromText(lines);
        }
        if (parsed.kind === 'none') throw new RpcError('INTERNAL', parsed.reason, { hint: 'Select a locus (chr1:1,000-2,000), a VCF/BED/GFF/SAM line, or a gene name.' });
        const viewer = viewers.resolve();
        await viewer.goto(parsed.kind === 'locus' ? parsed.locus : parsed.term);
        viewer.reveal(true);
      }),
    ),
    vscode.commands.registerCommand('igv.saveSession', () =>
      runCommand(log, 'Save Session', async () => {
        const viewer = viewers.resolve();
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
        const target = await vscode.window.showSaveDialog({
          title: 'Save IGV session',
          defaultUri: ws ? vscode.Uri.joinPath(ws, `${viewer.name.replace(/[^\w.-]+/g, '_')}.igv.json`) : undefined,
          filters: { 'IGV session': ['igv.json', 'json'] },
          saveLabel: 'Save Session',
        });
        if (!target) return;
        const saved = await sessions.save(viewer, target.fsPath, true);
        const action = await vscode.window.showInformationMessage(`IGV: session saved to ${path.basename(saved)}`, 'Open File');
        if (action === 'Open File') await vscode.window.showTextDocument(vscode.Uri.file(saved));
      }),
    ),
    vscode.commands.registerCommand('igv.loadSession', (uri?: vscode.Uri) =>
      runCommand(log, 'Load Session', async () => {
        let file = uri?.scheme === 'file' ? uri.fsPath : undefined;
        if (!file) {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'IGV session': ['igv.json', 'json'] }, openLabel: 'Load Session' });
          file = picked?.[0]?.fsPath;
        }
        if (!file) return;
        const viewer = await pickSessionTarget();
        if (!viewer) return;
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'IGV: loading session…' }, () =>
          sessions.loadFile(viewer, file!),
        );
        for (const w of result.warnings) void vscode.window.showWarningMessage(`IGV: ${w}`);
        viewer.reveal(false);
      }),
    ),
    vscode.commands.registerCommand('igv.exportSnapshot', () =>
      runCommand(log, 'Export Snapshot', async () => {
        const viewer = viewers.resolve();
        const dir = await defaultSnapshotDir(context);
        const target = await vscode.window.showSaveDialog({
          title: 'Export IGV snapshot',
          defaultUri: vscode.Uri.file(path.join(dir, snapshotFileName(viewer.name.replace(/[^\w.-]+/g, '_'), 'png'))),
          filters: { 'PNG image': ['png'], 'SVG image': ['svg'] },
          saveLabel: 'Export',
        });
        if (!target) return;
        const format = target.fsPath.toLowerCase().endsWith('.svg') ? 'svg' : 'png';
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'IGV: rendering snapshot…' }, async () => {
          if (format === 'svg') {
            const { svg } = await viewer.snapshotSvg();
            await fs.promises.writeFile(target.fsPath, svg, 'utf8');
          } else {
            const { png } = await viewer.snapshotPng(config().get<number>('snapshot.scale', 2));
            await fs.promises.writeFile(target.fsPath, png);
          }
        });
        log.info(`snapshot written to ${target.fsPath}`, viewer.id);
        const action = await vscode.window.showInformationMessage(`IGV: snapshot saved to ${path.basename(target.fsPath)}`, 'Open');
        if (action === 'Open') await vscode.commands.executeCommand('vscode.open', target);
      }),
    ),
    vscode.commands.registerCommand('igv.loadTrackFromUrl', () =>
      runCommand(log, 'Load Track from URL', async () => {
        const url = await vscode.window.showInputBox({
          prompt: 'URL of a data file (https://…). An index next to it is found automatically; append a space and the index URL to override.',
          placeHolder: 'https://example.org/sample.bam',
          ignoreFocusOut: true,
          validateInput: (v) => (/^https?:\/\/\S+/.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
        });
        if (!url) return;
        const [u, idx] = url.trim().split(/\s+/);
        const viewer = await pickSessionTarget();
        if (!viewer) return;
        if (u!.startsWith('http://') && !config().get<boolean>('remote.allowHttp', false) && config().get<string>('remote.mode', 'direct') !== 'proxy') {
          void vscode.window.showWarningMessage('IGV: plain http:// URLs are blocked in the viewer unless igv.remote.allowHttp is enabled or igv.remote.mode is "proxy".');
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'IGV: loading remote track…' }, () =>
          addTracksWithFeedback(viewer, [{ url: u, index: idx }]),
        );
      }),
    ),
    vscode.commands.registerCommand('igv.indexFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      runCommand(log, 'Index File', async () => {
        const files = await collectFiles(uri, uris);
        for (const f of files) {
          const r = await policy.indexFile(f);
          log.info(r.note, 'policy');
          void vscode.window.showInformationMessage(`IGV: ${r.note}`);
        }
      }),
    ),
    vscode.commands.registerCommand('igv.subsampleBam', (uri?: vscode.Uri) =>
      runCommand(log, 'Subsample BAM', async () => {
        let file = uri?.scheme === 'file' ? uri.fsPath : undefined;
        if (!file) {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { BAM: ['bam'] }, openLabel: 'Subsample' });
          file = picked?.[0]?.fsPath;
        }
        if (!file) return;
        const sub = await askSubsample();
        if (!sub) return;
        const notes: string[] = [];
        const spec = await policy.subsample({ path: file }, file, sub, notes);
        for (const n of notes) log.info(n, 'policy');
        const choice = await vscode.window.showInformationMessage(`IGV: ${notes.join('; ')}`, 'Add to Viewer');
        if (choice === 'Add to Viewer') {
          const viewer = await pickSessionTarget();
          if (viewer) await addTracksWithFeedback(viewer, [spec]);
        }
      }),
    ),
    vscode.commands.registerCommand('igv.reopenAsText', async (uri?: vscode.Uri) => {
      const tabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
      const target = uri ?? tabInput?.uri;
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
  );

  context.subscriptions.push(
    // "New Viewer" always asks (the default genome is listed first); opening a data file uses the default silently.
    vscode.commands.registerCommand('igv.newViewer', () =>
      runCommand(log, 'New Viewer', async () => {
        await openNewViewer([], undefined, true);
      }),
    ),
    vscode.commands.registerCommand('igv.addToViewer', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      runCommand(log, 'Add to Viewer', async () => {
        const files = await collectFiles(uri, uris);
        if (files.length === 0) return;
        const { tracks, references, skipped } = partitionFiles(files);
        if (skipped.length) void vscode.window.showWarningMessage(`IGV: skipped unsupported file(s): ${skipped.join(', ')}`);
        let genome: ResolvedGenome | undefined;
        if (references.length > 0) genome = genomes.fromLocalFile(references[0]!);
        const active = viewers.active;
        const behavior = config().get<string>('openBehavior', 'addToActive');
        if (active && behavior === 'addToActive' && !genome) {
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'IGV: adding tracks…' }, () =>
            addTracksWithFeedback(active, tracks),
          );
          active.reveal(true);
        } else {
          await openNewViewer(tracks, genome);
        }
      }),
    ),
    vscode.commands.registerCommand('igv.openInNewViewer', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      runCommand(log, 'Open in New Viewer', async () => {
        const files = await collectFiles(uri, uris);
        if (files.length === 0) return;
        const { tracks, references, skipped } = partitionFiles(files);
        if (skipped.length) void vscode.window.showWarningMessage(`IGV: skipped unsupported file(s): ${skipped.join(', ')}`);
        await openNewViewer(tracks, references.length > 0 ? genomes.fromLocalFile(references[0]!) : undefined);
      }),
    ),
    vscode.commands.registerCommand('igv.gotoLocus', (locus?: string) =>
      runCommand(log, 'Go to Locus', async () => {
        const viewer = viewers.resolve();
        const target = locus ?? (await askLocus(viewer.getState().loci.join(' ')));
        if (!target) return;
        await viewer.goto(target.split(/\s+/).length > 1 ? target.split(/\s+/) : target);
      }),
    ),
    vscode.commands.registerCommand('igv.setGenome', () =>
      runCommand(log, 'Set Genome', async () => {
        const viewer = viewers.resolve();
        const genome = await pickGenome(genomes, `Genome for viewer ${viewer.name}`, baseDir());
        if (!genome) return;
        let keepTracks = false;
        if (viewer.getState().tracks.length > 0) {
          const choice = await vscode.window.showQuickPick(
            [
              { label: 'Keep tracks', description: 'Reload the current tracks on the new genome', keep: true },
              { label: 'Clear tracks', description: 'Start with an empty viewer', keep: false },
            ],
            { placeHolder: `Switch ${viewer.name} to ${genome.id}` },
          );
          if (!choice) return;
          keepTracks = choice.keep;
        }
        if (genome.source !== 'local-file') await genomes.markUsed(genome.id);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `IGV: loading ${genome.id}…` }, async () => {
          const result = await viewer.setGenome(genome, undefined, { keepTracks });
          await showTrackWarnings(result);
        });
      }),
    ),
    vscode.commands.registerCommand('igv.removeTrack', () =>
      runCommand(log, 'Remove Track', async () => {
        const viewer = viewers.resolve();
        const ids = await pickTracks(viewer.getState().tracks);
        if (!ids) return;
        await viewer.removeTracks({ ids });
      }),
    ),
    vscode.commands.registerCommand('igv.showOutput', () => log.show()),
  );

  // ---- agent control channel + CLI (spec §6) --------------------------------
  const host: HostKind = vscode.env.appHost !== 'desktop' ? 'code-server' : vscode.env.remoteName ? 'remote' : 'desktop';
  let igvVersion = '';
  try {
    igvVersion = (JSON.parse(fs.readFileSync(vscode.Uri.joinPath(context.extensionUri, 'media', 'igv-version.json').fsPath, 'utf8')) as { version: string }).version;
  } catch {
    // leave empty
  }
  const controlApi = createControlApi({
    viewers, genomes, sessions, policy,
    version: context.extension.packageJSON.version as string,
    igvVersion,
    vscodeVersion: vscode.version,
    host,
    workspaceFolders,
    defaultGenome: () => {
      const id = genomes.getDefaultGenomeId();
      if (!id) return undefined;
      try {
        return genomes.resolve(id, baseDir());
      } catch {
        return undefined;
      }
    },
    snapshotDir: () => defaultSnapshotDir(context),
    log: (level, message) => log.log(level, message, 'agent'),
  });
  const agent = new AgentService({ context, log, handler: controlApi, version: context.extension.packageJSON.version as string, host });
  context.subscriptions.push(agent);
  void agent.start();
  context.subscriptions.push(
    vscode.commands.registerCommand('igv.installCli', () =>
      runCommand(log, 'Install CLI on PATH', async () => {
        const message = await agent.installCliOnPath();
        void vscode.window.showInformationMessage(`IGV: ${message}`);
      }),
    ),
    vscode.commands.registerCommand('igv.copyMcpSetup', () =>
      runCommand(log, 'Copy MCP Setup Command', async () => {
        const launcher = agent.launcherPaths?.posix;
        if (!launcher) throw new RpcError('INTERNAL', 'The CLI launcher has not been written yet; see the IGV output channel.');
        const quoted = /[\s'"]/.test(launcher) ? `'${launcher.replace(/'/g, `'\\''`)}'` : launcher;
        const command = `claude mcp add igv -- ${quoted} mcp`;
        await vscode.env.clipboard.writeText(command);
        const choice = await vscode.window.showInformationMessage(`IGV: copied to the clipboard: ${command}`, 'Also add the igv skill to this workspace');
        if (choice) await vscode.commands.executeCommand('igv.addAgentSkill');
      }),
    ),
    vscode.commands.registerCommand('igv.addAgentSkill', () =>
      runCommand(log, 'Add Agent Skill to Workspace', async () => {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) throw new RpcError('INTERNAL', 'Open a folder first: the skill is written to <workspace>/.claude/skills/igv/SKILL.md');
        const src = vscode.Uri.joinPath(context.extensionUri, 'agent', 'SKILL.md');
        const dest = vscode.Uri.joinPath(ws.uri, '.claude', 'skills', 'igv', 'SKILL.md');
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(ws.uri, '.claude', 'skills', 'igv'));
        await vscode.workspace.fs.copy(src, dest, { overwrite: true });
        log.info(`agent skill written to ${dest.fsPath}`, 'agent');
        const choice = await vscode.window.showInformationMessage(`IGV: skill written to ${vscode.workspace.asRelativePath(dest)}`, 'Open');
        if (choice === 'Open') await vscode.window.showTextDocument(dest);
      }),
    ),
  );

  return { viewers, genomes, broker, sessions, tools, policy, proxy, agent };
}

export function deactivate(): void {
  // Disposables registered on the context handle cleanup.
}

async function runCommand(log: Logger, title: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const e = RpcError.from(err);
    const hint = (e.data as { hint?: string } | undefined)?.hint;
    log.error(`${title} failed: ${e.code}: ${e.message}${hint ? ` (${hint})` : ''}`);
    const action = await vscode.window.showErrorMessage(`IGV: ${title} failed: ${e.message}${hint ? ` ${hint}` : ''}`, 'Show Output');
    if (action === 'Show Output') log.show();
  }
}

function loadBundledGenomes(context: vscode.ExtensionContext, log: Logger) {
  const file = vscode.Uri.joinPath(context.extensionUri, 'media', 'genomes.json').fsPath;
  try {
    const list = parseGenomeList(fs.readFileSync(file, 'utf8'));
    log.info(`loaded ${list.length} bundled genomes`);
    return list;
  } catch (err) {
    log.error(`failed to load bundled genome list from ${file}: ${(err as Error).message}`);
    return [];
  }
}

function makeGenomeStore(context: vscode.ExtensionContext): GenomeDefaultsStore {
  return {
    getDefaultGenome: () => vscode.workspace.getConfiguration('igv').get<string>('defaultGenome'),
    setDefaultGenome: async (id) => {
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('igv').update('defaultGenome', id, target);
    },
    getRecent: () => context.workspaceState.get<string[]>(RECENT_GENOMES_KEY, []),
    setRecent: async (ids) => {
      await context.workspaceState.update(RECENT_GENOMES_KEY, ids);
    },
  };
}
