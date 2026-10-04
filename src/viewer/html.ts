import * as vscode from 'vscode';

export interface ViewerHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  viewerId: string;
  /** Extra `connect-src` sources (spec §10): cspSource in webviewUri mode, `http:` when allowed. */
  extraConnect?: string[];
}

export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/**
 * Builds the webview document. CSP follows spec §10, plus 'wasm-unsafe-eval'
 * in script-src: igv.js decodes CRAM (rANS/bzip2 codecs) with WebAssembly,
 * which the spec's CSP blocked ("CompileError: … violates … script-src").
 */
export function getViewerHtml(opts: ViewerHtmlOptions): string {
  const { webview, extensionUri } = opts;
  const nonce = makeNonce();
  const igvUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'igv.min.js'));
  const mainUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'styles.css'));
  const extraConnect = (opts.extraConnect ?? []).join(' ');
  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource} data:`,
    `connect-src https: ${extraConnect}`.trim(),
    `worker-src blob:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IGV ${escapeHtml(opts.viewerId)}</title>
<link rel="stylesheet" href="${styleUri}">
</head>
<body data-viewer-id="${escapeHtml(opts.viewerId)}">
<div id="igv-frame">
  <div id="igv-root" role="application" aria-label="IGV genome browser ${escapeHtml(opts.viewerId)}"></div>
  <div id="igv-status" role="status" aria-live="polite">Loading IGV…</div>
</div>
<script nonce="${nonce}" src="${igvUri}"></script>
<script nonce="${nonce}" src="${mainUri}"></script>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
