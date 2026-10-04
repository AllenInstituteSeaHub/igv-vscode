---
name: igv
description: Look at genomic data (BAM/CRAM alignments, VCF variants, bigWig coverage, BED/GFF annotations) in the IGV viewer inside VS Code. Use when asked to inspect reads, variants, coverage or features at a locus, to check an alignment or a variant call visually, or to make a figure of a genomic region.
---

# IGV in VS Code via the `igv-vscode` CLI

The IGV Viewer extension exposes a local control channel. The `igv-vscode` CLI is on PATH in VS Code terminals (elsewhere, run the command **IGV: Install CLI on PATH** once). Everything also exists as MCP tools (`igv_open`, `igv_goto`, `igv_snapshot`, …) if the `igv` MCP server is configured.

## When to use it

- You need to *see* alignments, coverage, variants or annotations at a locus rather than parse the file.
- A user asks "what does this region/variant look like", "is this deletion real", "show me gene X".
- You produce a figure of a locus for a report.

## Core loop

```sh
igv-vscode open --genome hg38 --locus chr17:7,668,402-7,687,550 tumor.bam normal.bam   # opens beside the editor
igv-vscode snapshot --out /tmp/tp53.png                                                 # then LOOK at the image
igv-vscode goto chr17:7,673,700-7,673,900                                               # zoom to a variant
igv-vscode snapshot --out /tmp/tp53-zoom.png
```

Always take a snapshot after changing the view and inspect it before drawing conclusions. The viewer is for the human too: say which viewer you changed.

## Commands

| Command | Purpose |
|---|---|
| `open [FILES] --genome G --locus L [--name N]` | New viewer with tracks. `--reuse-active` to reuse the current one. `--track-opt NAME.key=value` sets igv options (`color=#cc0000`, `height=300`, `displayMode=SQUISHED`, `visibilityWindow=100000`). |
| `goto LOCUS [LOCUS...]` | Navigate; gene names work (`goto TP53`); several loci give a split view. |
| `add FILES...` / `remove NAME...` / `update NAME key=value...` | Manage tracks of the active (or `--viewer V`) viewer. |
| `state [--verbose]` | JSON: genome, loci, tracks (`inView`, `inViewReason`, `error`). |
| `snapshot [--out PATH] [--format png\|svg] [--scale 2]` | Picture of exactly what is shown. |
| `session save PATH` / `session load PATH` | `.igv.json` with relative paths; commit it for colleagues. |
| `set-genome G [--keep-tracks]`, `list`, `close [--all]`, `genomes [FILTER]`, `ping` | Housekeeping. |

Output is JSON when piped (`--json` to force). Exit codes: 0 ok, 1 usage, 2 operation error (JSON `error.code` + `error.hint` on stderr), 3 VS Code/extension not reachable, 4 timeout.

## Coordinates

1-based, inclusive, as IGV displays them: `chr8:127,736,588-127,739,371`. Commas are fine. BED is 0-based half-open: a BED line `chr1 999 2000` is locus `chr1:1,000-2,000`. VCF `POS` is already 1-based.

## Reading snapshots

igv colours bases: **A green, C blue, G orange, T red**. In an alignment track a coloured column across many reads is a mismatch against the reference (the reference track shows the reference base in the same colours); grey reads match. The coverage bar above the reads is coloured at mismatching positions in proportion to allele counts. Insertions are purple marks, deletions black bars, soft clips are shown only if enabled. Forward reads are drawn pointing right. Don't trust colour alone for the reference base: at narrow views the letter is printed too.

## Reading `state`

- `inView: false, inViewReason: "outsideVisibilityWindow"`: the view is wider than the track's visibility window (alignments: 30 kb by default). The track looks empty on purpose. `goto` a narrower locus or raise `visibilityWindow` with `update NAME visibilityWindow=200000` (costly on deep data).
- `inViewReason: "genomeMismatch"`: the file's chromosomes (e.g. `1`, `2`) do not exist in the genome (`chr1`, `chr2` are aliased automatically; other names are not). Use `set-genome` or open with the right `--genome`.
- `error`: igv's load error text, if the track failed.

## Large and remote files

- `INDEX_REQUIRED`: an unindexed BAM/CRAM or big text file. `error.hint` holds the exact fix (`samtools index …` or `sort | bgzip | tabix`). Re-run with `--auto-index` to let the extension run it (needs samtools/tabix on PATH or `igv.tools.paths`), or ask the user.
- `TOOL_MISSING`: the tool is not installed; tell the user how (hint has the commands). Never try to install software yourself without asking.
- `REFERENCE_REQUIRED`: CRAM needs a genome with a sequence (any bundled genome or a local FASTA).
- `https://` URLs work directly when the server supports CORS and Range; otherwise set `igv.remote.mode` to `proxy`. `s3://`/`gs://` need presigned HTTPS URLs.
- Use `--genome path/to/ref.fa` (with `.fai`) for non-model organisms.

## Etiquette

- Prefer `--reuse-active` when the user is already looking at a viewer; use `--name` for parallel comparisons.
- Close viewers you opened for yourself (`close --viewer V`) when done; leave the user's viewers alone.
- If the CLI exits 3, VS Code is not running the extension (or Restricted Mode is on): tell the user instead of retrying.
