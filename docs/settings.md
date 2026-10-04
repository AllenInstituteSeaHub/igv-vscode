# Settings reference

Generated from `package.json` by `npm run settings-doc`. All settings live under `igv.*`.

| Setting | Type | Default | Scope | Description |
|---|---|---|---|---|
| `igv.agent.enabled` | boolean | `true` | window | Expose the local control channel used by the `igv-vscode` CLI and MCP server (Unix socket / named pipe, token-authenticated, never a TCP port). Always off in Restricted Mode. Changes take effect after a window reload. |
| `igv.agent.snapshotDir` | string | (empty) | resource | Directory for snapshots saved without an explicit path. Relative to the workspace. Default: .igv/snapshots/ in the workspace, falling back to global storage. |
| `igv.alignment.samplingDepth` | number | `100` | resource | Maximum reads kept per sampling window in alignment tracks. |
| `igv.alignment.samplingWindowSize` | number | `100` | resource | Sampling window size (bp) for alignment downsampling. |
| `igv.alignment.visibilityWindow` | number | `30000` | resource | Alignment tracks only load reads when the view is narrower than this many base pairs (igv.js default 30000). Wider views show a “zoom in” message. Per-track override: `options.visibilityWindow`. |
| `igv.defaultGenome` | string | (empty) | resource | Genome used when a viewer is opened without an explicit genome, for example `hg38`. Leave empty to be asked each time. Set per workspace. |
| `igv.genomes.custom` | array | `[]` | resource | User-defined genomes. Each entry needs an `id` and a sequence (`fastaPath`/`fastaURL` or `twoBitPath`/`twoBitURL`); optional `name`, `indexPath`, `cytobandPath`, `aliasPath`, `chromosomeOrder` and `tracks` (array of `{path|url, name}`). Relative paths resolve against the workspace folder. |
| `igv.largeFile.derivedDir` | string | (empty) | resource | Where generated indexes, compressed copies and subsamples go when the data file's directory is not writable (e.g. `/data` on CodeOcean). Relative paths resolve against the workspace. Default: the extension's global storage. |
| `igv.largeFile.unindexedMaxBytes` | number | `20971520` | resource | Unindexed BAM/CRAM and uncompressed text files up to this size (bytes) are loaded whole. Larger files need an index. |
| `igv.openBehavior` | `addToActive` / `newViewer` | `addToActive` | resource | What happens when a data file is opened with IGV while a viewer is already open. |
| `igv.remote.allowHttp` | boolean | `false` | resource | Allow plain http:// URLs to be fetched directly by the viewer (adds http: to the webview's connect-src). https:// always works. Not needed in proxy mode. |
| `igv.remote.mode` | `direct` / `proxy` / `auto` | `direct` | resource | How http(s) tracks and indexes are fetched. |
| `igv.remote.timeoutMs` | number | `30000` | resource | Timeout for proxied remote requests. |
| `igv.snapshot.scale` | number | `2` | resource | Device scale factor for PNG snapshots. |
| `igv.tools.paths` | object | `{}` | machine-overridable | Absolute paths of external tools when they are not on PATH, e.g. `{ "samtools": "/opt/conda/bin/samtools" }`. `${workspaceFolder}` is substituted. Keys: samtools, bgzip, tabix, bedtools, sort. |
| `igv.transport.cacheMiB` | number | `64` | application | Per-viewer cache of recently read byte ranges, in MiB. |
| `igv.transport.maxChunkBytes` | number | `8388608` | application | Largest byte range sent from the extension host to the viewer in one message. Larger reads are split into chunks. Requires a window reload to take effect. |
| `igv.transport.mode` | `shim` / `webviewUri` | `shim` | resource | How local files reach igv.js. Applies to viewers opened after the change. |
| `igv.variant.visibilityWindow` | number | `1000000` | resource | Variant tracks only load when the view is narrower than this many base pairs. |

## Commands

- **IGV: New Viewer** (`igv.newViewer`)
- **IGV: Add to Viewer** (`igv.addToViewer`)
- **IGV: Open in New Viewer** (`igv.openInNewViewer`)
- **IGV: Go to Locus…** (`igv.gotoLocus`)
- **IGV: Set Genome…** (`igv.setGenome`)
- **IGV: Remove Track…** (`igv.removeTrack`)
- **IGV: Show Output** (`igv.showOutput`)
- **IGV: Go to Locus from Selection** (`igv.gotoLocusFromSelection`)
- **IGV: Save Session…** (`igv.saveSession`)
- **IGV: Load Session…** (`igv.loadSession`)
- **IGV: Export Snapshot…** (`igv.exportSnapshot`)
- **IGV: Reopen as Text** (`igv.reopenAsText`)
- **IGV: Load Track from URL…** (`igv.loadTrackFromUrl`)
- **IGV: Index File…** (`igv.indexFile`)
- **IGV: Subsample BAM…** (`igv.subsampleBam`)
- **IGV: Install CLI on PATH** (`igv.installCli`)
- **IGV: Copy MCP Setup Command** (`igv.copyMcpSetup`)
- **IGV: Add Agent Skill to Workspace** (`igv.addAgentSkill`)
