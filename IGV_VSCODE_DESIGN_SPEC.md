# IGV for VS Code: Design Plan and Build Specification

**Audience:** a coding agent (Claude Code) that will build this extension end to end.
**Status:** approved design. The core data-transport approach was validated in a feasibility spike on CodeOcean (code-server 4.129.0 / VS Code 1.129.0, igv.js 3.8.9). The spike findings are summarized in §14.

---

## 0. How to work through this document

1. Read the whole spec before writing code. §3 (architecture), §6 (agent API) and §14 (spike lessons) matter most.
2. Build milestone by milestone (§12). Do not start a milestone until the previous one meets its acceptance criteria.
3. Keep `PROGRESS.md` at the repo root. For each milestone, record what was built, the test results, deviations from this spec and why, and open issues.
4. When a decision is not covered here, choose the simplest option consistent with the principles in §1. Record the choice in `docs/DECISIONS.md`.
5. You cannot see webviews. When visual confirmation is needed, rely on the automated snapshot tests (§11). Then stop and ask the human to check specific things, using a short, explicit checklist.
6. No stubs or TODO placeholders in shipped code paths. If something is out of scope, it must fail with a clear message.

---

## 1. Product summary and principles

**What it is:** a general-purpose VS Code extension that embeds the igv.js genome browser. It lets people and AI agents view alignments, coverage, variants, annotations and reference sequence next to their code.

**Principles**

1. **Runs wherever VS Code runs with a Node extension host.** That includes:
   - desktop VS Code (macOS, Linux, Windows)
   - Remote-SSH, WSL and Dev Containers
   - code-server, including locked-down hosted platforms like CodeOcean

   The extension must never require serving data over an HTTP port to the browser.
2. **Large files are streamed, not loaded.** Indexed formats are read by byte range around the current view. Unindexed large files get a clear path forward: index, compress+index, or subsample. They are never silently loaded whole.
3. **Agent-first control surface.** Every viewer operation a human can do from the UI, an agent can do from a terminal via a CLI or MCP tools. The agent can also get back a picture of what is shown.
4. **igv.js unmodified.** Bundle the official `igv` npm package, pinned. Never fork or patch it. Work around quirks in our own code.
5. **No surprise network dependencies.** The extension works offline with local references. Remote resources are optional and fail gracefully.
6. **Safe by default.** The webview can only read files that were explicitly added to that viewer. The control channel is local-only and token-authenticated.

**Non-goals for v1:**

- vscode.dev / github.dev (browser-only extension host with no Node `fs`)
- Editing data files
- BLAT, Hi-C and juicebox views
- Multi-user collaboration
- Cloud-credential flows for `s3://` and `gs://`. Presigned HTTPS URLs work. Native schemes are v2.

### 1.1 Naming and identifiers (decided)

| Item | Value |
|---|---|
| Project / repo name | `igv-vscode` (GitHub: `github.com/<org>/igv-vscode`) |
| `package.json` `name` | `igv-vscode` |
| `package.json` `displayName` | `IGV Viewer for VS Code (unofficial)` |
| `package.json` `publisher` | `<publisher>`, the Marketplace and Open VSX publisher id. **Ask the human for this value in M0. Do not invent one.** Until then, use the placeholder `igv-vscode-dev`. |
| Full extension id | `<publisher>.igv-vscode` |
| CLI command | `igv-vscode` |
| Settings, command and view prefix | `igv.` (e.g. `igv.defaultGenome`, `igv.newViewer`) |
| Socket / registry / storage names | `igv-vscode-*`, `~/.igv-vscode/` |
| Output channel | `IGV` |
| Marketplace keywords | `igv`, `igv.js`, `genome browser`, `genomics`, `bioinformatics`, `bam`, `cram`, `vcf`, `bigwig`, `alignment`, `sequencing` |
| Categories | `Visualization`, `Data Science` |

**Branding rules**

- The README's first paragraph must state that this is an unofficial, community project, not affiliated with or endorsed by the IGV team (Broad Institute / UC San Diego).
- Cite igv.js (Robinson et al., *Bioinformatics* 39(1), 2023, btac830) and IGV.
- Do not use the IGV logo. Create a simple original icon (e.g. stylized aligned reads) as `media/icon.png` (128×128).
- Before the first publish (M6), confirm `igv-vscode` is unclaimed on the VS Marketplace and Open VSX. If it is taken, stop and ask the human.

---

## 2. User stories (acceptance-level)

**Humans**

- **H1:** I click a `.bam` in the Explorer. An IGV viewer opens with that track, the matching index is found automatically, and I'm asked which genome to use (or it is remembered).
- **H2:** I multi-select a BAM, a bigWig and a BED, choose "IGV: Add to Viewer", and all three appear in the active viewer.
- **H3:** I select `chr17:7,668,402-7,687,550` (or a VCF line, or a BED line) in any editor, run "IGV: Go to Locus from Selection", and the viewer navigates there.
- **H4:** I open a 50 GB BAM with a `.bai`. Navigating is responsive and only the bytes for the visible window are read.
- **H5:** I open a 500 MB unindexed BED. The extension refuses to load it whole and offers:
  - "Sort, compress and index (requires bgzip/tabix)"
  - "Load anyway"
  - "Cancel"
- **H6:** I save the view as `analysis.igv.json`, commit it, and a colleague opens it on their machine or on code-server and sees the same view. Paths resolve relative to the session file.
- **H7:** The extension behaves identically on my laptop and on CodeOcean.

**Agents**

- **A1:** From a terminal: `igv-vscode open --genome hg38 --locus chr8:127,736,588-127,739,371 tumor.bam normal.bam peaks.bed`. A viewer opens beside the editor (without stealing focus). The command returns JSON with a viewer id once the data has loaded.
- **A2:** `igv-vscode goto --viewer v1 chr8:127,740,000` navigates.
- **A3:** `igv-vscode snapshot --viewer v1 --format png --out view.png` writes an image of exactly what is displayed, so the agent can inspect it.
- **A4:** `igv-vscode state --viewer v1` returns the genome, loci and tracks as JSON.
- **A5:** Claude Code configured with `claude mcp add igv -- igv-vscode mcp` can call `igv_open`, `igv_goto`, `igv_snapshot` and so on, and receives the snapshot as an image.
- **A6:** Without the CLI, an agent can write an `.igv.json` session file and run `code analysis.igv.json`. This is the zero-dependency fallback.

---

## 3. Architecture

```
┌─────────────────────────── Extension host (Node, runs where files live) ───────────────────────────┐
│                                                                                                      │
│  Commands / Menus / CustomEditors ──┐                                                               │
│                                     ▼                                                               │
│  ControlServer (JSON-RPC over UDS/pipe) ──► ViewerManager ──► ViewerController (one per panel)      │
│        ▲                                     │                    │   ▲                              │
│        │                                     │                    │   │ RPC over postMessage         │
│  CLI (igv-vscode) / MCP server               │                    ▼   │                              │
│  (separate process, same Node binary)        │          ┌──────── Webview ────────┐                 │
│                                              │          │  igv.js (bundled)        │                 │
│  GenomeRegistry   TrackResolver              │          │  BrowserAdapter          │                 │
│  FileAccessBroker (range reads, allow-list)◄─┴──────────│  FileLike shim / cache   │                 │
│  RemoteProxy (optional range fetch)                     │  Snapshot (SVG→PNG)      │                 │
│  SessionStore    ToolDetector (samtools, tabix…)        └──────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Extension host modules (TypeScript, `src/`)

| Module | Responsibility |
|---|---|
| `extension.ts` | Activation and wiring. Registers commands, custom editors, the serializer, the control server and the CLI shim. |
| `viewer/ViewerManager.ts` | Creates, tracks, names and disposes viewers. Tracks the "active viewer" (last focused, else most recently created). Resolves `--viewer` targets. |
| `viewer/ViewerController.ts` | Owns one `WebviewPanel`. Runs a typed RPC to the webview and holds the authoritative viewer state (genome, loci, tracks). Serializes operations through a per-viewer queue. |
| `data/FileAccessBroker.ts` | Serves byte ranges with `fs.promises.open` + positional `read`. Keeps a per-viewer allow-list and an LRU of open file handles. Chunks large reads. Records metrics. |
| `data/RemoteProxy.ts` | Optional. Fetches HTTP(S) byte ranges from the extension host for URLs the browser cannot reach (CORS or network). |
| `data/TrackResolver.ts` | Turns a path or URL plus options into an igv track config. Infers type and format, discovers the index, applies large-file policy (§5) and defaults. |
| `genome/GenomeRegistry.ts` | Bundled genome list snapshot, optional refresh from GitHub, user-defined genomes, local FASTA and 2bit references, and per-workspace default genome. |
| `session/SessionStore.ts` | Converts between igv session JSON and `.igv.json` files. Rewrites paths to and from relative form. Restores viewers on reload. |
| `agent/ControlServer.ts` | Local JSON-RPC 2.0 endpoint (§6.2), auth token and instance registry. |
| `agent/cli.ts` | The `igv-vscode` CLI (separate bundle). |
| `agent/mcp.ts` | MCP stdio server (separate bundle; invoked as `igv-vscode mcp`). |
| `agent/CliInstaller.ts` | Generates launcher scripts and puts them on the integrated terminal `PATH` (§6.4). |
| `tools/ToolDetector.ts` | Detects `samtools`, `bgzip`, `tabix` and `bedtools` on PATH or in configured paths. Runs indexing, compression and subsampling jobs with progress and cancellation. |
| `ui/` | Status bar locus item, quick picks (genome, viewer), the locus-from-selection parser and notifications. |

### 3.2 Webview modules (`webview/`, bundled separately)

| Module | Responsibility |
|---|---|
| `main.ts` | Boots and handles RPC. |
| `BrowserAdapter.ts` | The only module that touches the igv API. Responsibilities: create/destroy the browser, load and remove tracks, navigate, read state, `toSVG`. Creates a fresh container element for every browser instance (§14). |
| `FileLike.ts` | Builds File-like objects that igv.js reads via `slice(start,end).arrayBuffer()` (§4.1). Holds a small LRU cache. |
| `Snapshot.ts` | `toSVG()`, then rasterizes to PNG on a canvas at the configured scale. |
| `rpc.ts` | Request/response with ids, timeouts and error propagation. |

### 3.3 Process and placement rules

- `package.json`:
  - `"extensionKind": ["workspace"]`, so the extension always runs where the files are.
  - `"capabilities": { "untrustedWorkspaces": { "supported": "limited", "description": "Agent control API disabled in Restricted Mode" } }`.
  - `"virtualWorkspaces": false`.
- One igv browser per webview panel. Multiple panels are allowed.
- Panels opened by agents use `ViewColumn.Beside` with `preserveFocus: true`. Panels opened by humans use the active column.
- Use `retainContextWhenHidden: true`. Viewers hold live state, and a reload costs network and disk reads. Add a `WebviewPanelSerializer` so viewers survive a window reload, restored from the last session state.

---

## 4. Data access

### 4.1 Local files: File-like shim (default, required)

igv.js 3.8.9 treats any object as a local file if it has an own `name` property and `slice` and `arrayBuffer` functions. It reads via `file.slice(start, end).arrayBuffer()`. Text loaders fall through to the same path. The spike confirmed this works for:

- BAM+BAI
- indexed FASTA
- bigWig
- unindexed BED and GFF3
- SVG export

```ts
// webview/FileLike.ts (shape, not final code)
export function fileLike(handle: FileHandleInfo, rpc: Rpc): FileLike {
  const read = (start: number, end: number) =>
    rpc.request<Uint8Array>('read', { fileId: handle.fileId, start, end }).then(u8 =>
      u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  return {
    name: handle.name,              // igv uses this for format inference and labels
    size: handle.size,
    slice: (start: number, end?: number) => ({
      arrayBuffer: () => read(start, Number.isFinite(end) ? Math.min(end!, handle.size) : handle.size),
    }),
    arrayBuffer: () => read(0, handle.size),
  };
}
```

**Rules**

- The webview never sees absolute paths for reads. It uses opaque `fileId`s issued by the broker when a track is added. The broker maps `fileId → absolute path` per viewer. A read for an unknown `fileId` is rejected.
- Every track also keeps a `displayPath` (workspace-relative where possible) for labels and state reporting.
- **Broker reads:**
  - Clamp to the file size.
  - Coalesce overlapping in-flight reads for the same file.
  - Split any read larger than `igv.transport.maxChunkBytes` (default 8 MiB) into sequential chunks and reassemble them in the webview.
  - Allow full concurrency. igv issues parallel requests, and latency is dominated by the code-server round trip (~30 ms), not disk.
- **Webview LRU cache:** cache ranges ≤ 1 MiB by `(fileId, start, end)`, 64 MiB total. This removes repeated header and index reads.
- **Payloads:**
  - Send binary as `Uint8Array`. The spike confirmed it arrives as binary on code-server.
  - At startup, run a capability probe. If binary does not round-trip, switch the whole session to base64 and log a warning.
- **Metrics** per viewer, exposed via `state --verbose`: requests, bytes, p50/p95 latency, and bytes read as a percentage of file size.

### 4.2 Local files: `asWebviewUri` mode (optional, experimental)

The setting `igv.transport.mode` takes the values `"shim"` (default) and `"webviewUri"`.

In `webviewUri` mode:

- Add each track file's directory to the panel's `localResourceRoots`. This requires recreating the panel options, so the viewer reloads its session.
- Pass `asWebviewUri` URLs to igv.
- Add `cspSource` to `connect-src`.

This mode exists because the spike showed it serves correct HTTP 206 ranges on code-server ≥ 4.129. It is not the default, for two reasons:

- It depends on the host version (range support landed in VS Code around April 2026).
- It widens readable roots to whole directories.

Ship it behind the setting with an integration test, and document the trade-off.

### 4.3 Remote URLs

- `http(s)://` tracks, genomes and indexes are passed to igv as URLs. They are fetched by the **user's browser**, which in code-server is not the server. CORS and Range support are required (cite the igv.js data-server requirements in the docs).
- The setting `igv.remote.mode` takes `"direct"` (default), `"proxy"` or `"auto"`.
  - **`proxy`:** the URL is wrapped in a File-like whose reads go to `RemoteProxy`. RemoteProxy issues `Range` GETs from the extension host with Node `fetch`, using an `AbortController` timeout. This bypasses browser CORS and browser network restrictions, and uses the server's network instead.
    - The file size comes from a `HEAD` or from `Content-Range` on the first ranged GET.
    - Servers that ignore `Range` and return `200` with the full body are detected. Abort if the size exceeds the large-file limit, and report the problem.
  - **`auto`:** try direct. On a load error that looks like CORS or network, retry the track once via proxy and remember the result per origin for the session.
- `s3://` and `gs://`: v1 rejects these with a clear message that suggests a presigned HTTPS URL.

### 4.4 Index discovery (TrackResolver)

For data file `X`, look in the same directory for these candidates, in order:

| Data | Index candidates |
|---|---|
| `X.bam` | `X.bam.bai`, `X.bai`, `X.bam.csi` |
| `X.cram` | `X.cram.crai`, `X.crai` |
| `X.vcf.gz`, `X.bed.gz`, `X.gff3.gz`, `X.gtf.gz`, `X.bedgraph.gz`, other bgzipped text | `X.gz.tbi`, `X.gz.csi` |
| `X.fa`, `X.fasta`, `X.fna` | `X.fa.fai` (also `.gzi` for bgzipped FASTA) |

- Users and agents can always override with an explicit `index`.
- For URLs, append the same suffixes. Probe with a ranged GET of 1 byte, via proxy if configured.

---

## 5. Large-file policy

igv.js already handles big indexed data:

- It reads only index-selected blocks.
- `visibilityWindow` caps the span it will load.
- Alignment tracks downsample (`samplingDepth` per `samplingWindowSize`).

Our job is to make sure files reach igv in an indexed form, and to set sensible defaults.

### 5.1 Classification at load time (TrackResolver)

| Situation | Behaviour |
|---|---|
| Indexed binary or tabix format, any size | Load with streaming. |
| BAM/CRAM with no index | If size ≤ `igv.largeFile.unindexedMaxBytes` (default 20 MiB), load with `indexed:false`. Otherwise prompt: **Index with samtools** (if detected) / **Subsample…** / **Load anyway** / **Cancel**. Agents: return error code `INDEX_REQUIRED` with a suggested command; `--auto-index` permits running it. |
| Text annotation or variant file (BED, GFF, GTF, VCF, bedGraph) uncompressed or unindexed | If ≤ limit, load whole. Otherwise prompt **Sort+bgzip+tabix** (needs bgzip and tabix; also `sort` or `bedtools sort`) / **Load anyway** / **Cancel**. |
| bigWig / bigBed / TDF | Load as is. These are always internally indexed. |
| FASTA without `.fai` | ≤ 10 MiB: load unindexed. Otherwise offer `samtools faidx`. |
| CRAM | Requires a reference whose sequence names match. If the current genome has no sequence source, error with `REFERENCE_REQUIRED`. |

### 5.2 Generated artifacts

- Write indexes next to the source file if the directory is writable. Otherwise use `igv.largeFile.derivedDir`, which defaults to the extension's global storage path, keyed by a hash of the source path, size and mtime.
- On CodeOcean, `/data` is read-only. The fallback must work there. Prefer `/results` or the workspace only if the user configures it.
- Subsampling uses `samtools view -b -s <seed>.<fraction>` (or a region subset with `-L`/region args), followed by `samtools index`.
  - The UI asks for a fraction or a target read count, and optionally a region.
  - The output goes to the derived dir and is loaded as a new track named `<name> (subsample 10%)`.
- Every job is cancellable, shows progress, and logs the exact command to the "IGV" output channel.
- If the tool is not available, explain how to install it. Do not offer to run it.

### 5.3 Defaults

| Setting | Default | Notes |
|---|---|---|
| `igv.alignment.visibilityWindow` | 30000 | The igv default; surface it. Per-track override. |
| `igv.alignment.samplingDepth` | 100 | |
| `igv.alignment.samplingWindowSize` | 100 | |
| `igv.variant.visibilityWindow` | 1000000 | |
| `igv.largeFile.unindexedMaxBytes` | 20 MiB | |

When the view is wider than an alignment track's visibility window, the track shows igv's "zoom in" state. The agent `state` output must report per track `{ inView: boolean, reason?: "outsideVisibilityWindow" }`, so agents understand blank tracks. (The spike showed that a 50 kb view read 0 BAM bytes because of this window.)

### 5.4 Performance targets (validated in M3)

| Scenario | Target |
|---|---|
| BAM ≥ 5 GB with index: open plus first render at a 2 kb locus | < 3 s local, < 5 s code-server |
| Subsequent 2 kb navigations | median < 500 ms, p95 < 1.5 s |
| Bytes read for 10 navigations | < 1 % of file size |
| BAI up to 50 MB | Loaded once per viewer and cached (index files are read whole by igv) |

---

## 6. Agent interface

### 6.1 Layers

1. **Session files (zero dependency):** the agent writes `.igv.json` and runs `code file.igv.json`. This works in desktop terminals and in code-server integrated terminals, where `code` is the remote CLI.
2. **CLI `igv-vscode`:** the primary interface. It talks to the running extension over a local control channel.
3. **MCP server `igv-vscode mcp`:** a thin wrapper over the same RPC, for Claude Code and other MCP clients.
4. **Optional (P2):** register the MCP server with VS Code's MCP provider API when available (feature-detect `vscode.lm?.registerMcpServerDefinitionProvider`), so VS Code's built-in agents can also use it.

### 6.2 Control channel

- **Transport:** JSON-RPC 2.0, newline-delimited JSON, over:
  - a Unix domain socket on Linux/macOS: `$XDG_RUNTIME_DIR` or `os.tmpdir()`, `igv-vscode-<random>.sock`, mode `0600`
  - a named pipe on Windows: `\\.\pipe\igv-vscode-<random>`

  Never TCP. This works on CodeOcean because nothing is exposed to the browser or the network.
- **Auth:** a 32-byte random token. Every request includes `"token"`. Constant-time compare.
- **Discovery** (the CLI tries these in order):
  1. Environment variables `IGV_VSCODE_ENDPOINT` and `IGV_VSCODE_TOKEN`, injected into integrated terminals via `context.environmentVariableCollection`. They apply to newly opened terminals; document this.
  2. Instance registry: `~/.igv-vscode/instances/<id>.json` with mode `0600`, containing `{ endpoint, token, pid, workspaceFolders[], startedAt, lastActiveAt }`.
     - Written on activation and removed on deactivate.
     - Stale entries (dead pid or unreachable endpoint) are pruned by the CLI.
     - The CLI picks the instance whose workspace folder contains the current working directory. Otherwise it picks the most recently active, or uses an explicit `--instance <id>`.

  This handles agents not launched from an integrated terminal, such as Claude Code started in an external terminal or by an IDE integration.
- **Disabled:** in Restricted Mode, or when `igv.agent.enabled` is `false`. The CLI then exits with code `3` and a message.

### 6.3 RPC methods

All coordinates in the API are **1-based, inclusive, display convention** (as IGV shows them). Locus strings accept commas.

| Method | Params | Result |
|---|---|---|
| `ping` | — | `{ version, igvVersion, vscodeVersion, host: "desktop" \| "remote" \| "code-server", workspaceFolders }` |
| `viewer.open` | `{ name?, genome?, locus?: string \| string[], tracks?: TrackSpec[], reuse?: "new" \| "active" \| "byName", show?: boolean, waitForRender?: boolean (default true), timeoutMs? }` | `ViewerState & { settled: boolean, warnings: string[] }` |
| `viewer.list` | — | `ViewerSummary[]` (`id, name, genome, loci, trackCount, visible, active`) |
| `viewer.state` | `{ viewer?, verbose? }` | `ViewerState` |
| `viewer.goto` | `{ viewer?, locus: string \| string[], waitForRender? }` | `ViewerState` |
| `viewer.setGenome` | `{ viewer?, genome }` | `ViewerState` (tracks are cleared unless `keepTracks: true` and the names are compatible) |
| `tracks.add` | `{ viewer?, tracks: TrackSpec[], waitForRender? }` | `{ added: TrackState[], warnings }` |
| `tracks.remove` | `{ viewer?, names?: string[], ids?: string[] }` | `{ removed: string[] }` |
| `tracks.update` | `{ viewer?, id, options: Partial<IgvTrackOptions> }` | `TrackState` |
| `viewer.snapshot` | `{ viewer?, format: "png" \| "svg", out?: string, scale?: number (PNG, default 2), inline?: boolean }` | `{ path, format, width, height, base64? }` |
| `session.save` | `{ viewer?, path, relativePaths?: boolean (default true) }` | `{ path }` |
| `session.load` | `{ path, viewer?, reuse? }` | `ViewerState` |
| `viewer.close` | `{ viewer? \| all: true }` | `{ closed: string[] }` |
| `genomes.list` | `{ filter? }` | `{ id, name, source }[]` |

**`viewer` targeting:** an id (`v1`, `v2`, …) or a name. If omitted, use the active viewer. If none exists, `viewer.open` creates one, and other methods return `NO_VIEWER`.

**TrackSpec**

```jsonc
{
  "path": "relative/or/absolute.bam",   // or "url": "https://..."
  "index": "optional/explicit.bai",
  "name": "Tumor",
  "type": "alignment",                   // optional; inferred
  "format": "bam",                       // optional; inferred
  "options": { "color": "#c00", "height": 300, "displayMode": "SQUISHED",
               "visibilityWindow": 100000 },   // passed through to igv after validation
  "autoIndex": false,                    // allow running samtools/tabix if needed
  "subsample": { "fraction": 0.1, "seed": 42 }  // optional: create and load a subsample instead
}
```

Relative paths resolve against the CLI's current working directory. The CLI sends absolute paths.

**ViewerState**

```jsonc
{
  "id": "v1", "name": "tumor-vs-normal",
  "genome": { "id": "hg38", "name": "Human (GRCh38/hg38)", "source": "bundled-list" },
  "loci": ["chr8:127,736,588-127,739,371"],
  "tracks": [
    { "id": "t1", "name": "Tumor", "type": "alignment", "format": "bam",
      "source": "/abs/tumor.bam", "displayPath": "data/tumor.bam",
      "indexed": true, "inView": true, "error": null }
  ],
  "metrics": { /* verbose only, §4.1 */ }
}
```

**`waitForRender` semantics.** The call resolves when all of these are true:

1. The igv promises for the operation have resolved.
2. No read RPCs have been in flight for 250 ms.
3. igv reports no pending track loads.

It resolves with `settled:false` after `timeoutMs` (default 30 s).

**Errors.** JSON-RPC error with `data.code` set to one of:

`NO_VIEWER`, `VIEWER_NOT_FOUND`, `FILE_NOT_FOUND`, `UNSUPPORTED_FORMAT`, `INDEX_REQUIRED`, `REFERENCE_REQUIRED`, `GENOME_NOT_FOUND`, `GENOME_MISMATCH`, `REMOTE_UNREACHABLE`, `TOOL_MISSING`, `TIMEOUT`, `AGENT_DISABLED`, `INTERNAL`

Include `data.hint` with a concrete fix, for example the exact `samtools index` command.

### 6.4 CLI `igv-vscode`

**Launching without a system Node.** The spike found no `node` on PATH on CodeOcean. Use the extension host's runtime:

- At activation, `CliInstaller` writes launcher scripts to `globalStorageUri/bin/`, with the absolute path of `process.execPath` baked in:
  - `igv-vscode` (POSIX shell):
    ```sh
    #!/bin/sh
    ELECTRON_RUN_AS_NODE=1 exec "<execPath>" "<extensionPath>/dist/cli.js" "$@"
    ```
  - `igv-vscode.cmd` (Windows) with the equivalent.
- `ELECTRON_RUN_AS_NODE=1` makes the desktop Electron binary behave as Node. It is harmless for code-server's plain Node.
- Regenerate the scripts on each activation, because the paths change with updates.
- Prepend `globalStorageUri/bin` to `PATH` via `environmentVariableCollection` for new integrated terminals.
- Command **"IGV: Install CLI on PATH"** symlinks the launcher into `~/.local/bin` (POSIX) or prints instructions (Windows), for agents launched outside integrated terminals.

**Command surface**

```
igv-vscode open [FILES...] [--genome G] [--locus L]... [--name N] [--new | --reuse-active]
                [--track-opt NAME.key=value]... [--auto-index] [--no-wait] [--timeout S]
igv-vscode goto [--viewer V] LOCUS [LOCUS...]
igv-vscode add  [--viewer V] FILES... [--index FILE=IDX]... [--auto-index]
igv-vscode remove [--viewer V] NAME...
igv-vscode state [--viewer V] [--verbose]
igv-vscode list
igv-vscode snapshot [--viewer V] [--format png|svg] [--out PATH] [--scale N]
igv-vscode session save [--viewer V] PATH | session load PATH
igv-vscode close [--viewer V | --all]
igv-vscode genomes [FILTER]
igv-vscode ping
igv-vscode mcp                      # run MCP stdio server
igv-vscode --help / <cmd> --help    # complete, example-rich help text
```

- **Output:** human-readable by default, `--json` for machine use. When stdout is not a TTY, default to `--json`. Agents should always get JSON.
- **Exit codes:**
  - `0` ok
  - `1` usage error
  - `2` operation error (with the JSON error)
  - `3` no reachable instance or agent API disabled
  - `4` timeout
- `snapshot` without `--out` writes to `igv.agent.snapshotDir` (default: workspace `.igv/snapshots/`, falling back to global storage) as `<viewer>-<timestamp>.png`, and prints the path.

### 6.5 MCP server

- Use `@modelcontextprotocol/sdk` (stdio transport) in `dist/cli.js`, started by `igv-vscode mcp`. It uses the same discovery and RPC client as the CLI.
- **Tools:** `igv_open`, `igv_goto`, `igv_add_tracks`, `igv_remove_tracks`, `igv_state`, `igv_list_viewers`, `igv_snapshot`, `igv_save_session`, `igv_load_session`, `igv_close`, `igv_list_genomes`.
  - Schemas mirror §6.3.
  - Descriptions must state the coordinate convention and give one example each.
- `igv_snapshot` returns MCP **image content** (PNG, base64) plus a text block with the saved path and the current locus. This lets the agent see the view.
- If no instance is reachable, tools return a clear error explaining that VS Code with the extension must be open.
- **Docs:** setup for Claude Code (`claude mcp add igv -- igv-vscode mcp`), and the full launcher path variant for when `igv-vscode` is not on the agent's PATH. Command **"IGV: Copy MCP Setup Command"** copies the exact command with the absolute launcher path.

### 6.6 Agent guidance file

Ship `agent/SKILL.md`, a Claude Code skill that teaches the CLI:

- when to use it
- core commands with examples
- the coordinate convention
- how to interpret `inView:false`
- always snapshot after changes, then look
- large-file errors and fixes

Add a command **"IGV: Add Agent Skill to Workspace"** that copies it to `.claude/skills/igv/SKILL.md`. Keep it under ~120 lines.

### 6.7 Session file format (`.igv.json`)

The igv.js session object (as from `browser.toJSON()`), with these differences:

- A top-level `"igvVscode": { "version": 1 }` marker.
- Local track and genome sources stored as `"path"` (relative to the session file when `relativePaths`) instead of `url`. On load, `SessionStore` converts them back to File-like objects.
- Unknown keys are preserved.

Opening a `.igv.json` file:

- opens the viewer (custom editor, priority `default`)
- offers "Reopen as Text" in the editor title

---

## 7. Genomes and references

- **Bundled list:** at build time, `scripts/fetch-genomes.mjs` downloads `https://raw.githubusercontent.com/igvteam/igv-data/refs/heads/main/genomes/web/genomes.json` into `media/genomes.json` and records the date.
- **Do not use igv.org's `genomes*.json` endpoints.** The spike got 403s for non-IGV clients, and one endpoint returned PHP source as JSON.
- **Runtime refresh:** `igv.genomes.refresh` takes `"never"` or `"weekly"` (default). It fetches the GitHub list via the extension host, falls back silently to the bundled copy, and caches the result in global storage.
- **Passing genomes to igv:** pass the merged list as `genomeList` with `loadDefaultGenomes: false` on **every** `createBrowser`. Better still, resolve the genome to a full `reference` object ourselves and pass `reference`, never a bare `genome` id. This avoids igv's process-wide `KNOWN_GENOMES` cache bug (§14).
- **User genomes:** setting `igv.genomes.custom` is an array of reference objects (`id`, `name`, `fastaPath` or `fastaURL`, `indexPath`, `twoBitPath`, `cytobandPath`, `aliasPath`, `tracks[]`). Paths resolve relative to the workspace. Local paths go through the File-like shim.
- **Ad-hoc local reference:** `--genome path/to/ref.fa` (or `.2bit`) creates an unnamed genome from the file plus its discovered `.fai`.
- **Defaults:** `igv.defaultGenome` (workspace-scoped). If unset and the user opens a track, show a quick pick of recent genomes, the bundled list (searchable) and "Local FASTA…". Remember the choice per workspace.
- **Mismatch check (P1):** after loading a BAM, compare its `@SQ` names and lengths to the genome's chromosomes (accounting for alias mapping such as `chr1`/`1`). If none match, warn with `GENOME_MISMATCH`, suggesting genomes whose chromosome sizes match the header.

---

## 8. Human UI

### 8.1 Contributions

**Custom editors (`CustomReadonlyEditorProvider`)**

- `igv.viewer` for:
  - `*.bam`, `*.cram`, `*.bw`, `*.bigwig`, `*.bb`, `*.bigbed`, `*.tdf`, `*.2bit`: priority `default`
  - `*.igv.json`: priority `default`
  - `*.vcf.gz`, `*.bed`, `*.bed.gz`, `*.gff`, `*.gff3`, `*.gtf`, `*.bedgraph`, `*.wig`, `*.vcf`, `*.fa`, `*.fasta`, `*.seg`, `*.maf`, `*.bedpe`: priority `option`, so the text editor stays the default
- Opening a data file via the custom editor:
  - Not a session: adds the file to the active viewer if one exists and the setting `igv.openBehavior` is `"addToActive"` (default). Otherwise opens a new viewer.
  - The custom editor tab itself is a viewer.

**Commands** (category "IGV")

- New Viewer
- Add to Viewer (Explorer context, multi-select)
- Open in New Viewer
- Go to Locus…
- Go to Locus from Selection
- Set Genome…
- Load Track from URL…
- Remove Track…
- Save Session…
- Export Snapshot…
- Index File…
- Subsample BAM…
- Install CLI on PATH
- Copy MCP Setup Command
- Add Agent Skill to Workspace
- Show Output

**Status bar:** the active viewer's locus. Clicking it runs "Go to Locus…".

**Settings:** all `igv.*` settings referenced in this document, with descriptions and defaults, in `contributes.configuration`.

### 8.2 Locus from selection (`ui/locusParser.ts`)

Parse the selection or current line, in this order:

1. Explicit locus: `chr:start-end`, `chr:pos`, commas allowed.
2. VCF data line: `CHROM POS …` gives a ±50 bp window.
3. BED-like: `chrom start end` (0-based start, converted to 1-based).
4. GFF/GTF: columns 1, 4 and 5.
5. SAM line: RNAME and POS.
6. A bare gene or feature name: passed to `igv.search`.

Unit-test each case.

### 8.3 Appearance

- igv.js has a light UI. Give the panel a neutral light background frame, so it does not clash badly with dark themes.
- Do not attempt to restyle igv internals in v1.
- Hide igv's own SVG download button (`showSVGButton:false`), because downloads are blocked in webviews. Export goes through our command.

---

## 9. Track type inference (TrackResolver)

Strip `.gz` for type detection, but remember compression.

| Extension(s) | igv type / format | Notes |
|---|---|---|
| `.bam` | alignment / bam | |
| `.cram` | alignment / cram | Needs reference |
| `.sam` | — | Verify igv.js support. If unsupported, `UNSUPPORTED_FORMAT` with a hint to `samtools view -b` and index (offer to run) |
| `.bw`, `.bigwig` | wig / bigwig | |
| `.wig` | wig / wig | |
| `.bedgraph`, `.bdg` | wig / bedgraph | |
| `.tdf` | wig / tdf | |
| `.bb`, `.bigbed` | annotation / bigbed | |
| `.bed`, `.narrowpeak`, `.broadpeak` | annotation / bed / narrowPeak / broadPeak | |
| `.gff`, `.gff3`, `.gtf` | annotation | |
| `.vcf` | variant / vcf | |
| `.seg` | seg / seg | |
| `.maf`, `.mut` | mut | |
| `.bedpe`, `.interact`, `.bb` with interact autoSql | interact | `.bb` stays bigbed unless the user sets the type |
| `.gwas` | gwas | |
| `.qtl`, `.qtl.tsv` | qtl | |
| `.bp` | arc | |
| `.fa`, `.fasta`, `.fna`, `.2bit` | reference (genome), not a track | |
| `.igv.json` | session | |
| `.xml` | session | P2, IGV desktop sessions |

Unknown extension: `UNSUPPORTED_FORMAT`, unless `type` and `format` are given explicitly.

---

## 10. Webview implementation details

- **CSP** (nonce per load; the spike's working string, generalized):
  ```
  default-src 'none'; script-src ${cspSource} 'nonce-${n}'; style-src ${cspSource} 'unsafe-inline';
  img-src ${cspSource} data: blob:; font-src ${cspSource} data:; connect-src https: ${extraConnect};
  worker-src blob:
  ```
  `extraConnect` is `${cspSource}` in `webviewUri` mode, and `http:` only if the user enables `igv.remote.allowHttp`.
- `localResourceRoots` is `[extension/media]` only (plus track directories in `webviewUri` mode).
- **Error capture:** forward `window.onerror`, `unhandledrejection` and `securitypolicyviolation` to the "IGV" output channel, tagged with the viewer id.
- **igv alerts:** igv shows its own alert dialogs for some errors. Where igv exposes hooks, suppress or intercept them and route them to VS Code notifications and RPC errors. Where it doesn't, document it.
- **Browser lifecycle:**
  - On every (re)create, remove the old browser with `igv.removeBrowser`, discard the container element, and create a new `div` (because of shadow-root reuse, §14).
  - If `createBrowser` throws, discard the container. Never retry into the same element.
- **Snapshot:**
  1. `browser.toSVG()`.
  2. For PNG: load the SVG into an `Image` via a `data:` URL, draw it to a canvas at `scale`, and export it with `canvas.toBlob('image/png')`.
  3. Send the bytes to the extension host.
  4. The host writes the file.

---

## 11. Testing strategy

### 11.1 Fixtures (`test/fixtures/`, generated by `scripts/make-fixtures.py`)

Generate the fixtures with pysam and pyBigWig, using fixed seeds. Do not commit large binaries. Generate them in CI and cache them.

- `ref.fa` (+`.fai`): `chrS` 5 Mb plus `chrT` 50 kb.
- `small.bam` (+`.bai`, about 2k reads on `chrT`).
- `large.bam` (+`.bai`): about 60 MB.
  - Planted SNP at `chrS:1,000,000` with ~50 % alt allele, at ≥25× local depth.
- `coverage.bw`.
- `genes.bed`, `genes.gff3`.
- `variants.vcf.gz` (+`.tbi`).
- `unindexed_big.bed`: just over `unindexedMaxBytes`.
- `noindex.bam`.

For the **perf fixture** (§5.4), a ≥5 GB BAM is generated only in the perf job.

### 11.2 Test layers

| Layer | Tool | Covers |
|---|---|---|
| Unit | vitest | TrackResolver (inference, index discovery, policy), locusParser, session path rewriting, genome resolution, RPC framing, CLI arg parsing, broker clamping, chunking and coalescing |
| Webview unit | vitest + jsdom, or Playwright on a static harness page | FileLike against a mock RPC, the cache, Snapshot rasterization |
| igv contract test | Playwright (Chromium) loading `media/igv.min.js` in a harness page with an in-page fake broker | Pins igv.js behaviour we depend on: File-like detection, `slice` call shapes, BAM/bigWig/BED/GFF/VCF/FASTA loads, `toSVG`. **Must fail loudly if an igv upgrade breaks the File-like hook.** |
| Extension integration | `@vscode/test-electron` | Commands, custom editors, viewer lifecycle, control server, CLI end to end against a real VS Code instance. Inspect state and snapshots via RPC, not pixels. |
| code-server e2e | Docker (`codercom/code-server` pinned to a recent 4.x **and** an older 4.10x) + Playwright | Install the VSIX, open a viewer, run the CLI from a terminal inside the container, assert the snapshot shows alignments (PNG non-blank, plus SVG `<rect>` count above a threshold). Run in both `shim` and `webviewUri` modes. |
| Perf | Node script over the RPC API | §5.4 targets. Outputs a markdown table to `PROGRESS.md`. |

**Snapshot assertions:** parse the SVG and assert that track groups exist, the alignment track contains ≥ N rects, and the SNP column is present. Do not do pixel diffs.

### 11.3 Human checkpoints

At the end of M2, M3 and M5, give the human a checklist of at most 8 items to verify visually and interactively. Cover:

- drag and zoom feel
- dark theme appearance
- prompts wording
- the agent snapshot matching the panel

Record their answers in `PROGRESS.md`.

---

## 12. Milestones

Each milestone ends with: all tests green, `PROGRESS.md` updated, and a VSIX built.

### M0 — Scaffold and pipeline

- TypeScript strict and esbuild, with three bundles: extension, webview and cli. Plus eslint and vitest.
- `igv` pinned at `3.8.9` (exact). `scripts/copy-igv.mjs` copies `dist/igv.min.js` to `media/`.
- `scripts/fetch-genomes.mjs`.
- `npm run package` produces a VSIX via `@vscode/vsce` (README, LICENSE (MIT), CHANGELOG and repository fields present).
- GitHub Actions: lint, unit tests and package on Linux/macOS/Windows.
- `engines.vscode`: `^1.85.0` unless an API used requires more. Document every API that sets the floor. Features needing newer APIs (MCP provider) must be feature-detected.

**Accept:** VSIX installs into desktop VS Code and code-server. "IGV: New Viewer" opens a panel showing igv with a bundled-list genome (if online) or a local fixture FASTA.

### M1 — Core viewer and data access

- ViewerManager and ViewerController with RPC.
- FileAccessBroker: allow-list, chunking, coalescing and metrics.
- FileLike and the cache.
- TrackResolver: inference and index discovery. Policy stubs must throw clearly until M3.
- GenomeRegistry: bundled list, custom, local FASTA, per-workspace default.
- Commands: New Viewer, Add to Viewer, Open in New Viewer, Go to Locus, Set Genome, Remove Track.
- igv contract test.

**Accept:** all fixtures except the oversized ones load. The fixture SNP is visible in the snapshot SVG. Broker metrics show <3 % of `large.bam` read over 5 navigations.

### M2 — Editor integration, sessions, persistence

- Custom editors and priorities.
- Session save/load with relative paths. `.igv.json` opens in the viewer.
- WebviewPanelSerializer restore.
- Status bar.
- Locus from selection.
- Export snapshot command.

**Accept:** session round-trip test across a moved directory. The viewer is restored after "Reload Window". Human checkpoint 1.

### M3 — Large files and remote data

- Full policy (§5): prompts and agent error codes.
- ToolDetector plus index, bgzip/tabix and subsample jobs, with progress and cancel.
- `derivedDir`.
- RemoteProxy, plus `auto` mode with per-origin memory.
- `webviewUri` mode (experimental).
- CRAM with a reference.
- Genome mismatch check.
- Perf job.

**Accept:** §5.4 targets met on desktop, and recorded for code-server. Oversized unindexed fixtures trigger prompts and `INDEX_REQUIRED`. Auto-index works when samtools exists and errors clearly when it doesn't. A remote BAM URL loads in both direct and proxy modes. Human checkpoint 2.

### M4 — Agent control API and CLI

- ControlServer: UDS/pipe, token, registry, Restricted Mode handling.
- All §6.3 methods, including `waitForRender`.
- CliInstaller (launchers, PATH injection, "Install CLI on PATH").
- CLI with full help and JSON output.
- Snapshot to PNG.

**Accept:** the integration test runs every CLI command against a live instance. The code-server e2e passes using the CLI from the container's terminal **without a system `node`** (remove node from the image's PATH to prove it). Multi-window discovery test (two instances, cwd selection).

### M5 — MCP and agent docs

- `igv-vscode mcp` with all tools. `igv_snapshot` returns image content.
- `agent/SKILL.md` and the "Add Agent Skill" command.
- "Copy MCP Setup Command".
- Docs: `docs/agents.md` covering Claude Code setup, examples and troubleshooting.

**Accept:** an MCP client test using the SDK client connects over stdio, calls every tool, and receives a PNG. Manual check: Claude Code (configured by the human) can open a viewer on fixtures, take a snapshot, and describe the SNP. Human checkpoint 3.

### M6 — Hardening and release

- Error-path review: every `data.code` reachable and tested.
- Output channel logs are useful.
- Memory: closing viewers frees file handles and caches. Test 20 open/close cycles.
- Accessibility basics for our own UI (quick picks, notifications).
- README with GIFs or screenshots, citation, CodeOcean setup (§13), troubleshooting and settings reference.
- Publish configuration for the VS Marketplace and Open VSX (code-server installs from Open VSX by default). Do not actually publish without human approval.

---

## 13. Platform notes

### Desktop VS Code

- The CLI launcher uses Electron with `ELECTRON_RUN_AS_NODE=1`.
- The integration tests cover this case.

### Remote-SSH, WSL and Dev Containers

- With `extensionKind: workspace`, everything runs on the remote, including the socket and CLI. An agent running in the remote terminal works.
- An agent running on the local machine against remote files is out of scope.

### code-server and CodeOcean

**Installing (persists across sessions).** Add to the capsule's post-install script:

```bash
if command -v code-server >/dev/null; then
  mkdir -p /.vscode/extensions
  code-server --extensions-dir=/.vscode/extensions --install-extension <publisher>.igv-vscode
  # or, before publishing: download a release VSIX with curl and install it by path
fi
```

**What the spike observed:**

- code-server runs with `--extensions-dir=/.vscode/extensions`. The `code-server` command on PATH is the remote CLI.
- There is no system node.
- `/data` is read-only. Use derived-dir fallbacks.

**Network:** remote URLs in `direct` mode are fetched by the user's laptop browser. In `proxy` mode they are fetched by the capsule. Document both.

---

## 14. Feasibility spike findings to design around

| # | Finding | Design response |
|---|---|---|
| 1 | File-like shim works for all core formats. Reads stay small (1.86 % of a 58 MB BAM over 6 views). Settle time ~150 ms. | Default transport (§4.1) |
| 2 | Each read costs a ~33 ms webview↔host round trip on code-server. Disk takes 0.15 ms. | Concurrency, coalescing, webview LRU cache |
| 3 | `Uint8Array` arrives as binary. | Binary payloads plus a startup probe with base64 fallback |
| 4 | igv always calls `slice` with finite integers. Indexes, BED and GFF are read whole via `arrayBuffer()`. | Keep the `Number.isFinite` guard. Large-index perf test in M3 |
| 5 | `GenomeUtils.KNOWN_GENOMES` is global and initialized once. `loadDefaultGenomes:false` in one browser broke `genome:"hg38"` in another. A failed `createBrowser` leaves a zombie in `allBrowsers`. | Always resolve and pass a full `reference` (§7). Pass `genomeList` on every create |
| 6 | igv.org `genomes*.json` returns 403 to non-IGV clients. `hg38.json` returned PHP source. GitHub igv-data and the genome data files work. | Bundled list from GitHub plus optional refresh (§7) |
| 7 | igv 3.x renders into a shadow root on the parent div and reuses it. Clearing `innerHTML` does not reset it. | Fresh container per browser (§10) |
| 8 | The default alignment `visibilityWindow` is 30 kb, so wider views show no reads. | Explicit setting, plus `inView` reporting to agents (§5.3) |
| 9 | `asWebviewUri` returned real 206 ranges on code-server 4.129. | Optional `webviewUri` mode, tested in e2e (§4.2) |
| 10 | No `node` or `npm` on PATH on CodeOcean. | CLI launcher uses the extension host runtime (§6.4). Build VSIXs elsewhere |
| 11 | `vsce` needs a README and license. | M0 packaging setup |
| 12 | Working CSP needed no changes for the shim. | §10 CSP |

---

## 15. Repository layout

```
igv-vscode/
  package.json  tsconfig.json  esbuild.mjs  .vscodeignore  README.md  LICENSE  CHANGELOG.md
  PROGRESS.md  docs/{DECISIONS.md, agents.md, architecture.md, troubleshooting.md}
  agent/SKILL.md
  media/{igv.min.js, genomes.json, styles.css}
  src/
    extension.ts
    viewer/{ViewerManager.ts, ViewerController.ts, html.ts}
    data/{FileAccessBroker.ts, RemoteProxy.ts, TrackResolver.ts, formats.ts}
    genome/GenomeRegistry.ts
    session/SessionStore.ts
    agent/{ControlServer.ts, protocol.ts, client.ts, cli.ts, mcp.ts, CliInstaller.ts, registry.ts}
    tools/{ToolDetector.ts, jobs.ts}
    ui/{statusBar.ts, locusParser.ts, pickers.ts}
  webview/{main.ts, BrowserAdapter.ts, FileLike.ts, Snapshot.ts, rpc.ts}
  scripts/{copy-igv.mjs, fetch-genomes.mjs, make-fixtures.py, perf.mjs}
  test/{unit/, contract/, integration/, e2e-code-server/, fixtures/}
```

`src/agent/protocol.ts` is the single source of truth for RPC types. The CLI, MCP server, ControlServer and tests all import it.

---

## 16. Definition of done (v1)

- All milestones accepted. CI is green on three OSes, plus the code-server e2e on two code-server versions.
- Every human story (H1–H7) and agent story (A1–A6) in §2 is demonstrated by an automated test or a recorded human checkpoint.
- The README lets a new user, starting cold, do each of the following in under 5 minutes:
  - install the extension
  - open a BAM
  - set up Claude Code via MCP
  - get an agent-driven snapshot
- No known data-safety issues. The webview can read only allow-listed files. The control channel is local, owner-only and token-authenticated.
