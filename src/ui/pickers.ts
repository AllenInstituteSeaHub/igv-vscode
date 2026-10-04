import * as vscode from 'vscode';
import type { GenomeRegistry } from '../genome/GenomeRegistry';
import type { ResolvedGenome, TrackState } from '../agent/protocol';

interface GenomeItem extends vscode.QuickPickItem {
  genomeId?: string;
  localFile?: true;
}

/**
 * Genome quick pick (spec §7 "Defaults"): recent genomes first, then custom
 * and bundled genomes, searchable by id and name, plus "Local FASTA or 2bit
 * file…". Returns undefined when cancelled.
 */
export async function pickGenome(registry: GenomeRegistry, placeHolder = 'Select a genome', baseDir?: string): Promise<ResolvedGenome | undefined> {
  const recent = registry.getRecentIds();
  const all = registry.list();
  const items: GenomeItem[] = [];
  const defaultId = registry.getDefaultGenomeId();
  let defaultGenome: ResolvedGenome | undefined;
  if (defaultId) {
    try {
      defaultGenome = registry.resolve(defaultId, baseDir);
      items.push({ label: 'Default (igv.defaultGenome)', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: `$(star-full) ${defaultGenome.id}`, description: defaultGenome.name, detail: defaultGenome.source === 'local-file' ? defaultId : undefined, genomeId: '__default__', alwaysShow: true });
    } catch {
      // unknown default: ignore here, the caller warns
    }
  }
  items.push({ label: '$(file) Local FASTA or 2bit file…', detail: 'Use a reference sequence from disk (.fa/.fasta/.fna with .fai, or .2bit)', localFile: true, alwaysShow: true });
  if (recent.length > 0) {
    items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
    for (const id of recent) {
      const g = all.find((x) => x.id === id);
      if (g) items.push({ label: g.id, description: g.name, detail: g.description, genomeId: g.id });
    }
  }
  const custom = all.filter((g) => g.source === 'custom');
  if (custom.length > 0) {
    items.push({ label: 'Custom (igv.genomes.custom)', kind: vscode.QuickPickItemKind.Separator });
    for (const g of custom) items.push({ label: g.id, description: g.name, genomeId: g.id });
  }
  items.push({ label: 'All genomes', kind: vscode.QuickPickItemKind.Separator });
  for (const g of all.filter((g) => g.source !== 'custom')) {
    items.push({ label: g.id, description: g.name, detail: g.description, genomeId: g.id });
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked.localFile) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Use as genome',
      filters: { 'Reference sequence': ['fa', 'fasta', 'fna', 'gz', '2bit'], 'All files': ['*'] },
    });
    if (!uris?.[0]) return undefined;
    return registry.fromLocalFile(uris[0].fsPath);
  }
  if (!picked.genomeId) return undefined;
  if (picked.genomeId === '__default__' && defaultGenome) return defaultGenome;
  return registry.resolve(picked.genomeId, baseDir);
}

/**
 * Genome for a viewer opened from a data file: the workspace default if set
 * (no prompt), otherwise ask and offer to remember the choice.
 */
export async function chooseGenomeForNewViewer(registry: GenomeRegistry, baseDir?: string, options: { alwaysAsk?: boolean } = {}): Promise<ResolvedGenome | undefined> {
  const defaultId = registry.getDefaultGenomeId();
  if (defaultId && !options.alwaysAsk) {
    try {
      return registry.resolve(defaultId, baseDir);
    } catch {
      void vscode.window.showWarningMessage(
        `The default genome "${defaultId}" (setting igv.defaultGenome) is not known. Choose another genome.`,
      );
    }
  }
  const genome = await pickGenome(registry, options.alwaysAsk && defaultId ? 'Select a genome for the new viewer (your default is listed first)' : 'Select a genome for the new viewer', baseDir);
  if (!genome) return undefined;
  if (genome.source !== 'local-file') await registry.markUsed(genome.id);
  if (!defaultId && genome.source !== 'local-file') {
    const choice = await vscode.window.showInformationMessage(
      `Use ${genome.id} as the default genome for this workspace?`,
      'Yes',
      'Not now',
    );
    if (choice === 'Yes') await registry.setDefaultGenomeId(genome.id);
  }
  return genome;
}

interface TrackItem extends vscode.QuickPickItem {
  trackId: string;
}

export async function pickTracks(tracks: TrackState[], placeHolder = 'Select tracks to remove'): Promise<string[] | undefined> {
  if (tracks.length === 0) {
    void vscode.window.showInformationMessage('IGV: the active viewer has no tracks.');
    return undefined;
  }
  const items: TrackItem[] = tracks.map((t) => ({
    label: t.name,
    description: `${t.type}/${t.format}${t.error ? ' · failed' : ''}`,
    detail: t.displayPath,
    trackId: t.id,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder, canPickMany: true, ignoreFocusOut: true });
  if (!picked || picked.length === 0) return undefined;
  return picked.map((p) => p.trackId);
}

export async function askLocus(current?: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: 'Locus or gene name (1-based, inclusive; commas allowed)',
    placeHolder: 'chr17:7,668,402-7,687,550 or TP53',
    value: current,
    valueSelection: current ? [0, current.length] : undefined,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Enter a locus such as chr1:1,000-2,000'),
  });
  return value?.trim() || undefined;
}
