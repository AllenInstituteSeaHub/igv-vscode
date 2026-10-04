# code-server end-to-end test

Spec §11.2 ("code-server e2e") and the §12 M4 acceptance criterion: install the
VSIX into `codercom/code-server`, open a viewer, drive the `igv-vscode` CLI from
a terminal **inside the container without a system `node`**, and assert that the
snapshot shows alignments. Runs on two code-server versions (a recent 4.x and an
older 4.10x) and in both transport modes (`shim`, `webviewUri`).

This needs Docker, so it runs in CI (`code-server-e2e` job in
`.github/workflows/ci.yml`, GitHub Actions `ubuntu-latest`). It is not part of
`npm test`.

## Running locally

```sh
npm ci
npm run vendor
python scripts/make-fixtures.py --skip-large     # or .venv/bin/python, see test/fixtures/README.md
npm run package                                  # writes igv-vscode-<version>.vsix into the repo root
npx playwright install --with-deps chromium

node test/e2e-code-server/run.mjs --all          # 2 versions x 2 modes
# or
npm run test:e2e-code-server -- --version 4.140.0 --mode shim
```

| Flag | Meaning |
| --- | --- |
| `--version X` | code-server version (`codercom/code-server:X`). Repeatable / comma-separated. Default `4.140.0` |
| `--mode shim\|webviewUri` | `igv.transport.mode` baked into the user settings. Repeatable. Default `shim` |
| `--all` | `4.140.0` and `4.102.0` in both modes |
| `--keep` | leave the container running (prints the URL and the `docker rm -f` command) |
| `--headed` | visible Chromium instead of headless |
| `--no-build` | reuse an existing `igv-vscode-e2e:<version>` image |
| `--help` | usage; works without Docker |

Exit code: `0` all runs passed, `1` at least one run failed, `2` setup problem
(no Docker, no VSIX, missing fixtures, Playwright not installed). A summary
table is printed at the end:

```
code-server  mode        result  time   detail
-----------  ----------  ------  -----  ------------------------------------------------
4.140.0      shim        PASS    71 s   launcher /home/coder/.local/share/...; VS Code 1.104.0; ...
4.140.0      webviewUri  PASS    68 s   ...
```

Everything a run produced is in `test/e2e-code-server/out/<version>-<mode>/`:
the CLI's JSON (`ping.json`, `open.json`, `snapshot-svg.json`, `snapshot-png.json`,
`state.json`, `close.json`, plus `.err` and `.exit` files), `view.svg`,
`view.png`, `node.txt`, the generated launcher (`launcher.sh`), `code-server.log`
(`docker logs`), `browser-console.log`, `container-state.txt` (globalStorage
listing, settings.json, registry) and `workbench.png` (a screenshot taken at the
end, success or failure). CI uploads this directory as the
`code-server-e2e-<version>` artifact.

## What it does

For each (version, mode):

1. **Build context.** `run.mjs` assembles `test/e2e-code-server/.context/`
   (gitignored):

   ```
   .context/
     igv-vscode.vsix        newest igv-vscode-*.vsix from the repo root
     entrypoint.sh          copy of test/e2e-code-server/entrypoint.sh
     data/ref.fa            from test/fixtures/generated/
     data/ref.fa.fai
     data/small.bam
     data/small.bam.bai
     data/genes.bed
   ```

   and runs `docker build --build-arg CODE_SERVER_VERSION=<v> -t igv-vscode-e2e:<v>
   -f test/e2e-code-server/Dockerfile .context`. The image:
   - is `codercom/code-server:<v>`;
   - **removes every `node`/`nodejs` binary from PATH** (`/usr/bin`, `/usr/local/bin`,
     `/bin`) and fails the build if `command -v node` still succeeds. code-server's
     own runtime stays at `/usr/lib/code-server/lib/node`, off PATH; the extension's
     `CliInstaller` bakes that absolute `process.execPath` into the launcher script;
   - runs `code-server --install-extension /tmp/igv-vscode.vsix` as `coder`;
   - copies the fixtures to `/home/coder/project/data/` and creates
     `/home/coder/project/out/` for the test's output files;
   - uses `entrypoint.sh`, which writes
     `/home/coder/.local/share/code-server/User/settings.json` from the
     `TRANSPORT_MODE` env var (`igv.defaultGenome: /home/coder/project/data/ref.fa`,
     `igv.transport.mode`, workspace trust disabled, startup editor off, bash as the
     terminal profile, shell integration off) and then execs the image's own
     entrypoint with `--auth none --bind-addr 0.0.0.0:8080 --disable-telemetry
     --disable-update-check --disable-workspace-trust /home/coder/project`.
2. **Start.** `docker run -d -p 127.0.0.1:<free port>:8080 -e TRANSPORT_MODE=<mode>`,
   then poll `http://127.0.0.1:<port>/healthz` for up to 120 s.
3. **Workbench.** Headless Chromium (Playwright) opens
   `/?folder=/home/coder/project` and waits for `.monaco-workbench`.
4. **Activate the extension.** The extension activates on its contributed
   commands (and on an `igv.viewer` webview), not at startup, so the test runs
   **IGV: Show Output** through the command palette (F1, type the label, click
   the matching row). Activation writes the launcher to
   `~/.local/share/code-server/User/globalStorage/<publisher>.igv-vscode/bin/igv-vscode`,
   prepends that directory to the PATH of terminals created afterwards
   (`environmentVariableCollection`), starts the control server and writes
   `~/.igv-vscode/instances/<id>.json`. The test polls for the launcher and the
   registry file with `docker exec` (60 s).
5. **Terminal.** **Terminal: Create New Terminal** through the palette (fallback:
   Ctrl+`), wait for `.terminal-wrapper .xterm`, focus the xterm textarea.
6. **Typing and reading back.** PATH injection only applies to integrated
   terminals, so a `docker exec` login shell cannot run `igv-vscode`; and reading
   xterm's DOM is brittle. Instead each command is typed with
   `page.keyboard.type(...)` + Enter and redirects everything to files:

   ```
   <cmd> > out/<tag>.json 2> out/<tag>.err; echo $? > out/<tag>.exit
   ```

   The test polls `out/<tag>.exit` with `docker exec cat`, then reads the JSON.
   Before the real commands a marker (`echo READY-n > out/ready.txt`) proves the
   typing channel works (up to 4 attempts, refocusing each time).
7. **Commands and assertions** (`node:assert`), in order:

   | Command (typed in the integrated terminal) | Assertion |
   | --- | --- |
   | `command -v node ... \|\| echo NO-NODE > out/node.txt` | `node.txt` is `NO-NODE`; additionally `docker exec bash -lc 'command -v node'` fails |
   | `igv-vscode ping --json` | exit 0; `host === 'code-server'`; `workspaceFolders` contains `/home/coder/project` |
   | `igv-vscode open --locus chrT:1,001-3,000 data/small.bam data/genes.bed --json` | exit 0; 2 tracks named `small` and `genes`, every `error === null` (120 s budget: igv loads the FASTA, BAM and BED) |
   | `igv-vscode snapshot --out /home/coder/project/out/view.svg --json` | `view.svg` contains `<svg` and more than 50 `<rect` elements (reads are drawn) |
   | `igv-vscode snapshot --format png --out /home/coder/project/out/view.png --json` | PNG signature, more than 10 KB |
   | `igv-vscode state --json` | 2 tracks, all `inView: true`, locus on `chrT` |
   | `igv-vscode close --all --json` | `closed.length === 1` |

8. **Teardown.** Screenshot, `docker logs`, `docker cp` of `/home/coder/project/out/`
   into `out/<version>-<mode>/`, `docker rm -f` (skipped with `--keep`).

## CI

The `code-server-e2e` job runs a matrix over `4.140.0` and `4.102.0`. Each job:
checkout, Node 22, Python 3.12, `npm ci`, `npm run vendor`, fixtures
(`--skip-large`), `npm run package`, `npx playwright install --with-deps chromium`,
then

```
node test/e2e-code-server/run.mjs --version <v> --mode shim
node test/e2e-code-server/run.mjs --version <v> --mode webviewUri
```

and uploads `test/e2e-code-server/out/**`.

**`webviewUri` on the older code-server is `continue-on-error`.** That mode
serves local files to igv.js as webview-resource URLs with HTTP range requests
(spec §4.2), which older code-server builds may not support. The run still
executes and its artifacts (`open.json` track errors, `view.svg` rect count,
`code-server.log`) tell us whether the range support is there; a failure does
not fail the workflow. The `shim` runs and the recent version's `webviewUri` run
must pass.

The two versions are plain `codercom/code-server` tags (no distro suffix). To
move them, change the matrix in `ci.yml` and `DEFAULT_RECENT_VERSION` /
`DEFAULT_OLD_VERSION` in `run.mjs`.

## Troubleshooting

**`/healthz` never becomes ready.** Look at `out/<run>/code-server.log`
(`docker logs`). Typical causes: the image failed to start because
`TRANSPORT_MODE` was invalid (entrypoint exits 64), a port clash (the harness
picks a free port, but another process may grab it), or the Docker daemon is
slow to pull the base image (the pull happens during `docker build`, not here).
Run with `--keep`, then `docker logs <name>` and `curl http://127.0.0.1:<port>/healthz`.

**Activation times out ("waiting for the CLI launcher").** The extension did
not activate. Check `workbench.png` (a modal, e.g. workspace trust, may be
blocking the palette), `container-state.txt` (is the extension in
`globalStorage`? is `settings.json` what you expect?) and `code-server.log` for
extension host errors. Confirm the VSIX in the context is the one you built
(`npm run package` again), and that `code-server --install-extension` in the
build log said it was installed.

**"could not type into the integrated terminal".** The marker command never
produced `out/ready.txt`. Usually the terminal did not get focus or the shell
had not started. Look at `workbench.png`: is there a terminal panel with a
prompt? `terminal.integrated.defaultProfile.linux` is `bash`; if the base image
changed shells, adjust `entrypoint.sh`. Run `--headed --keep` to watch.

**`igv-vscode: command not found` in `ping.err`.** The terminal was created
before the PATH prepend applied, or `environmentVariableCollection` did not
reach the terminal. `launcher.sh` in the output dir shows the generated
launcher; `container-state.txt` lists the bin dir. With `--keep`, open a *new*
terminal in the kept code-server and run `echo $PATH`.

**`open` fails or the SVG has too few `<rect>`s.** In `shim` mode this is a
real regression; check `open.json` (`tracks[].error`), `open.err` and
`browser-console.log`. In `webviewUri` mode on an older code-server it most
likely means the server does not honour range requests for webview resources
(expected; see CI note above).

**Playwright: "Executable doesn't exist" / missing libraries.** Run
`npx playwright install --with-deps chromium` (the `--with-deps` installs the
system libraries on Ubuntu). The harness imports `@playwright/test` (a
devDependency) and falls back to `playwright`.

**Docker is not available locally.** Only `--help` works without a daemon. The
job is designed for CI; on macOS, Docker Desktop or Colima is enough to run it.
