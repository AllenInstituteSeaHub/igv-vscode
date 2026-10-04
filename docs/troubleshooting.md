# Troubleshooting

Start with **IGV: Show Output**: the "IGV" channel logs activation, every viewer (`[v1]`, `[v2]`, …), webview errors, igv alerts, external tool commands (`[job]`), policy decisions (`[policy]`) and the agent channel (`[agent]`).

## The viewer is empty

- **Alignment track blank, wide view.** igv hides reads above the track's visibility window (30 kb by default). Zoom in, or raise `igv.alignment.visibilityWindow` / the track's `visibilityWindow` option. Agents see `inView:false, inViewReason:"outsideVisibilityWindow"`.
- **Wrong genome.** You get a warning "… refer to sequences (chrS, chrT) that are not in the genome hg38" with a **Set Genome…** button. Pick the matching genome, or a local FASTA via "Local FASTA or 2bit file…". `chr1` vs `1` is aliased automatically; other naming schemes are not.
- **Whole-genome view ("all").** Double-click a data file to open where its data is, or **Go to Locus…**.

## Opening files

- Double-click works for BAM, CRAM, bigWig, bigBed, TDF, 2bit and `.igv.json`. Text formats (BED, VCF, GFF, FASTA, …) open as text by design; right-click → **Add to Viewer**, or **Open With… → IGV Viewer**.
- **"X is N MiB and has no index"**: choose an action in the dialog (index, sort+compress+index, subsample, load anyway). If tools are missing the dialog says which; install them (`conda install -c bioconda samtools htslib`) or set `igv.tools.paths`.
- **"Error loading track … status: 0"** for a URL: the server blocks cross-origin requests. Set `igv.remote.mode` to `proxy` (or `auto`).
- **`s3://`, `gs://`**: not supported in v1; use presigned HTTPS URLs.
- **CRAM**: needs a genome with a sequence; "REFERENCE_REQUIRED" otherwise.

## Sessions

- Paths in `.igv.json` are relative to the file; moving the file alone breaks them, moving the whole folder does not.
- Plain igv.js sessions load too; unknown keys are kept.
- After **Reload Window** viewers come back from a snapshot kept for 7 days; if a file moved in between you get a warning per track.

## CLI and agents

- `igv-vscode: command not found` → open a **new** integrated terminal (PATH is injected into new terminals only) or run **IGV: Install CLI on PATH**.
- Exit 3 / "No running VS Code with the IGV extension was found" → VS Code is not running the extension, the workspace is in Restricted Mode, or `igv.agent.enabled` is false. From outside VS Code: `ls ~/.igv-vscode/instances/` should list a live window. Stale entries (dead pids) are pruned automatically.
- Several windows: `igv-vscode ping --json` shows which instance was chosen (by current directory, then recency); force one with `--instance ID`.
- Claude Code: `claude mcp list` must show `igv` connected; the command from **IGV: Copy MCP Setup Command** embeds the absolute launcher path, which changes when the extension updates on some platforms, so re-run it after an update if the server fails to start.
- A snapshot looks stale: `settled:false` in the result means rendering had not finished within the timeout; snapshot again.

## code-server / CodeOcean

- Install with `code-server --extensions-dir=/.vscode/extensions --install-extension igv-vscode-x.y.z.vsix` in the post-install script (see README).
- `/data` is read-only: generated indexes go to `igv.largeFile.derivedDir` (default: the extension's global storage). Point it at `/results` or your workspace if you want to keep them.
- Remote URLs in `direct` mode are fetched by your laptop's browser; in `proxy` mode by the capsule. Use `proxy` when the capsule can reach a server your browser cannot (or vice versa, `direct`).
- No system `node` is needed: the CLI launcher uses code-server's own runtime.

## Reporting a problem

Attach the IGV output channel, your `igv.*` settings, the file format(s) involved and, for agents, the JSON error. Never attach the token from `~/.igv-vscode/instances/`.
