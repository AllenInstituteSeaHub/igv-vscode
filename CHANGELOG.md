# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-10-04

First release. Installed from the VSIX (uploaded by hand to the VS Marketplace until automated publishing is enabled).

### Added
- Project scaffold: TypeScript, esbuild bundles (extension, webview, cli), eslint, vitest, CI.
- Bundled igv.js 3.8.9 and the igv-data genome list.
- Command **IGV: New Viewer** opens a webview with igv.js and a genome from the bundled list.
- Command **IGV: Show Output**.
- Setting `igv.defaultGenome`.
- Local data files stream through a File-like shim with a per-viewer allow-list; byte ranges are read on demand (BAM/BAI, CRAM, bigWig, bigBed, TDF, tabix-indexed text, FASTA).
- Commands **Add to Viewer**, **Open in New Viewer**, **Go to Locus…**, **Set Genome…**, **Remove Track…**; Explorer context menu for genomic file types.
- Local FASTA/2bit references and user-defined genomes (`igv.genomes.custom`).
- Settings for alignment/variant visibility windows, sampling, unindexed-file limit and transport.
- Large unindexed files are refused with the exact indexing command instead of being loaded whole.
- Custom editors: double-click BAM/CRAM/bigWig/bigBed/TDF/2bit/`.igv.json` files to open them in IGV; text formats via "Open With…".
- `.igv.json` session files with relative paths (**Save Session…**, **Load Session…**); plain igv.js sessions load too.
- Viewers are restored after a window reload.
- Status bar locus, **Go to Locus from Selection** (locus, VCF, BED, GFF/GTF, SAM lines, gene names), **Export Snapshot…** (PNG/SVG).
- Genome mismatch detection: tracks whose sequence names are absent from the genome are flagged with a **Set Genome…** offer.
- Large files: prompts to index (samtools/tabix), sort+bgzip+tabix, or subsample; **Index File…**, **Subsample BAM…**; generated files go next to the source or into `igv.largeFile.derivedDir`.
- Remote URLs: direct, proxy (fetched by the extension host) and auto modes; **Load Track from URL…**.
- CRAM support with any genome that has a sequence.
- Experimental `igv.transport.mode: webviewUri`.
- MCP server (`igv-vscode mcp`) with `igv_open`, `igv_goto`, `igv_snapshot` (returns the image) and friends; **IGV: Copy MCP Setup Command**; Claude Code skill via **IGV: Add Agent Skill to Workspace**.
- Agent control channel (local socket, token-authenticated) and the `igv-vscode` CLI: open, goto, add, remove, update, state, list, snapshot, session save/load, set-genome, close, genomes, ping. Available in integrated terminals automatically; **IGV: Install CLI on PATH** for other terminals.
