import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Where snapshots go when no path is given (spec §6.4): `igv.agent.snapshotDir`,
 * else `<workspace>/.igv/snapshots/`, else global storage.
 */
export async function defaultSnapshotDir(context: vscode.ExtensionContext): Promise<string> {
  const configured = vscode.workspace.getConfiguration('igv').get<string>('agent.snapshotDir')?.trim();
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const candidates = [
    configured ? (path.isAbsolute(configured) ? configured : ws ? path.join(ws, configured) : undefined) : undefined,
    ws ? path.join(ws, '.igv', 'snapshots') : undefined,
    path.join(context.globalStorageUri.fsPath, 'snapshots'),
  ].filter((p): p is string => !!p);
  for (const dir of candidates) {
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.access(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // try the next one
    }
  }
  return candidates[candidates.length - 1]!;
}

export function snapshotFileName(viewerId: string, format: 'png' | 'svg'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${viewerId}-${ts}.${format}`;
}
