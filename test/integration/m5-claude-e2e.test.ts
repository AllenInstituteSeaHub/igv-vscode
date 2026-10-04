/**
 * Human-checkpoint-3 stand-in: run Claude Code non-interactively with the igv
 * MCP server pointed at this test instance and check that it opens the
 * fixture BAM, looks at a snapshot, and describes the planted SNP.
 * Gated: IGV_CLAUDE_E2E=1 and a `claude` binary (IGV_CLAUDE_BIN or on PATH).
 * Costs Claude usage, so it never runs in CI by default.
 */
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { IgvExtensionApi } from '../../src/extension';

const ROOT = resolve(__dirname, '../..');
const FIXTURES = join(ROOT, 'test/fixtures/generated');

suite('Claude Code drives IGV through MCP (IGV_CLAUDE_E2E=1)', function () {
  this.timeout(10 * 60_000);
  const bin = process.env.IGV_CLAUDE_BIN ?? 'claude';

  suiteSetup(function () {
    if (process.env.IGV_CLAUDE_E2E !== '1' || !existsSync(join(FIXTURES, 'large.bam'))) this.skip();
  });

  test('opens the BAM, snapshots, describes the SNP and explains an empty wide view', async () => {
    const ext = vscode.extensions.getExtension<IgvExtensionApi>('alleninstituteseahub.igv-vscode');
    const api = await ext!.activate();
    for (let i = 0; i < 50 && !api.agent.enabled; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(api.agent.enabled);
    for (const v of api.viewers.list()) api.viewers.resolve(v.id).dispose();

    const work = mkdtempSync(join(tmpdir(), 'igv-claude-'));
    const mcpConfig = join(work, 'mcp.json');
    writeFileSync(mcpConfig, JSON.stringify({
      mcpServers: { igv: { command: api.agent.launcherPaths!.posix, args: ['mcp'], env: { IGV_VSCODE_ENDPOINT: api.agent.endpoint, IGV_VSCODE_TOKEN: api.agent.token } } },
    }));
    const tools = ['igv_open', 'igv_goto', 'igv_add_tracks', 'igv_remove_tracks', 'igv_state', 'igv_list_viewers', 'igv_snapshot', 'igv_save_session', 'igv_load_session', 'igv_close', 'igv_list_genomes'].map((t) => `mcp__igv__${t}`);
    const prompt = [
      `Use the igv MCP tools (you are in a VS Code workspace with the IGV Viewer extension; the igv skill in .claude/skills/igv describes them).`,
      `1. Open ${join(FIXTURES, 'large.bam')} on the genome ${join(FIXTURES, 'ref.fa')} at chrS:999,950-1,000,050, take a snapshot, look at it, and describe what you see at position chrS:1,000,000 (reference base, alternate base, approximate allele fraction).`,
      `2. Then navigate to chrS:1-200,000, check the viewer state, and explain in one sentence why the alignment track shows nothing.`,
      `3. Then try to add the file ${join(FIXTURES, 'does-not-exist.bam')} and report the error you got, verbatim.`,
      `Finally close the viewers you opened. Answer with three short numbered paragraphs.`,
    ].join('\n');

    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
      execFile(
        bin,
        ['-p', prompt, '--output-format', 'json', '--mcp-config', mcpConfig, '--strict-mcp-config', '--allowedTools', tools.join(','), '--max-turns', '30'],
        { cwd: ROOT, env: { ...process.env, IGV_VSCODE_ENDPOINT: undefined, IGV_VSCODE_TOKEN: undefined }, maxBuffer: 64 * 1024 * 1024, timeout: 9 * 60_000 },
        (err, stdout, stderr) => resolveRun({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });
    console.error('[claude stderr]', result.stderr.slice(0, 2000));
    assert.equal(result.code, 0, `claude exited ${result.code}: ${result.stderr.slice(0, 500)}`);
    const parsed = JSON.parse(result.stdout) as { result: string; num_turns?: number; total_cost_usd?: number };
    const answer = parsed.result;
    console.error(`[claude answer] (${parsed.num_turns} turns, $${parsed.total_cost_usd?.toFixed(3)})\n${answer}`);
    writeFileSync(join(FIXTURES, 'CLAUDE_E2E.md'), `# Claude Code end-to-end (${new Date().toISOString()})\n\nTurns: ${parsed.num_turns}, cost: $${parsed.total_cost_usd?.toFixed(3)}\n\n${answer}\n`);

    assert.match(answer, /1,?000,?000/, 'mentions the SNP position');
    assert.match(answer, /\bC\b/, 'names the alternate base C');
    assert.match(answer, /\bA\b|reference/i, 'names the reference base A');
    assert.match(answer, /(50|half|heterozyg|0\.5|~5\d ?%|4\d ?%|5\d ?%)/i, 'gives an allele fraction near one half');
    assert.match(answer, /visibility window|zoom|outsideVisibilityWindow|too wide|wider/i, 'explains the empty wide view');
    assert.match(answer, /not found|FILE_NOT_FOUND|does-not-exist/i, 'reports the missing-file error');
    assert.equal(api.viewers.list().length, 0, 'Claude closed its viewers');
  });
});
