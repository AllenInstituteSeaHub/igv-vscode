# igv-vscode — notes for coding agents

VS Code extension embedding igv.js 3.8.9, with a CLI and MCP server for agents. Design spec: `IGV_VSCODE_DESIGN_SPEC.md` (read §3, §6, §14 first). Milestone log and test results: `PROGRESS.md`. Design decisions: `docs/DECISIONS.md` — add a row whenever you choose something the spec does not cover.

## Build and test

```sh
npm install && npm run build      # vendors igv.js + genome list, bundles extension/webview/cli
npm run check                     # typecheck + lint + unit (vitest)
npm run test:contract             # Playwright: pins igv.js behaviour (needs fixtures)
npm run test:integration          # real VS Code via @vscode/test-cli (needs fixtures + network)
.venv/bin/python scripts/make-fixtures.py   # fixtures (pysam, pyBigWig, numpy in .venv)
```

Test tool shims for samtools/bgzip/tabix live in `test/tools/bin` (pysam-backed); `.venv/bin/{samtools,bgzip,tabix}` wrap them and `.vscode/settings.json` points `igv.tools.paths` at them.

## Conventions

- igv.js is never modified; work around quirks in our code and pin findings in `test/contract/`.
- The webview never sees absolute paths: files travel as `{__igvVscodeLocalPath}` markers on the host and `{__igvVscodeFile}` broker handles across to the webview.
- No stubs in shipped paths: unsupported things fail with a clear message and a `hint`.
- Keep `docs/settings.md` current with `npm run settings-doc` after changing settings/commands.
- Loci are 1-based, inclusive, with thousands separators (IGV display convention).

## Releasing

See `docs/RELEASING.md` (versioning, packaging, manual Marketplace upload, Open VSX, GitHub Release, secrets). Never publish without the maintainer's explicit go-ahead.

## Environment quirks (this machine)

`rm` and `cp` are aliased to interactive mode; use `rm -f` / `\cp -f`. zsh errors on unmatched globs.
