# Error codes

Every control-channel error carries `data.code` (one of the codes below), a human-readable `message`, and where possible a `hint` with the concrete fix. The CLI prints `{ "error": { code, message, hint } }` on stderr and exits 2 (3 for the last two rows, 4 for TIMEOUT). MCP tools return the same JSON as a tool error.

| Code | When | Hint contains | Covered by |
|---|---|---|---|
| `NO_VIEWER` | A command needs a viewer and none is open | open one | integration `m4-cli` |
| `VIEWER_NOT_FOUND` | `--viewer` id/name unknown; track id/name unknown | list of open viewers / tracks | integration `m4-cli` |
| `FILE_NOT_FOUND` | Data, index, reference or session file missing; broker read of an unregistered file | path | integration `m1`, `m4-cli`; unit broker |
| `UNSUPPORTED_FORMAT` | Unknown extension without `type`+`format`; `.sam`; `s3://`/`gs://`; reference or session given as a track; bad track option | `samtools view -b` for SAM, presigned URL for s3/gs, allowed option keys | unit `trackResolver`; integration `m6` |
| `INDEX_REQUIRED` | Unindexed BAM/CRAM or text above `igv.largeFile.unindexedMaxBytes`; remote BAM without a discoverable index; FASTA without `.fai` above 10 MiB | exact `samtools index` / `sort \| bgzip \| tabix` / `samtools faidx` command, `--auto-index` | unit `trackResolver`, `largeFilePolicy`; integration `m1`, `m3`, `m4-cli` |
| `REFERENCE_REQUIRED` | CRAM on a genome without a sequence | load a genome with FASTA/2bit | integration `m3`, `m6` |
| `GENOME_NOT_FOUND` | Unknown genome id/name; no genome and no default | suggestions, `igv-vscode genomes` | unit `genomeRegistry`; integration `m6` |
| `GENOME_MISMATCH` | (warning, not an error) a track's sequence names are absent from the genome; track gets `inView:false, inViewReason:"genomeMismatch"` | Set Genome… | integration `m1`, `m3-human-flows` |
| `REMOTE_UNREACHABLE` | HTTP error, timeout, no Content-Length, server ignoring Range with a large body | check URL / network / Range support | unit `remoteProxy`; integration `m3` |
| `TOOL_MISSING` | `autoIndex`/`subsample`/Index File… needs samtools, bgzip, tabix or sort and it is not on PATH or in `igv.tools.paths` | install commands | unit `largeFilePolicy`; integration `m6` |
| `TIMEOUT` | Webview did not become ready; CLI request timed out (exit 4). `waitForRender` timeouts are **not** errors: the result has `settled:false` | | unit `rpc`, `controlChannel` |
| `AGENT_DISABLED` | CLI/MCP found no reachable instance (Restricted Mode, `igv.agent.enabled` false, VS Code not running) → exit 3 | how to enable | unit `cli`; integration `m4-cli` (bad token path) |
| `UNAUTHORIZED` | Request without a valid token (JSON-RPC `-32001`) → exit 3 | use the CLI from a VS Code terminal or the registry token | unit `controlChannel`; integration `m4-cli` |
| `INTERNAL` | Anything else (bug, bad parameters, unknown method `-32601`) | | unit `rpc`, `controlChannel` |
