/**
 * Marker objects used inside igv configs while they travel between modules.
 *
 * - `LocalPathMarker` holds an absolute path on the extension host. It never
 *   leaves the host: ViewerController replaces it with a `FileRefMarker`.
 * - `FileRefMarker` holds an opaque broker handle. The webview turns it into
 *   a File-like (webview/FileLike.ts). The webview never sees absolute paths.
 */

export interface FileHandleInfo {
  fileId: string;
  name: string;
  size: number;
  displayPath: string;
}

export interface LocalPathMarker {
  __igvVscodeLocalPath: string;
}

export interface FileRefMarker {
  __igvVscodeFile: FileHandleInfo;
}

export function localPath(absPath: string): LocalPathMarker {
  return { __igvVscodeLocalPath: absPath };
}

export function isLocalPathMarker(v: unknown): v is LocalPathMarker {
  return typeof v === 'object' && v !== null && typeof (v as LocalPathMarker).__igvVscodeLocalPath === 'string';
}

export function fileRef(handle: FileHandleInfo): FileRefMarker {
  return { __igvVscodeFile: handle };
}

export function isFileRefMarker(v: unknown): v is FileRefMarker {
  const m = (v as FileRefMarker | null)?.__igvVscodeFile;
  return typeof v === 'object' && v !== null && typeof m === 'object' && m !== null && typeof m.fileId === 'string';
}

/** Deep-walks `value`, replacing local-path markers via `replace` (async). Arrays and plain objects only. */
export async function replaceLocalPaths<T>(value: T, replace: (absPath: string) => Promise<unknown>): Promise<T> {
  if (isLocalPathMarker(value)) return (await replace(value.__igvVscodeLocalPath)) as T;
  if (Array.isArray(value)) return (await Promise.all(value.map((v) => replaceLocalPaths(v, replace)))) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = await replaceLocalPaths(v, replace);
    return out as T;
  }
  return value;
}

/** Collects every local path marker in a value. */
export function collectLocalPaths(value: unknown, out: string[] = []): string[] {
  if (isLocalPathMarker(value)) out.push(value.__igvVscodeLocalPath);
  else if (Array.isArray(value)) value.forEach((v) => collectLocalPaths(v, out));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((v) => collectLocalPaths(v, out));
  return out;
}
