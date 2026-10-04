# Architecture

See the design spec (`IGV_VSCODE_DESIGN_SPEC.md`, §3) for the full picture. This document tracks what is implemented.

## Processes

- **Extension host** (`dist/extension.js`): runs where the files live (`extensionKind: workspace`). Owns viewers, genome lookup, file access and (from M4) the agent control channel.
- **Webview** (`dist/webview.js` + `media/igv.min.js`): one igv.js browser per panel. Talks to the host only over `postMessage`.
- **CLI / MCP** (`dist/cli.js`): separate process launched with the extension host's Node runtime (from M4).

## Host ↔ webview messaging

`src/shared/rpc.ts` implements a small request/response/event protocol used on both ends:

- `{kind:'req', id, method, params}` → `{kind:'res', id, result | error}`
- `{kind:'evt', event, payload}` for notifications.

Host → webview methods are `browser.create`, `browser.goto`, `browser.state`, `browser.destroy`, `tracks.add`, `tracks.remove`, `snapshot.svg`, `transport.probe` and `cache.stats` (`src/shared/webviewProtocol.ts`). Webview → host: `read` requests (byte ranges for the File-like shim) and the events `ready`, `log`, `error`, `alert`, `locuschange`.

`ViewerController` serializes all operations through a per-viewer promise queue and waits for the webview's `ready` event before the first call.

## Genomes

`GenomeRegistry` loads `media/genomes.json` (snapshot of igv-data's list, taken at build time). Every `createBrowser` receives a full `reference` object plus `genomeList` and `loadDefaultGenomes:false`, so igv never fetches igv.org and the process-wide genome cache quirk (spec §14 #5) cannot bite.

## Data access

```
TrackSpec ─► TrackResolver ─► ResolvedTrack (abs paths, type/format, index, options)
                                   │
                ViewerController registers each file with FileAccessBroker (per-viewer allow-list)
                                   │  config.url = {__igvVscodeFile: handle}
                                   ▼
                webview hydrateFileRefs() ─► File-like { name, size, slice().arrayBuffer() }
                                   │  rpc 'read' {fileId,start,end}
                                   ▼
                FileAccessBroker.read(): clamp, cap at maxChunkBytes, coalesce, positional read
```

- Reference objects go through the same path: `GenomeRegistry` emits `{__igvVscodeLocalPath}` markers for local FASTA/2bit files, and `ViewerController.localize()` swaps them for broker handles.
- The webview keeps a 64 MiB LRU of ranges ≤ 1 MiB keyed by (fileId, start, end).
- On the first genome load the controller probes whether `Uint8Array` survives `postMessage`; if not, the session falls back to base64.
- Metrics per viewer (`state --verbose`): requests, bytes, p50/p95 latency and per-file bytes read.

## Editors, sessions and restore

- `viewer/IgvEditorProvider.ts` implements `CustomReadonlyEditorProvider` for two viewTypes (`igv.editor`, default priority; `igv.editorOption`, option priority). Data files join the active viewer or become a viewer; `.igv.json` files become a viewer. Loading runs detached because VS Code starts the webview only after `resolveCustomEditor` returns.
- `session/SessionStore.ts` converts between viewer state and `.igv.json` (relative paths, igv-compatible shape, unknown keys preserved); `session/SessionService.ts` does file I/O, applies sessions to viewers and keeps restore snapshots in workspace state.
- Command-created panels are restored by a `WebviewPanelSerializer`: the webview state holds only a key; the matching snapshot (absolute paths) is in workspace state.

## Large files and remote data

- `tools/ToolDetector.ts` finds samtools/bgzip/tabix/bedtools/sort; `tools/jobs.ts` runs them with logging, progress and cancellation; `data/derivedDir.ts` decides where outputs go.
- `tools/LargeFilePolicy.ts` sits between the human/agent entry points and `ViewerController.addTracks`: it resolves each spec, and on `INDEX_REQUIRED` either runs the remedy (agents with `autoIndex`, `subsample`) or asks (humans), returning specs that resolve cleanly.
- `data/RemoteProxy.ts` fetches byte ranges on the host; `FileAccessBroker.registerUrl` exposes a URL as a broker handle so the same File-like shim serves remote files in proxy mode. `ViewerController.configureRemote` picks direct/proxy per `igv.remote.mode` and the session's remembered origins; `retryViaProxy` implements `auto`.
- `igv.transport.mode = webviewUri` hands igv `asWebviewUri` URLs instead of broker handles; adding a new directory reloads the webview and replays the session (`reloadWithRoots`).

## Agent control channel

- `agent/ControlServer.ts`: JSON-RPC 2.0 over a 0600 Unix socket / named pipe, token-checked per request. `agent/api.ts` implements the methods over the services above. `agent/AgentService.ts` owns the lifecycle, the instance registry (`agent/registry.ts`) and terminal environment injection.
- `agent/cli.ts` + `agent/client.ts`: the `igv-vscode` CLI (discovery: env vars → registry by cwd → `--instance`). `agent/mcp.ts`: MCP stdio server over the same client. `agent/CliInstaller.ts` writes the launcher that runs `dist/cli.js` with the extension host's runtime.
