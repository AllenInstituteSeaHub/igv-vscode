#!/usr/bin/env node
/**
 * code-server end-to-end harness for igv-vscode (spec §11.2 "code-server e2e",
 * §12 M4 acceptance).
 *
 * For each (code-server version, transport mode) it:
 *   1. assembles a Docker build context (VSIX + fixtures), builds the image from
 *      ./Dockerfile with --build-arg CODE_SERVER_VERSION, and starts a container
 *      with TRANSPORT_MODE=<mode> on a random free host port;
 *   2. waits for http://127.0.0.1:<port>/healthz, opens the workbench in headless
 *      Chromium (Playwright), activates the extension through the command
 *      palette ("IGV: Show Output") and opens a new integrated terminal;
 *   3. types CLI commands into that terminal (the only place the extension's
 *      PATH injection applies), each redirecting its output to files under
 *      /home/coder/project/out/, and polls those files with `docker exec`
 *      instead of scraping xterm's DOM;
 *   4. asserts on the JSON / SVG / PNG results with node:assert, copies
 *      everything to test/e2e-code-server/out/<version>-<mode>/, and removes the
 *      container (unless --keep).
 *
 * Only Node built-ins plus Playwright (already a devDependency) are used.
 */
/* global console, process, fetch, AbortSignal */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CONTEXT_DIR = path.join(HERE, '.context');
const OUT_ROOT = path.join(HERE, 'out');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'generated');
const FIXTURE_FILES = ['ref.fa', 'ref.fa.fai', 'small.bam', 'small.bam.bai', 'genes.bed'];

/** codercom/code-server tags. Keep in sync with the matrix in .github/workflows/ci.yml. */
export const DEFAULT_RECENT_VERSION = '4.140.0';
export const DEFAULT_OLD_VERSION = '4.102.0';
const MODES = ['shim', 'webviewUri'];

const CONTAINER_WORKSPACE = '/home/coder/project';
const CONTAINER_OUT = `${CONTAINER_WORKSPACE}/out`;
const CONTAINER_PORT = 8080;

const T = {
  healthz: 120_000,
  workbench: 90_000,
  activation: 60_000,
  terminal: 30_000,
  typing: 12_000,
  cliQuick: 45_000,
  cliOpen: 120_000, // igv loads the FASTA, the BAM and the BED on first open
  cliSnapshot: 90_000,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `igv-vscode code-server e2e harness

Usage: node test/e2e-code-server/run.mjs [options]

Options
  --version X        code-server version (codercom/code-server:X). Repeatable or
                     comma-separated. Default: ${DEFAULT_RECENT_VERSION}
  --mode M           shim | webviewUri. Repeatable or comma-separated. Default: shim
  --all              both versions (${DEFAULT_RECENT_VERSION}, ${DEFAULT_OLD_VERSION}) x both modes
  --keep             keep the container(s) running afterwards for debugging
  --headed           run Chromium with a visible window
  --no-build         reuse an existing image igv-vscode-e2e:<version>
  --help, -h         this help

Prerequisites
  docker on PATH, a packaged VSIX in the repo root (npm run package), the
  fixtures in test/fixtures/generated (python scripts/make-fixtures.py --skip-large)
  and Playwright's Chromium (npx playwright install --with-deps chromium).

Outputs land in test/e2e-code-server/out/<version>-<mode>/ (CLI JSON, the
snapshots, code-server logs, a workbench screenshot). Exit code 0 when every
run passed, 1 when any run failed, 2 on a setup problem.
`;

function parseArgs(argv) {
  const opts = { versions: [], modes: [], all: false, keep: false, headed: false, build: true, help: false };
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--headed') opts.headed = true;
    else if (a === '--no-build') opts.build = false;
    else if (a === '--version') opts.versions.push(...list(next()));
    else if (a.startsWith('--version=')) opts.versions.push(...list(a.slice('--version='.length)));
    else if (a === '--mode') opts.modes.push(...list(next()));
    else if (a.startsWith('--mode=')) opts.modes.push(...list(a.slice('--mode='.length)));
    else throw new Error(`unknown option "${a}"`);
  }
  if (opts.all) {
    if (opts.versions.length === 0) opts.versions = [DEFAULT_RECENT_VERSION, DEFAULT_OLD_VERSION];
    if (opts.modes.length === 0) opts.modes = [...MODES];
  }
  if (opts.versions.length === 0) opts.versions = [DEFAULT_RECENT_VERSION];
  if (opts.modes.length === 0) opts.modes = ['shim'];
  for (const m of opts.modes) if (!MODES.includes(m)) throw new Error(`--mode must be one of ${MODES.join(', ')}, got "${m}"`);
  return opts;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (...args) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...args);

class SetupError extends Error {}

/** Run a command to completion; returns { status, stdout, stderr }. Never throws on non-zero exit. */
function run(cmd, args, { input, maxBuffer = 64 * 1024 * 1024, encoding = 'utf8' } = {}) {
  const r = spawnSync(cmd, args, { input, maxBuffer, encoding });
  if (r.error) return { status: -1, stdout: '', stderr: String(r.error.message), error: r.error };
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runOrThrow(cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status}): ${String(r.stderr).trim() || String(r.stdout).trim()}`);
  return r;
}

/** Run with inherited stdio (for docker build progress). Resolves with the exit code. */
function runInherit(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(desc, fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${desc}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
    }
    await sleep(intervalMs);
  }
}

function safeName(s) {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

function checkDocker() {
  const r = run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (r.status !== 0) {
    throw new SetupError(`docker is not available (${(r.stderr || r.stdout).trim() || 'not on PATH'}). This harness needs a Docker daemon; CI runs it on ubuntu-latest.`);
  }
  log(`docker server ${r.stdout.trim()}`);
}

function findVsix() {
  const candidates = fs
    .readdirSync(REPO_ROOT)
    .filter((f) => /^igv-vscode-.*\.vsix$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(REPO_ROOT, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    throw new SetupError(`No igv-vscode-*.vsix found in ${REPO_ROOT}. Run "npm run package" first.`);
  }
  if (candidates.length > 1) log(`several VSIX files found, using the newest: ${candidates[0].f}`);
  return path.join(REPO_ROOT, candidates[0].f);
}

/**
 * Build context layout (see Dockerfile):
 *   .context/igv-vscode.vsix
 *   .context/entrypoint.sh
 *   .context/data/{ref.fa,ref.fa.fai,small.bam,small.bam.bai,genes.bed}
 */
function prepareContext() {
  const vsix = findVsix();
  const missing = FIXTURE_FILES.filter((f) => !fs.existsSync(path.join(FIXTURES_DIR, f)));
  if (missing.length) {
    throw new SetupError(
      `Missing fixtures in ${FIXTURES_DIR}: ${missing.join(', ')}. Generate them with "python scripts/make-fixtures.py --skip-large" (see test/fixtures/README.md).`,
    );
  }
  fs.rmSync(CONTEXT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(CONTEXT_DIR, 'data'), { recursive: true });
  fs.copyFileSync(vsix, path.join(CONTEXT_DIR, 'igv-vscode.vsix'));
  fs.copyFileSync(path.join(HERE, 'entrypoint.sh'), path.join(CONTEXT_DIR, 'entrypoint.sh'));
  fs.chmodSync(path.join(CONTEXT_DIR, 'entrypoint.sh'), 0o755);
  for (const f of FIXTURE_FILES) fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(CONTEXT_DIR, 'data', f));
  log(`build context ready at ${path.relative(REPO_ROOT, CONTEXT_DIR)} (${path.basename(vsix)}, ${FIXTURE_FILES.length} fixtures)`);
  return { vsix };
}

const imageTag = (version) => `igv-vscode-e2e:${version}`;

async function buildImage(version) {
  const tag = imageTag(version);
  log(`docker build ${tag} (codercom/code-server:${version}) ...`);
  const code = await runInherit('docker', [
    'build',
    '--build-arg',
    `CODE_SERVER_VERSION=${version}`,
    '-t',
    tag,
    '-f',
    path.join(HERE, 'Dockerfile'),
    CONTEXT_DIR,
  ]);
  if (code !== 0) throw new SetupError(`docker build for code-server ${version} failed with exit code ${code}`);
  return tag;
}

class Container {
  constructor(name) {
    this.name = name;
  }

  static start({ image, name, port, mode }) {
    const r = runOrThrow('docker', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:${CONTAINER_PORT}`, '-e', `TRANSPORT_MODE=${mode}`, image]);
    const c = new Container(name);
    c.id = r.stdout.trim();
    return c;
  }

  exec(args, opts) {
    return run('docker', ['exec', this.name, ...args], opts);
  }

  sh(script, opts) {
    return this.exec(['sh', '-c', script], opts);
  }

  /** Contents of a file inside the container, or undefined when it does not exist yet. */
  readFile(file) {
    const r = this.sh(`test -f '${file}' && cat '${file}'`);
    return r.status === 0 ? r.stdout : undefined;
  }

  waitForFile(file, timeoutMs, desc = file) {
    return waitFor(desc, () => this.readFile(file), timeoutMs);
  }

  logs() {
    return run('docker', ['logs', this.name]);
  }

  copyOut(containerPath, hostDir) {
    return run('docker', ['cp', `${this.name}:${containerPath}`, hostDir]);
  }

  remove() {
    return run('docker', ['rm', '-f', this.name]);
  }
}

async function waitForHealthz(port) {
  const url = `http://127.0.0.1:${port}/healthz`;
  log(`waiting for ${url}`);
  await waitFor(`${url}`, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    return res?.ok === true;
  }, T.healthz, 1000);
}

// ---------------------------------------------------------------------------
// Browser driving
// ---------------------------------------------------------------------------

async function loadPlaywright() {
  try {
    return await import('@playwright/test');
  } catch {
    try {
      return await import('playwright');
    } catch (err) {
      throw new SetupError(`Playwright is not installed (${err.message}). Run "npm ci" and "npx playwright install --with-deps chromium".`);
    }
  }
}

/**
 * Run a command through the command palette (F1). Rows are matched by their
 * label text and the matching row is clicked, which is more robust than
 * trusting the first fuzzy-match row.
 */
async function paletteCommand(page, label) {
  await page.keyboard.press('Escape');
  const input = page.locator('.quick-input-widget input').first();
  await page.keyboard.press('F1');
  try {
    await input.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    await page.keyboard.press('Control+Shift+KeyP');
    await input.waitFor({ state: 'visible', timeout: 10_000 });
  }
  // F1 opens the palette in command mode (">" already typed); make sure of it.
  if (!((await input.inputValue().catch(() => '')) ?? '').startsWith('>')) await page.keyboard.type('>');
  await page.keyboard.type(label, { delay: 10 });
  const rows = page.locator('.quick-input-widget .quick-input-list .monaco-list-row', { hasText: label });
  await rows.first().waitFor({ state: 'visible', timeout: 10_000 });
  const n = await rows.count();
  let target = rows.first();
  for (let i = 0; i < n; i++) {
    const text = ((await rows.nth(i).locator('.label-name').first().textContent({ timeout: 2_000 }).catch(() => '')) ?? '').trim();
    if (text === label) {
      target = rows.nth(i);
      break;
    }
  }
  await target.click();
  await page.locator('.quick-input-widget').first().waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
}

async function openTerminal(page) {
  const xterm = page.locator('.terminal-wrapper .xterm, .integrated-terminal .xterm');
  try {
    await paletteCommand(page, 'Terminal: Create New Terminal');
    await xterm.last().waitFor({ state: 'visible', timeout: T.terminal });
  } catch (err) {
    log(`palette route to the terminal failed (${err.message}); trying Ctrl+\``);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Backquote');
    await xterm.last().waitFor({ state: 'visible', timeout: T.terminal });
  }
  await sleep(1500); // let the shell print its prompt
}

async function focusTerminal(page) {
  const textarea = page.locator('.terminal-wrapper textarea.xterm-helper-textarea, textarea.xterm-helper-textarea').last();
  if (await textarea.count()) {
    await textarea.focus().catch(() => undefined);
  }
  const screen = page.locator('.terminal-wrapper .xterm-screen, .xterm-screen').last();
  await screen.click({ position: { x: 20, y: 20 } }).catch(() => undefined);
}

/** Type one shell line into the focused integrated terminal and press Enter. */
async function typeLine(page, line) {
  await focusTerminal(page);
  await page.keyboard.type(line, { delay: 3 });
  await page.keyboard.press('Enter');
}

// ---------------------------------------------------------------------------
// One run = one (version, mode)
// ---------------------------------------------------------------------------

async function runOne({ version, mode, image, keep, headed, pw }) {
  const label = `${version}/${mode}`;
  const outDir = path.join(OUT_ROOT, `${safeName(version)}-${mode}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const notes = [];
  const result = { version, mode, ok: false, ms: 0, detail: '', outDir };

  const port = await freePort();
  const name = safeName(`igv-e2e-${version}-${mode}-${process.pid}-${Date.now().toString(36)}`);
  log(`[${label}] starting ${image} as ${name} on 127.0.0.1:${port}`);
  const container = Container.start({ image, name, port, mode });

  let browser;
  let page;
  const browserLog = [];
  try {
    await waitForHealthz(port);

    browser = await pw.chromium.launch({ headless: !headed });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    page.on('console', (m) => browserLog.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => browserLog.push(`[pageerror] ${e.message}`));

    const url = `http://127.0.0.1:${port}/?folder=${encodeURIComponent(CONTAINER_WORKSPACE)}`;
    log(`[${label}] opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('.monaco-workbench').first().waitFor({ state: 'visible', timeout: T.workbench });
    await page.locator('.statusbar, .part.statusbar').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
    await sleep(4000); // extension host startup

    // Activate the extension (activation events: a contributed command). Activation
    // writes the launcher to globalStorage/<ext>/bin and prepends it to the PATH of
    // terminals created afterwards, then starts the control server and writes the
    // instance registry.
    log(`[${label}] activating the extension via "IGV: Show Output"`);
    await paletteCommand(page, 'IGV: Show Output');
    const launcherPath = await waitFor(
      'the CLI launcher in globalStorage/*/bin/igv-vscode',
      () => {
        const r = container.sh('ls /home/coder/.local/share/code-server/User/globalStorage/*/bin/igv-vscode 2>/dev/null | head -n1');
        return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
      },
      T.activation,
    );
    notes.push(`launcher ${launcherPath}`);
    await waitFor(
      'the instance registry (~/.igv-vscode/instances/*.json)',
      () => {
        const r = container.sh('ls /home/coder/.igv-vscode/instances/*.json 2>/dev/null | head -n1');
        return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
      },
      T.activation,
    );
    const launcherText = container.readFile(launcherPath) ?? '';
    fs.writeFileSync(path.join(outDir, 'launcher.sh'), launcherText);
    const execPath = /exec '([^']+)'/.exec(launcherText)?.[1];
    if (execPath) notes.push(`runtime ${execPath}`);

    // Integrated terminal, created after activation so it inherits the PATH prepend.
    log(`[${label}] opening an integrated terminal`);
    await openTerminal(page);

    // Prove the typing channel works before relying on it: retry a marker command.
    let typed = false;
    for (let attempt = 1; attempt <= 4 && !typed; attempt++) {
      await typeLine(page, `cd ${CONTAINER_WORKSPACE} && echo READY-${attempt} > ${CONTAINER_OUT}/ready.txt`);
      typed = Boolean(await container.waitForFile(`${CONTAINER_OUT}/ready.txt`, T.typing).catch(() => undefined));
      if (!typed) log(`[${label}] terminal did not echo back (attempt ${attempt}); refocusing`);
    }
    assert.ok(typed, 'could not type into the integrated terminal (no ready.txt after 4 attempts)');

    /** Type `cmd` redirecting stdout/stderr/exit code to out/<tag>.{json,err,exit}; wait for the exit file. */
    const cli = async (tag, cmd, timeoutMs) => {
      const line = `${cmd} > ${CONTAINER_OUT}/${tag}.json 2> ${CONTAINER_OUT}/${tag}.err; echo $? > ${CONTAINER_OUT}/${tag}.exit`;
      log(`[${label}] $ ${cmd}`);
      await typeLine(page, line);
      const exit = Number((await container.waitForFile(`${CONTAINER_OUT}/${tag}.exit`, timeoutMs, `${tag}.exit (${cmd})`)).trim());
      const stdout = container.readFile(`${CONTAINER_OUT}/${tag}.json`) ?? '';
      const stderr = container.readFile(`${CONTAINER_OUT}/${tag}.err`) ?? '';
      return { exit, stdout, stderr };
    };
    const cliJson = async (tag, cmd, timeoutMs) => {
      const r = await cli(tag, cmd, timeoutMs);
      assert.equal(r.exit, 0, `${cmd} exited ${r.exit}: ${r.stderr.trim() || r.stdout.trim()}`);
      try {
        return JSON.parse(r.stdout);
      } catch (err) {
        throw new Error(`${cmd} did not print JSON (${err.message}): ${r.stdout.slice(0, 300)}`, { cause: err });
      }
    };

    // 0. No system node on PATH (M4 acceptance), checked from the integrated terminal
    //    and from a login shell started by docker exec.
    await typeLine(page, `command -v node > ${CONTAINER_OUT}/node.txt 2>&1 || echo NO-NODE > ${CONTAINER_OUT}/node.txt`);
    const nodeTxt = (await container.waitForFile(`${CONTAINER_OUT}/node.txt`, T.typing)).trim();
    assert.equal(nodeTxt, 'NO-NODE', `a system node is on the terminal PATH: ${nodeTxt}`);
    const loginNode = container.exec(['bash', '-lc', 'command -v node']);
    assert.notEqual(loginNode.status, 0, `a system node is on the login-shell PATH: ${loginNode.stdout.trim()}`);

    // 1. ping
    const ping = await cliJson('ping', 'igv-vscode ping --json', T.cliQuick);
    assert.equal(ping.host, 'code-server', `ping.host should be "code-server", got ${JSON.stringify(ping.host)}`);
    assert.ok(typeof ping.vscodeVersion === 'string' && ping.vscodeVersion.length > 0, 'ping.vscodeVersion missing');
    assert.ok(Array.isArray(ping.workspaceFolders) && ping.workspaceFolders.includes(CONTAINER_WORKSPACE), `ping.workspaceFolders should contain ${CONTAINER_WORKSPACE}: ${JSON.stringify(ping.workspaceFolders)}`);
    notes.push(`VS Code ${ping.vscodeVersion}`, `igv.js ${ping.igvVersion}`, `endpoint via ${ping.source}`);

    // 2. open two tracks at a locus on chrT (small.bam has 2,000 reads there, genes.bed 10 features)
    const open = await cliJson('open', 'igv-vscode open --locus chrT:1,001-3,000 data/small.bam data/genes.bed --json', T.cliOpen);
    assert.equal(open.tracks?.length, 2, `open should report 2 tracks, got ${JSON.stringify(open.tracks?.map((t) => t.name))}`);
    for (const t of open.tracks) assert.equal(t.error, null, `track ${t.name} has an error: ${t.error}`);
    const names = open.tracks.map((t) => t.name).sort();
    assert.deepEqual(names, ['genes', 'small'], `unexpected track names ${JSON.stringify(names)}`);
    if (!open.settled) notes.push('open: rendering had not settled before the timeout');
    if (open.warnings?.length) notes.push(`open warnings: ${open.warnings.join(' | ')}`);

    // 3. SVG snapshot: alignments draw as <rect>s
    const snapSvg = await cliJson('snapshot-svg', `igv-vscode snapshot --out ${CONTAINER_OUT}/view.svg --json`, T.cliSnapshot);
    assert.equal(snapSvg.format, 'svg');
    const svg = container.readFile(`${CONTAINER_OUT}/view.svg`);
    assert.ok(svg, 'view.svg was not written');
    assert.ok(svg.includes('<svg'), 'view.svg does not contain <svg');
    const rects = (svg.match(/<rect\b/g) ?? []).length;
    assert.ok(rects > 50, `view.svg has only ${rects} <rect> elements (expected > 50: alignments should be drawn)`);
    notes.push(`svg rects ${rects}`);

    // 4. PNG snapshot
    const snapPng = await cliJson('snapshot-png', `igv-vscode snapshot --format png --out ${CONTAINER_OUT}/view.png --json`, T.cliSnapshot);
    assert.equal(snapPng.format, 'png');
    const pngSize = Number(container.sh(`stat -c %s ${CONTAINER_OUT}/view.png`).stdout.trim());
    assert.ok(pngSize > 10 * 1024, `view.png is ${pngSize} bytes (expected > 10 KB)`);
    const pngHead = container.sh(`head -c 8 ${CONTAINER_OUT}/view.png | od -An -tx1 | tr -d ' \\n'`).stdout.trim();
    assert.equal(pngHead, '89504e470d0a1a0a', `view.png does not start with the PNG signature (got ${pngHead})`);
    notes.push(`png ${snapPng.width}x${snapPng.height}, ${pngSize} B`);

    // 5. state: every track in view
    const state = await cliJson('state', 'igv-vscode state --json', T.cliQuick);
    assert.equal(state.tracks?.length, 2, `state should list 2 tracks, got ${state.tracks?.length}`);
    for (const t of state.tracks) assert.equal(t.inView, true, `track ${t.name} is not in view (${t.inViewReason ?? 'no reason'})`);
    assert.ok(Array.isArray(state.loci) && state.loci.some((l) => /^chrT:/.test(l)), `state.loci should be on chrT: ${JSON.stringify(state.loci)}`);

    // 6. close everything
    const close = await cliJson('close', 'igv-vscode close --all --json', T.cliQuick);
    assert.equal(close.closed?.length, 1, `close --all should close exactly 1 viewer, got ${JSON.stringify(close.closed)}`);

    result.ok = true;
    result.detail = notes.join('; ');
    log(`[${label}] PASS`);
  } catch (err) {
    result.detail = `${err.message}${notes.length ? ` [${notes.join('; ')}]` : ''}`;
    log(`[${label}] FAIL: ${err.message}`);
  } finally {
    result.ms = Date.now() - started;
    try {
      if (page) await page.screenshot({ path: path.join(outDir, 'workbench.png') }).catch(() => undefined);
      fs.writeFileSync(path.join(outDir, 'browser-console.log'), browserLog.join('\n'));
      if (browser) await browser.close().catch(() => undefined);
    } catch {
      // best effort
    }
    const logs = container.logs();
    fs.writeFileSync(path.join(outDir, 'code-server.log'), `${logs.stdout}\n${logs.stderr}`);
    const cp = container.copyOut(`${CONTAINER_OUT}/.`, outDir);
    if (cp.status !== 0) log(`[${label}] docker cp failed: ${cp.stderr.trim()}`);
    const ext = container.sh('ls -R /home/coder/.local/share/code-server/User/globalStorage 2>/dev/null; echo; cat /home/coder/.local/share/code-server/User/settings.json 2>/dev/null; echo; ls -la /home/coder/.igv-vscode/instances 2>/dev/null');
    fs.writeFileSync(path.join(outDir, 'container-state.txt'), ext.stdout);
    if (keep) {
      log(`[${label}] container ${name} kept (code-server at http://127.0.0.1:${port}/). Remove with: docker rm -f ${name}`);
    } else {
      container.remove();
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printSummary(results) {
  const rows = results.map((r) => [r.version, r.mode, r.ok ? 'PASS' : 'FAIL', `${(r.ms / 1000).toFixed(0)} s`, r.detail]);
  const head = ['code-server', 'mode', 'result', 'time', 'detail'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log('');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log('');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`run.mjs: ${err.message}\n`);
    console.error(HELP);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  checkDocker();
  const pw = await loadPlaywright();
  if (opts.build) prepareContext();
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const results = [];
  for (const version of opts.versions) {
    let image;
    if (opts.build) {
      image = await buildImage(version);
    } else {
      image = imageTag(version);
      if (run('docker', ['image', 'inspect', image]).status !== 0) throw new SetupError(`--no-build given but image ${image} does not exist`);
    }
    for (const mode of opts.modes) {
      results.push(await runOne({ version, mode, image, keep: opts.keep, headed: opts.headed, pw }));
    }
  }
  printSummary(results);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`${failed.length} of ${results.length} run(s) failed. Outputs: ${path.relative(REPO_ROOT, OUT_ROOT)}/`);
    return 1;
  }
  console.log(`All ${results.length} run(s) passed. Outputs: ${path.relative(REPO_ROOT, OUT_ROOT)}/`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof SetupError ? `run.mjs: ${err.message}` : err);
    process.exitCode = err instanceof SetupError ? 2 : 1;
  },
);
