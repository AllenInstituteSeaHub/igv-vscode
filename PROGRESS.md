# Progress

Build log for igv-vscode, kept per the spec (§0 item 3). Each milestone records what was built, test results, deviations from the spec and open issues.

## Open questions for the human

- **Publisher id** (`package.json` `publisher`, spec §1.1): decided 2026-10-04: `alleninstituteseahub` (extension id `alleninstituteseahub.igv-vscode`). GitHub repository `AllenInstituteSeaHub/igv-vscode`. The `igv-vscode-dev` placeholder is gone from the code; the release workflow still refuses to release under it.
- **License copyright holder**: `LICENSE` says "igv-vscode contributors". Change if you want a named holder.
- **Local toolchain**: `samtools`, `tabix`, `bgzip`, and the Python `pysam`/`pyBigWig` packages are not installed on this machine. The fixture generator (M1) and the ToolDetector jobs (M3) need them for local testing. `conda install -c bioconda samtools htslib pysam pybigwig` would cover it.

## M0 — Scaffold and pipeline

**Status:** accepted by the human on 2026-10-03 ("Everything works great"): VSIX installed on desktop VS Code 1.140, IGV: New Viewer showed igv with a bundled genome.

### Built

- `package.json` with the spec's naming, keywords, categories, `extensionKind: ["workspace"]`, limited untrusted-workspace support, `virtualWorkspaces: false`, `engines.vscode ^1.85.0`.
- `esbuild.mjs` producing `dist/extension.js` (Node CJS), `dist/webview.js` (browser IIFE) and `dist/cli.js` (Node CJS). Watch and production modes.
- TypeScript strict for host (`tsconfig.json`) and webview (`webview/tsconfig.json`, DOM lib, no Node types).
- eslint 10 flat config with typescript-eslint; vitest 5.
- `scripts/copy-igv.mjs` (verifies the pinned 3.8.9 version, copies `igv.min.js` to `media/`), `scripts/fetch-genomes.mjs` (igv-data list from GitHub, records fetch date, keeps the cached copy offline), `scripts/make-icon.mjs` (original 128×128 icon, no IGV branding).
- Extension host: `extension.ts`, `log.ts` (IGV output channel), `genome/GenomeRegistry.ts` (bundled list, default and recent genomes; vscode-free for testing), `viewer/ViewerManager.ts`, `viewer/ViewerController.ts` (per-viewer operation queue, ready handshake, state events), `viewer/html.ts` (spec §10 CSP), `ui/pickers.ts`.
- Shared: `src/shared/rpc.ts` (bidirectional request/response with ids, timeouts, error propagation; used by both host and webview), `src/shared/webviewProtocol.ts`, `src/agent/protocol.ts` (API types).
- Webview: `main.ts` (error capture for onerror/unhandledrejection/securitypolicyviolation), `BrowserAdapter.ts` (fresh container per browser, `genomeList` + `loadDefaultGenomes:false` + `reference` on every create, `showSVGButton:false`, igv alert interception, `inView` computation from `visibilityWindow`), `igv.d.ts`.
- CLI: help, version, exit codes; viewer commands exit 3 with a JSON error until M4.
- Commands: IGV: New Viewer, IGV: Show Output. Setting `igv.defaultGenome`.
- CI: `.github/workflows/ci.yml` runs typecheck, lint, unit tests and packaging on Linux, macOS and Windows.
- Docs: README (unofficial notice, citation), LICENSE (MIT), CHANGELOG, `docs/DECISIONS.md`, `docs/architecture.md`.

### Tests

| Suite | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` (vitest) | 23 tests pass: RPC framing/timeouts/errors, GenomeRegistry list/resolve/defaults, CLI arg handling |
| `npm run test:integration` (@vscode/test-cli, VS Code 1.140.0, macOS arm64) | 4 tests pass: activation and commands; genome resolution; opening a viewer on sacCer3 via the extension API, navigating, listing and resolving viewers, disposal; the **IGV: New Viewer** command with `igv.defaultGenome` set. Needs network for the genome data. |
| `npm run package` | `igv-vscode-0.0.1.vsix`, 15 files, 443 KB (igv.min.js is 1.43 MB uncompressed) |

Integration tests set `IGV_LOG_CONSOLE=1` so the IGV output channel is mirrored to the test host's stdout. Mocha's failure summary can be lost when the extension host exits, so the smoke test also prints failures eagerly.

### Findings worth knowing

- **`igv.version` is a function** in igv.js 3.8.9 (`igv.version()` returns `"3.8.9"`). Posting it through `postMessage` threw `DataCloneError`, which silently broke the webview ready handshake. `webview/BrowserAdapter.ts` normalises this (`igvVersion()`).
- **igv reports canonical sequence names in `currentLoci()`.** For sacCer3 (UCSC hub 2bit with a chromAlias file), navigating to `chrI:1-20000` reports `NC_001133.9:1-20000`. Agents and the status bar will therefore see canonical names, not the alias the user typed. Decide in M1 whether to map back to the user's name set (igv's reference frames know the alias table) or document the behaviour.

### Deviations from the spec

- Shared host/webview code lives in `src/shared/` (`rpc.ts`, `webviewProtocol.ts`); `webview/rpc.ts` re-exports it. The spec's layout had `rpc.ts` only under `webview/`, but the host needs the same class. Recorded in `docs/DECISIONS.md`.
- `localResourceRoots` includes `dist/` as well as `media/`, because the webview bundle is emitted to `dist/webview.js`.
- `@types/node` is v22 (the spec's Node 18 floor is kept via esbuild `target: node18`); v18 types conflict with vitest 5's vite peer range.

### Open issues

- The M0 acceptance mentions a local fixture FASTA as an offline alternative. Local references need the File-like shim, which is M1 scope, so M0 only offers bundled-list genomes (online).
- CI runs lint, unit tests and packaging on three OSes as the spec asks for M0. The integration suite is not yet in CI (it needs `xvfb-run` on Linux); add it in M1 together with the contract test.
- The project is not yet committed to git (`git init` has been run). Commit when you are ready; nothing in the tree is generated except `dist/`, `out-test/`, `media/igv.min.js`, `media/igv-version.json` and `*.vsix`, which are ignored.

### Human checkpoint (M0 acceptance)

Result: all items confirmed working on desktop VS Code (macOS). Item 6 (code-server) not checked yet; no code-server available locally.

1. `code --install-extension igv-vscode-0.0.1.vsix` installs without error on desktop VS Code.
2. **IGV: New Viewer** asks for a genome, then shows igv with the chosen genome and its Refseq track. Try `hg38`, which needs network access to igv.org and UCSC.
3. After choosing, you are offered "Use <genome> as the default genome for this workspace?". Saying Yes writes `igv.defaultGenome` to `.vscode/settings.json`.
4. Dragging and zooming in the panel feel normal; the panel has a light frame that looks acceptable in a dark theme.
5. **IGV: Show Output** shows the "IGV" channel with activation, viewer and webview lines.
6. If you have code-server available, the same VSIX installs there and **IGV: New Viewer** works.

## M1 — Core viewer and data access

**Status:** built; all acceptance criteria met by automated tests (spec §12 M1 has no human checkpoint, but see the short try-it list below).

### Built

- `data/formats.ts`: track type inference (spec §9) and index candidates (spec §4.4).
- `data/TrackResolver.ts`: TrackSpec → igv config plus the local files to serve. Index discovery, explicit index override, option validation (allow-list of igv keys, numeric and displayMode checks), alignment/variant defaults from settings, display paths relative to the workspace. Large-file policy: unindexed BAM/CRAM or text above `igv.largeFile.unindexedMaxBytes` fails with `INDEX_REQUIRED` plus the exact `samtools index` / `sort | bgzip | tabix` command; `autoIndex`/`subsample` fail with `TOOL_MISSING` until M3. `s3://`/`gs://` fail with a presigned-URL hint. CRAM without a sequence-bearing genome fails with `REFERENCE_REQUIRED`.
- `data/FileAccessBroker.ts`: per-viewer allow-list with opaque file ids, clamping, chunk cap (`igv.transport.maxChunkBytes`, default 8 MiB), coalescing of contained in-flight reads, LRU of open handles (32), handle release when the last viewer drops a path, per-viewer metrics (requests, bytes, p50/p95, per-file bytes).
- `webview/FileLike.ts`: File-like objects (`name`, `size`, `slice().arrayBuffer()`), webview-side chunking, 64 MiB LRU range cache for ranges ≤ 1 MiB, binary payloads with base64 fallback, and `hydrateFileRefs` which deep-replaces `{__igvVscodeFile}` markers in any igv config.
- `shared/markers.ts`: `{__igvVscodeLocalPath}` (host only) and `{__igvVscodeFile}` (crosses to the webview) markers. Absolute paths never reach the webview.
- Transport probe on first genome load: 256 bytes round-trip as Uint8Array → binary mode; otherwise the session uses base64 and logs a warning.
- `ViewerController`: `setGenome` (with `keepTracks`), `addTracks`, `removeTracks` (by id or name), `goto`, `snapshotSvg`, `settle` (no reads for 250 ms and no pending igv loads), `getState(verbose)` with metrics, per-viewer operation queue, broker release on dispose.
- `GenomeRegistry`: `igv.genomes.custom` entries (paths or URLs, discovered `.fai`, per-genome tracks), ad-hoc local FASTA (+`.fai`, or unindexed ≤ 10 MiB, bgzipped needs `.fai`+`.gzi`) and 2bit (+`.bpt`), `resolve()` accepts ids, names or paths.
- Commands: New Viewer, Add to Viewer (Explorer multi-select or file dialog; respects `igv.openBehavior`), Open in New Viewer, Go to Locus… (input box, multi-locus with spaces), Set Genome… (quick pick incl. "Local FASTA or 2bit file…", keep/clear tracks), Remove Track… (multi-select quick pick). Explorer context menu on all supported extensions. Context key `igv.hasViewer`.
- Settings added: `igv.genomes.custom`, `igv.openBehavior`, `igv.transport.maxChunkBytes`, `igv.transport.cacheMiB`, `igv.alignment.visibilityWindow`, `igv.alignment.samplingDepth`, `igv.alignment.samplingWindowSize`, `igv.variant.visibilityWindow`, `igv.largeFile.unindexedMaxBytes`.
- Loci are reported in IGV display convention (1-based, inclusive, thousands separators), formatted from igv's reference frames because `currentLoci()` returns fractional coordinates such as `chrT:1000-3999.9999999999995`.
- Fixtures: `scripts/make-fixtures.py` (pysam + pyBigWig, seeded, 5.5 s) generates `test/fixtures/generated/` (see `test/fixtures/README.md`). The planted SNP is chrS:1,000,000 A>C at depth 47, alt fraction 0.51.
- Contract test: `test/contract/igv.contract.spec.ts` (Playwright + Chromium) drives `media/igv.min.js` with File-likes backed by an in-page fake broker.

### Tests

| Suite | Result |
|---|---|
| `npm run typecheck`, `npm run lint` | pass |
| `npm test` (vitest) | 92 tests: RPC, formats, TrackResolver (policy, discovery, options), FileAccessBroker (allow-list, clamping, coalescing, LRU, metrics), FileLike (chunking, cache, base64, hydration), GenomeRegistry (bundled, custom, local) |
| `npm run test:contract` (Playwright, igv 3.8.9) | 5 tests: pinned version and API; File-like FASTA reference with finite-integer slices and whole-index reads; BAM+BAI, bigWig, BED, GFF3, VCF+TBI loads with `config.id` preserved and ≥50 SVG rects; planted SNP visible (≥5 alt-coloured marks); removeBrowser + fresh container |
| `npm run test:integration` (VS Code 1.140) | 8 tests (4 new): local FASTA genome, six fixtures load with correct types/indexing, oversized BED → `INDEX_REQUIRED`, unsupported/missing → errors, broker allow-list is exactly the added files, snapshot SVG, remove by name releases files, dispose empties the allow-list; SNP visible through the real broker, `inView:false` with `outsideVisibilityWindow` on a 200 kb view; Explorer-style `igv.addToViewer`, `igv.gotoLocus` with argument, `setGenome(keepTracks)`; custom genome from settings |
| VSIX | `igv-vscode-0.0.1.vsix`, 455 KB |

**Acceptance metrics (M1):**

| Metric | Result |
|---|---|
| Fixtures loading (all except oversized) | 7 of 7 (small.bam, noindex.bam, coverage.bw, genes.bed, genes.gff3, variants.vcf.gz, large.bam) |
| SNP visible in snapshot SVG | yes, in both the contract and integration tests |
| large.bam bytes over 5 navigations (broker metrics) | 2.44 % (1.35 MB of 55.4 MB); 2.89 % including the initial load. Contract harness: 2.84 % / 3.29 % |
| Read latency (desktop, in-process) | p50 0.4 ms, p95 2 ms over 23 reads |

Note on the byte budget: igv reads whole BAI chunks, and the linear index has 16 kb bins. At 12x depth with 100 bp reads that is 150–300 kB per 2 kb view regardless of file size, which on a 55 MB fixture is a few percent. On a multi-GB BAM the same reads are well under 0.1 %. The M3 perf job (≥5 GB BAM) measures the realistic case.

### Deviations from the spec

- Chunking is done webview-side (FileLike splits requests above `maxChunkBytes`) with the host rejecting oversized requests, instead of the host splitting and the webview reassembling. Same effect, simpler protocol.
- Coalescing merges a read fully contained in an in-flight read of the same file; partially overlapping reads are not merged (rare in igv's access pattern).
- The webview range cache is 64 MiB total / 1 MiB per entry as specified, but `igv.transport.cacheMiB` lets users lower it.
- Track option pass-through is an explicit allow-list of igv keys rather than "anything after validation", so typos fail loudly.

### Findings

- igv's `currentLoci()` returns fractional coordinates (`chrT:1000-3999.9999999999995`); we format from the frames.
- igv 3.8.9 nucleotide colours in SVG output: A `rgb(0,200,0)`, C `rgb(0,0,200)`, G `rgb(209,113,5)`, T `rgb(255,0,0)` (spacing varies). The tests key on these.
- igv keeps `config.id` on the Track object, so host-assigned ids (`t1`, `t2`, …) can be used for lookup.
- The `.bai` and unindexed BED/GFF are read whole with a single `arrayBuffer()` call, confirming spike finding #4.

### Bug fixed after the first M1 VSIX

- The Explorer context menu never appeared: the generated `when` clause had doubled backslashes (`\\.` matched a literal backslash). Fixed in `package.json`; `test/unit/packageJson.test.ts` now evaluates the clause against real filenames (bam, vcf.gz, bigWig, …) and non-matches (bai, tbi, md) so it cannot regress. Reported by the human on 2026-10-03. Confirmed working afterwards; note that VS Code shows context-menu items without the "IGV:" category prefix (only the Command Palette shows it), so the items read "Add to Viewer" / "Open in New Viewer" near the bottom of the Explorer menu.

### Try it (optional, 2 minutes)

1. Right-click `test/fixtures/generated/small.bam` in the Explorer → **IGV: Open in New Viewer** → choose "Local FASTA or 2bit file…" → pick `ref.fa`. Reads should appear on chrT.
2. Multi-select `coverage.bw` and `genes.bed` → **IGV: Add to Viewer**.
3. **IGV: Go to Locus…** → `chrT:10,001-12,000`.
4. **IGV: Remove Track…** → remove one.
5. Right-click `unindexed_big.bed` → **IGV: Add to Viewer**. Expect an error with the `sort | bgzip | tabix` hint.

## M2 — Editor integration, sessions, persistence

**Status:** accepted (automated acceptance plus human checkpoint 1 on 2026-10-04).

### Built

- **Custom editors** (`viewer/IgvEditorProvider.ts`): `igv.editor` with priority `default` for `*.bam, *.cram, *.bw/*.bigwig, *.bb/*.bigbed, *.tdf, *.2bit, *.igv.json`; `igv.editorOption` with priority `option` for text formats (VCF, BED, GFF/GTF, bedGraph, WIG, FASTA, SEG, MAF, bedpe, peaks). Same provider class behind both. Opening a data file adds it to the active viewer when `igv.openBehavior` is `addToActive` (the tab closes itself), otherwise the tab becomes a new viewer named after the file. A `.igv.json` always becomes its own viewer. The last locus per file is remembered in workspace state. **Reopen as Text** appears in the editor title for IGV editors.
- **Sessions** (`session/SessionStore.ts`, `session/SessionService.ts`): `.igv.json` = igv session shape + `igvVscode: {version: 1}`; local sources as `path`/`indexPath` relative to the session file (POSIX separators), remote as `url`/`indexURL`, bundled/custom genomes as `genome: id`, local references as `reference: {fastaPath, indexPath | twoBitPath}`. Current igv track state (`track.getState()`, sanitised to primitives and filtered by the option allow-list) is merged into each track. Unknown top-level keys are preserved. Plain igv.js sessions (local files as non-URL `url`) are accepted on load. Commands **Save Session…**, **Load Session…** (also in the Explorer menu for `.igv.json`).
- **Panel restore after reload**: each command-created viewer gets a restore key stored in the webview state; a debounced session snapshot (absolute paths) is kept in workspace state (max 20 entries, 7 days). `WebviewPanelSerializer` for `igv.viewer` replays it. Custom-editor tabs are re-resolved by VS Code itself and return to the remembered locus.
- **Status bar**: `$(dna) <locus>` for the active viewer; click runs Go to Locus….
- **Go to Locus from Selection** (`ui/locusParser.ts`): explicit locus, VCF (±50 bp), BED (0-based → 1-based), GFF/GTF, SAM (RNAME:POS spanning the CIGAR), bare gene name → igv search. Partial selections fall back to the full lines. Editor context menu entry.
- **Export Snapshot…**: PNG (canvas rasterisation at `igv.snapshot.scale`, default 2) or SVG via the save dialog; default folder `igv.agent.snapshotDir` → `<workspace>/.igv/snapshots/` → global storage.
- Fix: shorthand hex colours (`#c00`) are expanded to 6 digits because igv 3.8.9's `darkenLighten` throws on them while drawing, and that one draw error rejects every concurrent `loadTrack`. The webview now also removes a track that igv added before its load promise rejected.

### Tests

| Suite | Result |
|---|---|
| unit (vitest) | 110 tests (+ locusParser 8, SessionStore 5, package.json contributions 4, colour normalisation) |
| contract (Playwright) | 5 pass (unchanged) |
| integration (VS Code 1.140) | 13 pass (+5): session round trip after moving the project directory (no absolute paths in the file; reload from the new location with zero warnings; options preserved on re-save); custom editor flows (data file → viewer, second file joins active viewer, option editor, session file → viewer); PNG snapshot signature and 2× scale; Go to Locus from Selection on a BED line and a VCF line; restore entries through workspace state |
| VSIX | 463 KB, installed locally |

### Deviations from the spec

- Custom editor viewTypes are `igv.editor` / `igv.editorOption` rather than `igv.viewer`, because `igv.viewer` is the webview-panel viewType used by the serializer and VS Code needs one priority per custom-editor entry.
- Session files store local sources as `path`/`indexPath` (the spec names only `path`), remote ones keep igv's `url`/`indexURL`.
- Restore snapshots live in workspace state and the webview state only holds a key, so absolute paths never enter the webview.

### Findings

- VS Code does not start loading a custom editor's webview until `resolveCustomEditor` returns. Awaiting the genome load inside it deadlocks against the webview "ready" handshake; loading now runs detached.
- igv's `track.getState()` returns the config plus live values; File-like objects and functions are filtered out before saving.

### First human run of the M2 build (2026-10-04): everything looked broken

The human saw empty BAM tracks, an error on `coverage.bw`, and errors when opening a second file. Root cause: the workspace had `igv.defaultGenome: hg38` (chosen during the M0 check), so every fixture file (chromosomes `chrS`/`chrT`) was loaded against hg38. igv shows nothing for alignments on unknown chromosomes and errors for bigWig. The automated tests run in a clean workspace and never hit this.

Fixes:

- **Genome mismatch check pulled forward from M3** (`data/sequenceNames.ts`): the sequence names of each local track are read on the host (BAM header via BGZF, bigWig/bigBed chromosome B+ tree, tabix index names, first lines of text files) and compared with the loaded genome's chromosome names modulo `chr` prefix and case. On zero overlap the track is still added but reported with `inView:false, inViewReason:'genomeMismatch'`, a `GENOME_MISMATCH:` warning (agents) and a notification with a **Set Genome…** button (humans). Integration test added; `setGenome(keepTracks)` to the right genome clears the flag.
- **Add-to-active-viewer tab**: the custom editor used to dispose its panel inside `resolveCustomEditor`, which made VS Code report an error for the editor it was still opening. It now shows a short note and closes itself after the track has been added.
- Unit tests for the readers against the fixtures (BAM references with lengths, bigWig tree, tabix names, BED/GFF chromosomes).

### Second human run (2026-10-04): mismatch detected, but three more problems

1. Re-opening `small.bam` after fixing the genome showed nothing. Two causes: the per-file remembered locus came from the previous (hg38) genome, and without a locus igv opens its whole-genome view where alignments are hidden by the visibility window. Fixes: the remembered locus is keyed by (file, genome) and applied with `goto` after the browser exists, never at creation; and when there is no remembered locus, `suggestInitialLocus()` (`data/sequenceNames.ts`) picks a 20 kb window where the file has data (first BAM record, first text feature, first bigWig chromosome), restricted to chromosomes the genome knows. Used by the custom editor and by Open in New Viewer / Add to Viewer when they create a viewer.
2. Double-clicking an already-loaded file added a duplicate track each time. Human add flows now skip files already in the viewer (status-bar note), while the agent API stays permissive.
3. The "loading hg38" progress popup was the workspace default genome. With the human's permission `.vscode/settings.json` now has `igv.defaultGenome: test/fixtures/generated/ref.fa` (a path works; it resolves relative to the workspace).

Not a bug: double-clicking a `.bed` opens the text editor, per spec §8.1 (text formats have `option` priority). IGV is reachable via right-click → Add to Viewer, or Open With… → IGV Viewer. Flagged to the human in case they want double-click to open IGV for text formats too.

Discoverability (2026-10-04): the human asked how to save a session or export a snapshot. Added title-bar buttons on IGV editor tabs (Go to Locus, Set Genome, Export Snapshot, Save Session, Reopen as Text) in addition to the Command Palette entries.

### Human checkpoint 1 (spec §11.3) — result

Accepted by the human on 2026-10-04 ("Save and export both work. So does everything else") after the three fix rounds above: file opens, add-to-active, Go to Locus from Selection, Save Session, reload restore, Export Snapshot, drag/zoom and dark theme. BED double-click stays text-first (spec §8.1).

Original checklist:


1. Double-click `test/fixtures/generated/small.bam` in the Explorer (it should open directly as an IGV viewer; with `igv.defaultGenome` unset you are asked for a genome, pick "Local FASTA or 2bit file…" → `ref.fa`).
2. Double-click `coverage.bw`: it should join the existing viewer and the extra tab should close by itself.
3. Open `genes.bed` normally (text editor), put the cursor on a line, right-click → **Go to Locus from Selection**. The viewer should navigate and the status bar locus should update.
4. **IGV: Save Session…** → save as `demo.igv.json` in the workspace. Open the file as text (right-click → Open With… → Text Editor, or the **Reopen as Text** title button when it is open in IGV): paths should be relative.
5. Run **Developer: Reload Window**. The viewer(s) should come back at the same locus with the same tracks.
6. **IGV: Export Snapshot…** → save a PNG and open it: it should match the panel.
7. Drag/zoom feel and dark-theme appearance: anything off?
8. Prompt and error wording: anything confusing?

## M3 — Large files and remote data

**Status:** accepted (automated acceptance, desktop perf targets, human checkpoint 2 on 2026-10-04). code-server perf numbers pending (M4 e2e).

### Built

- **Large-file policy** (`tools/LargeFilePolicy.ts`, spec §5): `resolveTrack` now throws `INDEX_REQUIRED` with structured data (`remedy: index | compressIndex`, `suggestedCommand`, size, format). The policy turns such specs into loadable ones: agents with `autoIndex: true` get the job run automatically (or `TOOL_MISSING` with install hints); humans get a modal with exactly the actions the available tools allow (**Index with samtools / tabix**, **Sort, compress and index (bgzip + tabix)**, **Subsample…**, **Load anyway**, Cancel). Previously generated artifacts in the derived dir are reused. `loadAnyway: true` is now a public TrackSpec option.
- **ToolDetector** (`tools/ToolDetector.ts`): finds samtools, bgzip, tabix, bedtools and sort on PATH or via `igv.tools.paths`; versions via `--version`; 60 s cache. Missing tools are explained, never auto-installed.
- **Jobs** (`tools/jobs.ts`): `samtools index`, `samtools faidx`, sort → `bgzip -c` → `tabix -p` (header `#` lines kept, `track`/`browser` lines dropped because tabix cannot skip them), `samtools view -b -s SEED.FRAC [-o] BAM [REGION]` + index for subsampling (fraction or target read count via `view -c`). Every command is logged to the IGV output channel; jobs are cancellable (AbortSignal → SIGTERM) and report progress lines.
- **Derived dir** (`data/derivedDir.ts`): artifacts go next to the source when its directory is writable (verified with a real write), else under `igv.largeFile.derivedDir` (default: global storage) in a folder keyed by sha1(path, size, mtime).
- **Commands**: **Index File…** (BAM/CRAM → .bai/.crai, FASTA → .fai, text → sort+bgzip+tabix), **Subsample BAM…** (fraction or read count, optional region, then offer to add), **Load Track from URL…**. Explorer menu entries for Index File and Subsample BAM.
- **Remote data** (`data/RemoteProxy.ts`, spec §4.3): `igv.remote.mode` = `direct` (browser fetches; needs CORS + Range), `proxy` (host fetches byte ranges with Node fetch, AbortController timeout, HEAD → Content-Length or Content-Range probing, detection of servers that ignore Range) or `auto` (direct first; on a CORS/network-looking failure the track is reloaded through the proxy and the origin is remembered for the session). In proxy mode the index URL is discovered by probing the §4.4 candidates. `igv.remote.allowHttp` adds `http:` to the CSP for plain-http servers in direct mode.
- **CRAM**: works with any genome that has a sequence (local FASTA or bundled); `REFERENCE_REQUIRED` otherwise. Fixture `small.cram`.
- **webviewUri transport** (`igv.transport.mode = webviewUri`, experimental, spec §4.2): tracks are handed to igv as `asWebviewUri` URLs and the file's directory is added to `localResourceRoots`. Changing the roots reloads the webview, which destroys the igv browser, so the controller reloads, waits for the new ready handshake, recreates the browser at the same loci and replays the existing tracks. References still use the shim.
- **Genome mismatch check**: done in M2 (pulled forward).
- **Fixtures**: `small.cram` (+`.crai`), `--perf-bam-gb N` for the perf BAM; `test/tools/bin/{samtools,bgzip,tabix}` are pysam-backed shims of the real CLIs so indexing/subsampling paths run in CI and on machines without bioconda.

### Tests

| Suite | Result |
|---|---|
| unit (vitest) | 135 tests (+ RemoteProxy with a local Range server incl. no-HEAD, Range-ignoring, 404/403, timeout; broker URL handles; ToolDetector/derivedDir/job helpers; LargeFilePolicy end to end against the shims: autoIndex next to source, read-only source dir → derived dir and reuse, sort+bgzip+tabix with header handling, interactive actions/loadAnyway/cancel, missing tools, subsample by fraction and read count, Index File for FASTA/BAM/text) |
| contract (Playwright) | 6 (+ CRAM through File-likes; CRAM decoding reads the reference) |
| integration (VS Code 1.140) | 19 (+5): remote BAM in direct mode (browser Range requests observed on the server, only the reference brokered) and proxy mode (index discovered, bytes brokered, missing remote index → `INDEX_REQUIRED`, 404 → `REMOTE_UNREACHABLE`); auto mode against a server without CORS (direct fails, proxy retry succeeds, origin remembered for the next track); CRAM renders, `REFERENCE_REQUIRED` without a sequence; policy via API (`INDEX_REQUIRED` → `autoIndex` with the samtools shim → loads; subsample 50 %); webviewUri transport renders a BAM with only the reference brokered |
| perf (`npm run test:perf`, IGV_PERF=1, 4.8 GB BAM) | pass; table below |

### Perf (spec §5.4)

| Scenario (desktop, VS Code 1.140.0) | Result | Target |
|---|---|---|
| BAM size | 4.79 GB | ≥ 5 GB |
| Open + first render at a 2 kb locus | 0.49 s | < 3 s local, < 5 s code-server |
| 10 subsequent 2 kb navigations | median 0.27 s, p95 0.30 s | median < 0.5 s, p95 < 1.5 s |
| Bytes read for 10 navigations | 6.7 MB = 0.141 % of file (20 reads) | < 1 % |
| BAI (0.6 MB) | read 1× (0.6 MB) | loaded once per viewer |
| Read latency (broker, all files) | p50 0.3 ms, p95 2.15 ms over 37 reads | |

Measured on the dev machine (macOS arm64, local SSD) with `npm run test:perf` against `perf.bam` (54.2 M reads, 30x over a 180 Mb 12-chromosome reference; 4.79 GB because the size estimate uses large.bam's bytes/read). All §5.4 targets are met on desktop. The code-server numbers are still to be recorded (no code-server available locally; the M4 e2e job will produce them).

A first attempt piled the same 5 GB onto the 5 Mb fixture chromosome (~1084x): first render 1.7 s, median navigation 1.46 s, p95 8.2 s, 4.9 % of the file read over 10 navigations, because every BAI bin held ~16 MB. Realistic depth fixed all of it; see DECISIONS #34.

### Human checkpoint 2, first round (2026-10-04): mostly failed, four bugs/UX problems found

Feedback: step 1 "sort of works", step 2 not understood, step 3 (Subsample) errors, step 4 (remote bigWig) and step 5 (CRAM) "error loading the track", steps 6-7 unclear how to test.

Root causes and fixes:

1. **CRAM failed in the real webview**: igv.js decodes CRAM with WebAssembly and the spec §10 CSP has no `'wasm-unsafe-eval'`, so igv alerted "CompileError: WebAssembly.instantiate() … violates … script-src". The contract test (plain Chromium page, no CSP) and the integration test (tiny locus) did not catch it. Fixed in `viewer/html.ts`; the CRAM-by-double-click regression test now asserts rendering. Recorded as DECISIONS #35.
2. **CRAM opened at the whole-genome view**: `suggestInitialLocus` only knew BAM. It now reads the first `.crai` line (seqId, start) for CRAM, falling back to the first genome chromosome.
3. **Remote bigWig errored**: my instruction said "New Viewer → hg38", but with a default genome set "New Viewer" never asked, so the hg38 bigWig landed on the fixture genome. Two fixes: **New Viewer** always shows the genome picker with the default listed first (opening a data file still uses the default silently), and the genome mismatch check now covers remote URLs too (sequence names are read through the proxy with a few KB of range requests, in every remote mode).
4. **Subsample errored** because there is no samtools on the machine (correct `TOOL_MISSING` behaviour), and step 2 asked the human to wire up the test shims by hand. Done for them instead: `.venv/bin/{samtools,bgzip,tabix}` wrappers run the pysam shims with the venv's Python regardless of PATH, `igv.tools.paths` is now `machine-overridable` so the workspace settings can point at them, and `.vscode/settings.json` does so.
5. The genome-mismatch notification was awaited, which blocked the calling command until dismissed. It is now fire-and-forget.

### Human checkpoint 2, second round — result

Accepted by the human on 2026-10-04 ("Everything looks good"): large-file prompt and job, cancel, subsample, remote bigWig direct and proxy, wrong-genome warning, CRAM, dark theme and wording.

Checklist that was verified:

Reload the window first. Everything below works with just this repo (no bioconda needed: the workspace points `igv.tools.paths` at pysam-backed stand-ins for samtools/bgzip/tabix in `.venv/bin`).

1. **Large text file prompt.** With a viewer open on `ref.fa` (double-click `small.bam`), right-click `unindexed_big.bed` → **Add to Viewer**. A dialog should offer **Sort, compress and index (bgzip + tabix)**, **Load anyway**, Cancel. Choose the first: a progress notification runs through split/sort/bgzip/tabix (a few seconds), then `unindexed_big.bed.gz` and `.tbi` appear next to the file and the track loads.
2. **Cancel a job.** Delete the two generated files, repeat step 1 and press the notification's Cancel while it runs. The job should stop, show an error about cancellation, and leave no `.gz` track in the viewer.
3. **Subsample.** Right-click `small.bam` → **Subsample BAM…**, type `0.2`, Enter. When the notification says it is done click **Add to Viewer**: a track "small (subsample 20%)" appears with fewer reads than `small`.
4. **Remote bigWig.** Run **IGV: New Viewer**, pick `hg38` from the list (your default is listed first; skip it). Then **IGV: Load Track from URL…** → `https://hgdownload.soe.ucsc.edu/goldenPath/hg38/phyloP100way/hg38.phyloP100way.bw`. Conservation scores should appear at the default locus. Then set `igv.remote.mode` to `proxy` (Settings → IGV), open another hg38 viewer, load the same URL: same result, and **IGV: Show Output** contains "through the remote proxy". Set the mode back to `direct` afterwards.
5. **Wrong genome, remote.** On a viewer showing `ref.fa`, load the same URL: you should get the mismatch warning (chr1, chr2, … not in genome ref) with a **Set Genome…** button, instead of a bare error.
6. **CRAM.** Double-click `small.cram`: reads appear on chrT, like `small.bam`.
7. **Look and wording.** Switch to a dark theme once: is the light viewer frame acceptable? Any confusing text in the dialogs above?

### Human checkpoint 2 (first-round checklist, superseded)

1. Right-click `test/fixtures/generated/unindexed_big.bed` → **Add to Viewer** (with a viewer open on `ref.fa`). You should get a modal offering **Sort, compress and index (bgzip + tabix)** only if those tools are on your PATH; otherwise it names the missing tools and offers **Load anyway** / Cancel. Is the wording clear?
2. Set `igv.tools.paths` to the shims to try the jobs without bioconda, e.g. in `.vscode/settings.json`: `"igv.tools.paths": { "samtools": "<repo>/test/tools/bin/samtools", "bgzip": "<repo>/test/tools/bin/bgzip", "tabix": "<repo>/test/tools/bin/tabix" }` (the shims need `python3` with pysam on PATH, e.g. start VS Code from a shell with `.venv/bin` first on PATH, or use real tools if you have them). Then repeat step 1: you should see a progress notification with the sort/bgzip/tabix steps, and `unindexed_big.bed.gz` + `.tbi` appear next to the file and load as a track.
3. Right-click `small.bam` → **Subsample BAM…**, enter `0.2`, confirm, click **Add to Viewer**: a track named "small (subsample 20%)" appears.
4. **IGV: Load Track from URL…** with a public bigWig, e.g. `https://hgdownload.soe.ucsc.edu/goldenPath/hg38/phyloP100way/hg38.phyloP100way.bw` on an hg38 viewer (New Viewer → hg38). It should load directly. Then set `igv.remote.mode` to `proxy` and load it again in a new viewer: same result, and the IGV output shows "through the remote proxy".
5. Double-click `small.cram`: reads should appear like for `small.bam`.
6. Cancel a running job (start step 2 and hit Cancel in the notification): the job stops and no half-written `.gz` is loaded.
7. Dark theme and prompt wording: anything off?

### Deviations from the spec

- The resolver no longer knows about `autoIndex`/`subsample`; those are the policy's job. Human-facing prompts list only actions whose tools exist and name the missing tools otherwise.
- `samtools faidx` writes next to the FASTA only (htslib has no output option for the plain case); a read-only reference directory reports an error with the command to run elsewhere.
- Subsample by target read count runs `samtools view -c` first (streams the file once), as there is no index to count from.
- Remote index discovery via probing happens only in proxy mode; in direct mode igv.js does its own guessing in the browser.
- `looksLikeNetworkError` is a heuristic on igv's error text (e.g. "Error accessing resource: … status: 0"); it is the only signal the browser gives for CORS failures.

### Findings

- Assigning `webview.options` with new `localResourceRoots` reloads the webview (desktop VS Code 1.140), confirming spec §4.2. The replay path is tested.
- Desktop VS Code's `vscode-resource` handler serves HTTP 206 ranges for `asWebviewUri` URLs: the webviewUri BAM test passes on desktop, not only on code-server as in the spike.
- Real `tabix` fails on `track`/`browser` lines in BED files ("Failed to parse TBX_GENERIC"); the compress job drops them.

## M4 — Agent control API and CLI

**Status:** built; desktop acceptance met by automated tests. The code-server e2e harness is written for CI (no Docker on the dev machine); first CI run pending. Human try-out below (optional, no formal checkpoint in the spec).

### Built

- **Control channel** (`agent/ControlServer.ts`, spec §6.2): JSON-RPC 2.0, newline-delimited, over a Unix domain socket (`$XDG_RUNTIME_DIR` or tmpdir, `igv-vscode-<id>.sock`, mode 0600) or a Windows named pipe. Never TCP. 32-byte random token on every request, compared in constant time (SHA-256 digests + `timingSafeEqual`). Errors map to JSON-RPC `-32000` with `data.code` from the spec's list (plus `UNAUTHORIZED` → `-32001`), `-32601` for unknown methods, `-32700/-32600` for framing problems.
- **Instance registry** (`agent/registry.ts`): `~/.igv-vscode/instances/<id>.json` (0600) with endpoint, token, pid, workspace folders, timestamps; written on activation, refreshed every 30 s and on each request, removed on deactivate; dead pids and malformed files pruned by the CLI. Selection: `--instance`, else the instance whose workspace folder contains the cwd (deepest match), else most recently active. `IGV_VSCODE_HOME` overrides the directory (tests).
- **Methods** (`agent/api.ts`, spec §6.3): all 14 — `ping`, `viewer.open` (reuse new/active/byName, show, waitForRender, timeoutMs, cwd for relative paths), `viewer.list/state/goto/setGenome`, `tracks.add/remove/update`, `viewer.snapshot` (png/svg, out, scale, inline base64, default dir), `session.save/load`, `viewer.close`, `genomes.list`. `waitForRender` = `ViewerController.settle()` (no reads for 250 ms and no pending igv loads), reported as `settled`. Agent-opened viewers use `ViewColumn.Beside` + `preserveFocus`. Large-file policy runs in agent mode (`autoIndex`, `subsample`, `loadAnyway`).
- **`tracks.update`**: live option changes (colour, height via `setTrackHeight`, displayMode, visibilityWindow, sampling, …) with cache clearing and repaint in the webview; options validated host-side.
- **AgentService** (`agent/AgentService.ts`): starts the server unless the workspace is in Restricted Mode or `igv.agent.enabled` is false; injects `IGV_VSCODE_ENDPOINT`, `IGV_VSCODE_TOKEN` and the launcher dir on `PATH` into new integrated terminals via `environmentVariableCollection`; writes the launchers on every activation.
- **CLI launchers** (`agent/CliInstaller.ts`, spec §6.4): `globalStorage/bin/igv-vscode` (`ELECTRON_RUN_AS_NODE=1 exec "<execPath>" "<ext>/dist/cli.js" "$@"`) and `igv-vscode.cmd`. Verified on desktop: the launcher runs through `Code Helper (Plugin)` as Node 24. **IGV: Install CLI on PATH** symlinks into `~/.local/bin` (instructions on Windows).
- **CLI** (`agent/cli.ts`): `open, goto, add, remove, update, state, list, snapshot, session save|load, set-genome, close, genomes, ping, install-skill, mcp (M5)`, `--json` (default when stdout is not a TTY), `--viewer`, `--instance`, `--track-opt NAME.key=value`, `--index FILE=IDX`, `--auto-index`, `--no-wait`, `--timeout`; exit codes 0/1/2/3/4 as specified; example-rich `--help`. Uses `node:util.parseArgs`, no runtime dependencies.
- Fix found along the way: igv's `search()` takes one string; multiple loci are passed space-separated (arrays made igv throw `e.trim is not a function`).

### Tests

| Suite | Result |
|---|---|
| unit (vitest) | 139: control server framing/token/errors over a real socket, client timeouts and closed connections, registry 0600/pruning/selection by cwd and recency, discovery (env > registry > --instance, skipping unreachable instances), launcher contents and symlink install, CLI argument handling and an end-to-end run against a fake instance |
| contract | 6 |
| integration (VS Code 1.140) | 27 (+4): launcher + ping via env discovery; the full command sequence open → state --verbose → goto (single and multi-locus) → add → update (valid and invalid option) → remove → snapshot png/svg(--inline) → session save → close → session load → set-genome → list → genomes → close --all; error codes NO_VIEWER / VIEWER_NOT_FOUND / FILE_NOT_FOUND / INDEX_REQUIRED and exit 3 on a bad token; registry discovery by cwd with a 0600 socket |
| code-server e2e | harness in `test/e2e-code-server/` (`run.mjs`, Dockerfile, entrypoint): code-server 4.140.0 and 4.102.0 × shim/webviewUri, system node removed from the image (build fails if `node` is still found), CLI typed into the integrated terminal with results read back from files via `docker exec`; asserts host=code-server, two tracks load, SVG has >50 rects, PNG signature, state inView, close. Runs in CI only (no Docker here); artifacts: screenshots, code-server log, JSON outputs. webviewUri on 4.102.0 is `continue-on-error` because range support may be missing there. |

### Deviations from the spec

- The extension now activates on `onStartupFinished` (plus commands/editors), so the control channel, registry entry and terminal PATH injection exist before any human action. Without it an agent in a fresh window would find no instance (noticed while writing the e2e harness). Activation is cheap: no viewer is created.
- "Multi-window discovery test (two instances, cwd selection)" is covered by a unit test with two live control servers and registry records rather than two VS Code windows; the selection logic is the same code the CLI runs.
- `UNAUTHORIZED` was added to the error-code list for bad tokens (the spec's list had no fitting code).
- The CLI's `update` subcommand (live track options) is an addition mirroring `tracks.update`.

### Try it (optional)

Open a new integrated terminal (the PATH injection applies to terminals opened after reload) and run:

```sh
igv-vscode ping
igv-vscode open --locus chrT:1,001-3,000 test/fixtures/generated/small.bam test/fixtures/generated/genes.bed
igv-vscode goto chrT:10,001-12,000
igv-vscode snapshot --out /tmp/view.png && open /tmp/view.png
igv-vscode state --json | head -30
igv-vscode close
```

## M5 — MCP and agent docs

**Status:** accepted. Automated acceptance (MCP client over stdio) plus the Claude Code stand-in run; the human then used the igv MCP tools from their own Claude Code session to open small.bam on chrT ("Looks perfect!", 2026-10-04).

### Built

- **MCP server** (`agent/mcp.ts`, `igv-vscode mcp`, spec §6.5) on `@modelcontextprotocol/sdk` 1.32 (stdio transport, zod 3 schemas), bundled into `dist/cli.js` (1.0 MB). Tools: `igv_open`, `igv_goto`, `igv_add_tracks`, `igv_remove_tracks`, `igv_state`, `igv_list_viewers`, `igv_snapshot`, `igv_save_session`, `igv_load_session`, `igv_close`, `igv_list_genomes`. Every description states the coordinate convention and has an example; the server `instructions` explain the open → snapshot → look loop and how to read `inView`. `igv_snapshot` returns `image` content (PNG base64) plus a text block with path and locus; SVG comes back as text. Errors are structured tool errors (`isError`, JSON with `code`/`hint`); when no instance is reachable the message says VS Code with the extension must be open. The control endpoint is discovered lazily on the first call (same discovery as the CLI), so the server starts even before VS Code does.
- **Skill** `agent/SKILL.md` (63 lines): when to use, core loop, command table, coordinates (incl. BED 0-based conversion), reading `state`, large/remote-file errors, etiquette. Shipped in the VSIX; **IGV: Add Agent Skill to Workspace** copies it to `.claude/skills/igv/SKILL.md`; `igv-vscode install-skill [DIR]` does the same from the CLI.
- **IGV: Copy MCP Setup Command** copies `claude mcp add igv -- '<absolute launcher>' mcp` and offers to add the skill.
- **Docs**: `docs/agents.md` (connection model, CLI reference, reading state, large files, MCP, Claude Code setup, other clients, troubleshooting table); README section for agents.

### Tests

| Suite | Result |
|---|---|
| unit (vitest) | 142 (+3 MCP via in-memory transports against a fake control server: tool list/descriptions, forwarded params with cwd, PNG image content, structured errors, unreachable-instance message) |
| integration (VS Code 1.140) | 28 (+1): the SDK client spawns `igv-vscode mcp` through the launcher over stdio, lists the 11 tools, runs open → add → goto → snapshot (PNG image content verified by signature and size, SVG as text) → state → remove → save → list → genomes → close → load → close, and a `NO_VIEWER` structured error |
| contract | 6 |

### Deviations from the spec

- The optional P2 registration with VS Code's MCP provider API (`vscode.lm.registerMcpServerDefinitionProvider`) is not implemented in v1; Claude Code and other stdio clients are the target. Feature-detect and add later if wanted.
- The skill is 63 lines (spec: under ~120).

### Checkpoint 3, automated stand-in (2026-10-04)

The human asked whether the checklist could be run for them. Items 1-4 and 6 were run end to end without a human:

- `claude mcp add igv -- '<launcher>' mcp` registered at local scope for this project (`~/.claude.json`), and `.claude/skills/igv/SKILL.md` installed. The launcher appears in the human's own window after a reload (the running build predates the control server).
- New gated test `test/integration/m5-claude-e2e.test.ts` (`npm run test:claude-e2e`, needs `IGV_CLAUDE_E2E=1` and the `claude` binary; costs Claude usage): Claude Code 2.1.288 is run with `-p --mcp-config … --strict-mcp-config` pointed at a fresh VS Code test instance. Result (9 turns, $0.34, 50 s): it opened `large.bam` on `ref.fa`, took a snapshot, placed the SNP at chrS:1,000,000 with alternate base **C** at **~50 %** (coverage ~47×), explained the empty 200 kb view via `inView:false` / `outsideVisibilityWindow`, quoted the `File not found: …does-not-exist.bam` error verbatim, and closed its viewer. Transcript saved to `test/fixtures/generated/CLAUDE_E2E.md`.
- One model error, not a tool error: it read the reference base's colour as "T (orange)"; igv draws A green, C blue, G orange, T red, and the reference here is A. Fix: the skill and the MCP server instructions now carry igv's base-colour legend and advise reading the printed letter at narrow zoom.

Remaining for the human (subjective): items 5 and 7 below, plus a look at the transcript.

### Human checkpoint 3 (spec §11.3, §12 M5) — original checklist

1. Reload the window. Run **IGV: Copy MCP Setup Command**, then paste the copied command in a terminal (outside or inside VS Code) and run it. `claude mcp list` should show `igv`.
2. Run **IGV: Add Agent Skill to Workspace** (creates `.claude/skills/igv/SKILL.md`).
3. Start Claude Code in this repo and ask: *"Open test/fixtures/generated/large.bam on test/fixtures/generated/ref.fa at chrS:999,950-1,000,050, take a snapshot and describe what you see at position 1,000,000."* Expected: Claude opens a viewer beside the editor, calls `igv_snapshot`, and describes a heterozygous A>C SNP (about half the reads carry C) at chrS:1,000,000.
4. Ask it to zoom out to `chrS:1-200,000` and explain why the alignment track looks empty (it should mention the visibility window / `inView: false`).
5. Is the skill text clear? Anything missing that you had to tell Claude yourself?
6. Prompt and error wording when something goes wrong (e.g. ask it to open a file that does not exist).
7. Dark theme: still fine with agent-opened viewers appearing beside the editor?

## M6 — Hardening and release

**Status:** built. All automated suites green on the dev machine. Publishing is deliberately not done (human decision: register a publisher once the extension is complete).

### Built

- **Error-path review**: `docs/errors.md` maps every `data.code` to when it occurs, what the hint contains and which test covers it. New integration test `m6-hardening` exercises `UNSUPPORTED_FORMAT`, `GENOME_NOT_FOUND`, `TOOL_MISSING` (PATH emptied for the CLI process) and `REFERENCE_REQUIRED` through the CLI, and confirms a `waitForRender` timeout is reported as `settled:false`, not as an error.
- **Memory and handles**: 20 open/close cycles of a viewer with BAM + bigWig + BED (snapshots every 5th): every viewer's allow-list is released, `openHandleCount` returns to 0, peak open handles 6 (the files of one viewer), extension-host heap growth 1.4 MB.
- **Output channel**: every line carries a timestamp, level and tag (`[v1]`, `[agent]`, `[job]`, `[policy]`); tool jobs log the exact commands; igv alerts and webview errors are forwarded with stacks.
- **Accessibility basics**: quick picks have placeholders and descriptions; notifications carry action buttons; the status bar item has a name and a tooltip; the webview root is `role="application"` with an `aria-label`, and the status line is `role="status" aria-live="polite"`. igv's own canvas UI is not restyled (spec §8.3).
- **README**: unofficial notice, screenshots (`docs/images/`, produced with the extension's own snapshot via MCP), one-minute BAM quick start, Claude Code setup, large/remote files, CodeOcean post-install snippet (spec §13), docs index, citation. `docs/settings.md` is generated from `package.json` (`npm run settings-doc`); `docs/troubleshooting.md` and `docs/errors.md` added.
- **Release configuration**: `.github/workflows/release.yml` builds the VSIX on a `vX.Y.Z` tag and attaches it to a GitHub Release (refusing if the publisher is still the placeholder); marketplace publishing is a manual `workflow_dispatch` job gated on `VSCE_PAT`/`OVSX_PAT`. `npm run publish:vsce` / `publish:ovsx` exist for local use. Name check (spec §1.1): `igv-vscode` is unclaimed on both the VS Marketplace (no igv-related extensions at all) and Open VSX (2026-10-04).

### Tests

| Suite | Result |
|---|---|
| unit | 142 |
| contract | 6 |
| integration (VS Code 1.140, macOS) | 31 (+3) |
| perf | pass (table in M3) |
| Claude Code e2e (gated) | pass |
| code-server e2e | written for CI, not yet run (no Docker locally) |

### Story traceability (spec §2, §16)

| Story | Evidence |
|---|---|
| H1 click a BAM, index found, genome asked/remembered | custom editor tests (`m2`), human checkpoints 1-2 |
| H2 multi-select Add to Viewer | `m1` "commands" test, human checkpoint 1 |
| H3 Go to Locus from Selection | `m2`, unit `locusParser`, human checkpoint 1 |
| H4 50 GB BAM responsive, bytes limited | perf job on a 4.8 GB BAM (0.14 % read over 10 navigations, median 0.27 s) |
| H5 500 MB unindexed BED prompt | `largeFilePolicy` unit, `m1`/`m4` `INDEX_REQUIRED`, human checkpoint 2 |
| H6 session with relative paths across machines | `m2` moved-directory round trip, `sessionStore` unit |
| H7 identical on CodeOcean | code-server e2e harness (CI); spike findings; **not yet observed on CodeOcean itself** |
| A1 `igv-vscode open …` beside the editor, JSON | `m4-cli` |
| A2 goto | `m4-cli` |
| A3 snapshot PNG | `m4-cli`, `m5-mcp` |
| A4 state JSON | `m4-cli` |
| A5 Claude Code via MCP | `m5-mcp`, Claude e2e, human session ("Looks perfect!") |
| A6 `.igv.json` + `code file` fallback | custom editor for `.igv.json` (`m2`) |

### Definition of done (spec §16) — status

- All milestones accepted: yes (M0-M5 human-accepted; M6 automated).
- CI green on three OSes plus code-server e2e: **pending** — the repository has not been pushed to GitHub yet, so the workflows have never run. First push will tell.
- README lets a new user install, open a BAM, set up Claude Code, get an agent snapshot: written; please judge the "under 5 minutes" claim.
- Data safety: the webview can only read allow-listed files (per-viewer file ids; verified in `m1`); the control channel is a 0600 socket, token-authenticated (`controlChannel` unit, `m4-cli` bad-token test); absolute paths never enter the webview (markers hydrated to opaque handles).

### Open items for the human before a release

1. Push the repo to GitHub (nothing is committed yet) and watch the three workflows; fix whatever Linux/Windows reveal.
2. Decide the publisher id and GitHub org; replace `igv-vscode-dev` in `package.json` (`publisher`, `repository`, `bugs`, `homepage`) and in the README/CodeOcean snippet.
3. Optionally try the extension on a real CodeOcean capsule (H7) and record the perf numbers there.
4. Bump the version (`0.1.0` suggested) and move the CHANGELOG "Unreleased" entries under it before tagging.
