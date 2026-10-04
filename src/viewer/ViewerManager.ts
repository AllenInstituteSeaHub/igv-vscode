/**
 * Creates, tracks, names and disposes viewers; tracks the active viewer
 * (last focused, else most recently created) (spec §3.1).
 */
import * as vscode from 'vscode';
import type { ResolvedGenome, ViewerState, ViewerSummary } from '../agent/protocol';
import { RpcError } from '../shared/rpc';
import type { Logger } from '../log';
import { ViewerController, type ViewerControllerDeps } from './ViewerController';

export { VIEWER_VIEW_TYPE } from './ViewerController';

export type Opener = 'human' | 'agent';

export interface OpenViewerOptions {
  name?: string;
  genome: ResolvedGenome;
  locus?: string | string[];
  opener: Opener;
}

export type ViewerDeps = Omit<ViewerControllerDeps, 'log' | 'extensionUri'>;

export class ViewerManager implements vscode.Disposable {
  private readonly viewers = new Map<string, ViewerController>();
  private nextIndex = 1;
  private activeId: string | undefined;

  private readonly _onDidChangeActive = new vscode.EventEmitter<ViewerController | undefined>();
  readonly onDidChangeActive = this._onDidChangeActive.event;
  private readonly _onDidChangeState = new vscode.EventEmitter<ViewerState>();
  readonly onDidChangeState = this._onDidChangeState.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: Logger,
    private readonly deps: ViewerDeps,
  ) {}

  async open(options: OpenViewerOptions): Promise<ViewerController> {
    const id = `v${this.nextIndex}`;
    const name = options.name?.trim() || id;
    const placement =
      options.opener === 'agent'
        ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
        : { viewColumn: vscode.ViewColumn.Active, preserveFocus: false };
    const panel = ViewerController.createPanel(`IGV ${name}`, placement, this.extensionUri);
    const viewer = this.adopt(panel, { name: options.name, opener: options.opener });

    try {
      await viewer.setGenome(options.genome, options.locus);
    } catch (err) {
      this.log.error(err instanceof Error ? err : String(err), viewer.id);
      viewer.dispose();
      throw err;
    }
    return viewer;
  }

  /**
   * Wrap an existing WebviewPanel (custom editor, restored panel) in a viewer.
   * The caller loads a genome afterwards.
   */
  adopt(panel: vscode.WebviewPanel, options: { name?: string; opener: Opener }): ViewerController {
    const id = `v${this.nextIndex++}`;
    const name = options.name?.trim() || id;
    const viewer = new ViewerController(id, name, panel, { ...this.deps, extensionUri: this.extensionUri, log: this.log });
    this.viewers.set(id, viewer);
    this.log.info(`opened viewer ${id} ("${name}") by ${options.opener}`, id);
    viewer.onDidDispose(() => {
      this.viewers.delete(id);
      if (this.activeId === id) this.setActive(this.mostRecent()?.id);
    });
    viewer.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) this.setActive(id);
    });
    viewer.onDidChangeState((s) => this._onDidChangeState.fire(s));
    this.setActive(id);
    return viewer;
  }

  get active(): ViewerController | undefined {
    return this.activeId ? this.viewers.get(this.activeId) : undefined;
  }

  list(): ViewerSummary[] {
    return [...this.viewers.values()].map((v) => {
      const s = v.getState();
      return {
        id: s.id, name: s.name, genome: s.genome, loci: s.loci, trackCount: s.tracks.length,
        visible: v.visible, active: v.id === this.activeId,
      };
    });
  }

  /** Resolve a `--viewer` target (id or name). Undefined means the active viewer. */
  resolve(target?: string): ViewerController {
    if (target === undefined || target === '') {
      const active = this.active;
      if (!active) {
        throw new RpcError('NO_VIEWER', 'No IGV viewer is open', {
          hint: 'Run "igv-vscode open …" or the command "IGV: New Viewer" first.',
        });
      }
      return active;
    }
    const byId = this.viewers.get(target);
    if (byId) return byId;
    const byName = [...this.viewers.values()].find((v) => v.name === target);
    if (byName) return byName;
    throw new RpcError('VIEWER_NOT_FOUND', `No viewer with id or name "${target}"`, {
      hint: `Open viewers: ${[...this.viewers.values()].map((v) => `${v.id} (${v.name})`).join(', ') || 'none'}`,
    });
  }

  get size(): number {
    return this.viewers.size;
  }

  dispose(): void {
    for (const v of [...this.viewers.values()]) v.dispose();
    this.viewers.clear();
    this._onDidChangeActive.dispose();
    this._onDidChangeState.dispose();
  }

  private setActive(id: string | undefined): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this._onDidChangeActive.fire(this.active);
  }

  private mostRecent(): ViewerController | undefined {
    let last: ViewerController | undefined;
    for (const v of this.viewers.values()) last = v;
    return last;
  }
}
