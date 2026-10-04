/**
 * Custom read-only editor (spec §8.1). Opening a data file through it adds
 * the file to the active viewer (default) or turns the editor tab into a new
 * viewer; opening an `.igv.json` session always makes the tab a viewer.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ResolvedGenome, TrackSpec } from '../agent/protocol';
import { inferFormat } from '../data/formats';
import { suggestInitialLocus } from '../data/sequenceNames';
import type { GenomeRegistry } from '../genome/GenomeRegistry';
import type { Logger } from '../log';
import { isSessionFileName } from '../session/SessionStore';
import type { SessionService } from '../session/SessionService';
import { RpcError } from '../shared/rpc';
import type { ViewerController } from './ViewerController';
import type { ViewerManager } from './ViewerManager';

export const EDITOR_VIEW_TYPE = 'igv.editor';
/** Same provider, registered under a second viewType for formats where the text editor stays the default (spec §8.1). */
export const EDITOR_OPTION_VIEW_TYPE = 'igv.editorOption';
const EDITOR_STATE_KEY = 'igv.editorLoci';

export interface EditorProviderDeps {
  viewers: ViewerManager;
  genomes: GenomeRegistry;
  sessions: SessionService;
  log: Logger;
  workspaceState: vscode.Memento;
  extensionUri: vscode.Uri;
  /** Ask the human for a genome (quick pick). Returns undefined when cancelled. */
  chooseGenome: () => Promise<ResolvedGenome | undefined>;
  openBehavior: () => 'addToActive' | 'newViewer';
  addTracksWithFeedback: (viewer: ViewerController, specs: TrackSpec[]) => Promise<void>;
}

class IgvDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {
    // Nothing to release: the viewer owns the data access.
  }
}

export class IgvEditorProvider implements vscode.CustomReadonlyEditorProvider<IgvDocument> {
  constructor(private readonly deps: EditorProviderDeps) {}

  static register(_context: vscode.ExtensionContext, deps: EditorProviderDeps): vscode.Disposable {
    const provider = new IgvEditorProvider(deps);
    const options = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false };
    const a = vscode.window.registerCustomEditorProvider(EDITOR_VIEW_TYPE, provider, options);
    const b = vscode.window.registerCustomEditorProvider(EDITOR_OPTION_VIEW_TYPE, provider, options);
    return { dispose: () => { a.dispose(); b.dispose(); } };
  }

  openCustomDocument(uri: vscode.Uri): IgvDocument {
    return new IgvDocument(uri);
  }

  /**
   * VS Code does not start loading the webview until this method returns, so
   * the genome and track loading must run detached: awaiting it here would
   * wait forever for the webview's "ready" event.
   */
  async resolveCustomEditor(document: IgvDocument, panel: vscode.WebviewPanel): Promise<void> {
    const { viewers } = this.deps;
    const fsPath = document.uri.fsPath;
    const base = path.basename(fsPath);
    if (document.uri.scheme !== 'file') {
      panel.webview.html = messageHtml(`IGV can only open local files (got ${document.uri.scheme}:).`);
      return;
    }
    if (isSessionFileName(base)) {
      this.configurePanel(panel);
      const viewer = viewers.adopt(panel, { name: base.replace(/\.igv\.json$/i, ''), opener: 'human' });
      void this.guarded(fsPath, panel, () => this.loadSessionInto(viewer, fsPath));
      return;
    }
    const info = inferFormat(base);
    const kind = info.kind;
    if (kind === 'unsupported') {
      panel.webview.html = messageHtml(`IGV cannot open ${base}.${info.hint ? `\n\n${info.hint}` : ''}`);
      void vscode.window.showErrorMessage(`IGV cannot open ${base}. ${info.hint ?? ''}`);
      return;
    }
    const active = viewers.active;
    if (kind === 'track' && active && this.deps.openBehavior() === 'addToActive') {
      // Add to the existing viewer; this tab only shows a note and closes itself once VS Code has finished opening it.
      panel.webview.html = messageHtml(`Adding ${base} to IGV viewer "${active.name}"…`);
      void this.guarded(fsPath, undefined, async () => {
        await this.deps.addTracksWithFeedback(active, [{ path: fsPath }]);
        active.reveal(true);
        setTimeout(() => {
          try {
            panel.dispose();
          } catch {
            // already closed
          }
        }, 100);
      });
      return;
    }
    this.configurePanel(panel);
    void this.guarded(fsPath, panel, () => this.openDataEditor(fsPath, kind, panel));
  }

  private async guarded(fsPath: string, panel: vscode.WebviewPanel | undefined, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const e = RpcError.from(err);
      const hint = (e.data as { hint?: string } | undefined)?.hint;
      this.deps.log.error(`custom editor for ${fsPath} failed: ${e.code}: ${e.message}`);
      if (panel && !this.deps.viewers.list().some((v) => v.visible)) {
        try {
          panel.webview.html = messageHtml(`${e.message}${hint ? `\n\n${hint}` : ''}`);
        } catch {
          // panel already disposed
        }
      }
      void vscode.window.showErrorMessage(`IGV: ${e.message}${hint ? ` ${hint}` : ''}`);
    }
  }

  private configurePanel(panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'media'), vscode.Uri.joinPath(this.deps.extensionUri, 'dist')],
    };
  }

  private async loadSessionInto(viewer: ViewerController, fsPath: string): Promise<void> {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `IGV: loading session ${path.basename(fsPath)}…` },
      () => this.deps.sessions.loadFile(viewer, fsPath),
    );
    for (const w of result.warnings) void vscode.window.showWarningMessage(`IGV: ${w}`);
    this.trackEditorLocus(fsPath, viewer);
  }

  private async openDataEditor(fsPath: string, kind: 'track' | 'reference' | 'session', panel: vscode.WebviewPanel): Promise<void> {
    const { genomes } = this.deps;
    let genome: ResolvedGenome | undefined;
    const tracks: TrackSpec[] = [];
    if (kind === 'reference') {
      genome = genomes.fromLocalFile(fsPath);
    } else {
      genome = await this.deps.chooseGenome();
      if (!genome) {
        panel.dispose();
        return;
      }
      tracks.push({ path: fsPath }, ...genomes.tracksFor(genome.id));
    }
    const viewer = this.deps.viewers.adopt(panel, { name: path.basename(fsPath), opener: 'human' });
    const g = genome;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `IGV: loading ${g.id}…` }, async () => {
      await viewer.setGenome(g);
      const restored = await this.applyRememberedLocus(fsPath, viewer);
      if (!restored && kind === 'track') {
        const locus = await suggestInitialLocus(fsPath, viewer.chromosomes);
        if (locus) await viewer.goto(locus).catch((err) => this.deps.log.warn(`initial locus ${locus} failed: ${String(err)}`, viewer.id));
      }
      if (tracks.length) await this.deps.addTracksWithFeedback(viewer, tracks);
    });
    this.trackEditorLocus(fsPath, viewer);
  }

  /** Remember the last locus per (file, genome) so re-opening (or a window reload) returns to it. */
  private trackEditorLocus(fsPath: string, viewer: ViewerController): void {
    viewer.onDidChangeState((s) => {
      if (s.loci.length === 0 || !s.genome) return;
      const all = this.deps.workspaceState.get<Record<string, string[]>>(EDITOR_STATE_KEY, {});
      all[`${fsPath}::${s.genome.id}`] = s.loci;
      void this.deps.workspaceState.update(EDITOR_STATE_KEY, all);
    });
  }

  /**
   * Navigate to the remembered locus for this file and genome, if its
   * chromosome exists in the loaded genome. Failures are logged, never fatal:
   * a stale locus must not leave the viewer blank.
   */
  private async applyRememberedLocus(fsPath: string, viewer: ViewerController): Promise<boolean> {
    const genomeId = viewer.genomeId;
    if (!genomeId) return false;
    const loci = this.deps.workspaceState.get<Record<string, string[]>>(EDITOR_STATE_KEY, {})[`${fsPath}::${genomeId}`];
    if (!loci || loci.length === 0) return false;
    const known = new Set(viewer.chromosomes.map((c) => c.toLowerCase()));
    const ok = loci.every((l) => known.size === 0 || known.has(l.split(':')[0]!.toLowerCase()));
    if (!ok) return false;
    try {
      await viewer.goto(loci.length === 1 ? loci[0]! : loci);
      return true;
    } catch (err) {
      this.deps.log.warn(`could not restore locus ${loci.join(' ')} for ${path.basename(fsPath)}: ${String(err)}`, viewer.id);
      return false;
    }
  }
}

function messageHtml(text: string): string {
  const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
  return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:16px;white-space:pre-wrap">${esc}</body></html>`;
}
