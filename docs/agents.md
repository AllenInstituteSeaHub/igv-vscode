# Driving IGV from agents and scripts

igv-vscode exposes everything a human can do in the viewer through a local control channel, used by the `igv-vscode` CLI (and, from M5, an MCP server).

## How it connects

- The extension listens on a Unix domain socket (`$XDG_RUNTIME_DIR` or the temp dir, `igv-vscode-<id>.sock`, mode 0600) or a Windows named pipe. Never a TCP port, so it also works on locked-down hosts such as CodeOcean.
- Every request carries a random 32-byte token. Integrated terminals get `IGV_VSCODE_ENDPOINT` and `IGV_VSCODE_TOKEN` injected (new terminals only). Other processes find the window through `~/.igv-vscode/instances/<id>.json` (0600): the CLI picks the window whose workspace folder contains the current directory, else the most recently active one, or `--instance ID`.
- The channel is disabled in Restricted Mode and when `igv.agent.enabled` is `false`; the CLI then exits with code 3.

## CLI

```sh
igv-vscode open [FILES...] --genome G --locus L [--name N] [--track-opt NAME.key=value] [--auto-index]
igv-vscode goto LOCUS [LOCUS...]          # gene names work
igv-vscode add FILES...                   # --index FILE=IDX, --auto-index
igv-vscode update NAME color=#cc0000 height=300 displayMode=SQUISHED
igv-vscode remove NAME...
igv-vscode state [--verbose]              # JSON: genome, loci, tracks (inView, inViewReason, error), metrics
igv-vscode snapshot [--format png|svg] [--out PATH] [--scale 2] [--inline]
igv-vscode session save PATH | session load PATH
igv-vscode set-genome G [--keep-tracks]
igv-vscode list | close [--all] | genomes [FILTER] | ping
```

Exit codes: 0 ok, 1 usage, 2 operation error (JSON error on stderr with `code` and `hint`), 3 no reachable instance / agent API disabled, 4 timeout. `--json` is the default when stdout is not a TTY.

Coordinates are **1-based, inclusive**, as IGV displays them (`chr8:127,736,588-127,739,371`). Relative paths resolve against the CLI's current directory.

### Reading `state`

- `tracks[].inView: false` with `inViewReason: "outsideVisibilityWindow"` means the view is wider than the track's visibility window (30 kb for alignments by default): zoom in with `goto`.
- `inViewReason: "genomeMismatch"` means the file's sequence names are not in the genome: use `set-genome`.
- `error` holds igv's load error, if any.

### Large files

An unindexed BAM or text file above `igv.largeFile.unindexedMaxBytes` returns `INDEX_REQUIRED` with `hint` (the exact `samtools index` / `sort | bgzip | tabix` command). Pass `--auto-index` to let the extension run it (needs the tools on PATH or `igv.tools.paths`), or add `"subsample": {"fraction": 0.1}` in a session/track spec. Generated files go next to the source when writable, else into `igv.largeFile.derivedDir`.

## Zero-dependency fallback

Write an `.igv.json` session (see README) and run `code analysis.igv.json`; the file opens as a viewer.

## MCP server

`igv-vscode mcp` runs an MCP server over stdio with the tools `igv_open`, `igv_goto`, `igv_add_tracks`, `igv_remove_tracks`, `igv_state`, `igv_list_viewers`, `igv_snapshot`, `igv_save_session`, `igv_load_session`, `igv_close` and `igv_list_genomes`. Schemas mirror the control API; every description states the coordinate convention and gives an example. `igv_snapshot` returns the PNG as **image content** plus a text block with the saved path and locus, so the agent can look at the view. When no VS Code instance is reachable, tools return an error explaining that VS Code with the extension must be open.

### Claude Code

1. In VS Code run **IGV: Copy MCP Setup Command**. It copies a command with the absolute launcher path, e.g.

   ```sh
   claude mcp add igv -- '/Users/you/Library/Application Support/Code/User/globalStorage/alleninstituteseahub.igv-vscode/bin/igv-vscode' mcp
   ```

   If `igv-vscode` is on your PATH (**IGV: Install CLI on PATH**), `claude mcp add igv -- igv-vscode mcp` works too.
2. Run **IGV: Add Agent Skill to Workspace** to write `.claude/skills/igv/SKILL.md` (or `igv-vscode install-skill .`). The skill teaches Claude the CLI, the coordinate convention, how to read `inView:false`, to snapshot after every change, and what the large-file errors mean.
3. Start Claude Code in the workspace (an integrated terminal is simplest) and ask, for example: "Open test/fixtures/generated/small.bam on ref.fa, zoom to chrT:1,000-3,000 and describe what you see."

The MCP server finds the VS Code window the same way the CLI does (environment variables in integrated terminals, else `~/.igv-vscode/instances/` by working directory).

### Other MCP clients

Any stdio MCP client can run `igv-vscode mcp` (or the launcher path). Example Claude Desktop / generic config:

```json
{ "mcpServers": { "igv": { "command": "/path/to/globalStorage/alleninstituteseahub.igv-vscode/bin/igv-vscode", "args": ["mcp"] } } }
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `igv-vscode: command not found` | Open a *new* integrated terminal (PATH is injected into new terminals), or run **IGV: Install CLI on PATH**. |
| exit 3 / "No running VS Code…" | VS Code is not running the extension, the workspace is in Restricted Mode, or `igv.agent.enabled` is false. From outside VS Code, check `ls ~/.igv-vscode/instances/`. |
| `INDEX_REQUIRED` | Run the command in `hint`, or use `--auto-index` (needs samtools/tabix). |
| `GENOME_MISMATCH` / `inViewReason: genomeMismatch` | The genome does not contain the file's chromosomes; `set-genome`. |
| Empty alignment track, `outsideVisibilityWindow` | Zoom in below the visibility window (30 kb default). |
| Remote URL fails | Server lacks CORS or Range support; set `igv.remote.mode` to `proxy`. |
| Snapshot looks stale | `waitForRender` timed out (`settled:false`); take the snapshot again after a moment. |
