import * as vscode from 'vscode';
import type { ViewerManager } from '../viewer/ViewerManager';

/** Status bar item showing the active viewer's locus; click runs "IGV: Go to Locus…" (spec §8.1). */
export function createStatusBar(viewers: ViewerManager): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('igv.locus', vscode.StatusBarAlignment.Left, 50);
  item.name = 'IGV locus';
  item.command = 'igv.gotoLocus';

  const update = () => {
    const active = viewers.active;
    if (!active) {
      item.hide();
      return;
    }
    const s = active.getState();
    const loci = s.loci.length ? s.loci.join('  ') : 'no locus';
    item.text = `$(dna) ${loci}`;
    item.tooltip = new vscode.MarkdownString(`**IGV ${s.name}** · ${s.genome?.id ?? 'no genome'} · ${s.tracks.length} track(s)\n\nClick to go to a locus.`);
    item.show();
  };

  const subs = [viewers.onDidChangeActive(update), viewers.onDidChangeState(update)];
  update();
  return { dispose: () => { for (const d of subs) d.dispose(); item.dispose(); } };
}
