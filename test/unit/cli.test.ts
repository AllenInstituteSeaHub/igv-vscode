import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_NO_INSTANCE, EXIT_OK, EXIT_USAGE, HELP, buildTrackSpecs, main, parsePairs } from '../../src/agent/cli';
import { ControlServer, defaultEndpoint } from '../../src/agent/ControlServer';
import { writeInstance } from '../../src/agent/registry';

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'igv-cli-'));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

function run(argv: string[], env: NodeJS.ProcessEnv = { IGV_VSCODE_HOME: home }, isTTY = false) {
  const out: string[] = [];
  const err: string[] = [];
  return main(argv, { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY, cwd: home, env }).then((code) => ({ code, out: out.join(''), err: err.join('') }));
}

describe('cli argument handling', () => {
  it('prints help and version', async () => {
    expect((await run(['--help'])).code).toBe(EXIT_OK);
    expect((await run(['--help'])).out).toBe(HELP);
    expect(HELP).toContain('1-based, inclusive');
    expect((await run([])).code).toBe(EXIT_USAGE);
    expect((await run(['--version'])).out).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('rejects unknown options and commands with exit 1', async () => {
    const r = await run(['open', '--bogus']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.err).toMatch(/bogus/);
  });
  it('exits 3 with a JSON error when no instance is running', async () => {
    const r = await run(['state', '--json']);
    expect(r.code).toBe(EXIT_NO_INSTANCE);
    const parsed = JSON.parse(r.err);
    expect(parsed.error.code).toBe('AGENT_DISABLED');
    expect(parsed.error.message).toMatch(/No running VS Code/);
  });
  it('builds track specs from positionals, --index and --track-opt', () => {
    const specs = buildTrackSpecs(['data/tumor.bam', 'https://h/cov.bw', 'genes.bed.gz'], ['tumor.color=#cc0000', 'tumor.height=300', 'genes.displayMode=SQUISHED'], ['data/tumor.bam=idx/t.bai'], true);
    expect(specs).toEqual([
      { path: 'data/tumor.bam', index: 'idx/t.bai', options: { color: '#cc0000', height: 300 }, autoIndex: true },
      { url: 'https://h/cov.bw', autoIndex: true },
      { path: 'genes.bed.gz', options: { displayMode: 'SQUISHED' }, autoIndex: true },
    ]);
    expect(() => buildTrackSpecs(['a.bam'], ['bad'], [], false)).toThrow(/NAME.key=value/);
    expect(() => buildTrackSpecs(['a.bam'], [], ['noequals'], false)).toThrow(/FILE=INDEX/);
    expect(parsePairs(['color=red', 'height=100', 'autoscale=true'])).toEqual({ color: 'red', height: 100, autoscale: true });
    expect(() => parsePairs(['x'])).toThrow(/key=value/);
  });
});

describe('cli against a fake instance', () => {
  it('runs commands end to end over the socket, human and JSON output', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const server = new ControlServer(
      {
        log: () => undefined,
        endpoint: defaultEndpoint('fake', { XDG_RUNTIME_DIR: home }),
        handler: async (method, params) => {
          calls.push({ method, params });
          switch (method) {
            case 'ping':
              return { version: '9.9.9', igvVersion: '3.8.9', vscodeVersion: '1.140.0', host: 'desktop', workspaceFolders: [home], protocolVersion: 1 };
            case 'viewer.open':
              return { id: 'v1', name: 'v1', genome: { id: 'hg38', name: 'Human', source: 'bundled-list' }, loci: ['chr1:1-100'], tracks: [], settled: true, warnings: ['w1'] };
            case 'viewer.list':
              return [{ id: 'v1', name: 'v1', genome: { id: 'hg38', name: 'Human', source: 'bundled-list' }, loci: ['chr1:1-100'], trackCount: 0, visible: true, active: true }];
            case 'viewer.snapshot':
              return { path: '/tmp/x.png', format: 'png', width: 10, height: 10, locus: ['chr1:1-100'] };
            case 'genomes.list':
              return { genomes: [{ id: 'hg38', name: 'Human', source: 'bundled-list' }] };
            default:
              throw new Error(`unexpected ${method}`);
          }
        },
      },
      'fake',
    );
    await server.start();
    await writeInstance({ id: 'fake', endpoint: server.endpoint, token: server.token, pid: process.pid, workspaceFolders: [home], startedAt: 'x', lastActiveAt: 'x', version: '9.9.9', host: 'desktop' }, { IGV_VSCODE_HOME: home });
    try {
      const ping = await run(['ping'], { IGV_VSCODE_HOME: home }, true);
      expect(ping.code).toBe(EXIT_OK);
      expect(ping.out).toMatch(/igv-vscode 9\.9\.9 · igv\.js 3\.8\.9/);
      const pingJson = await run(['ping', '--json']);
      expect(JSON.parse(pingJson.out)).toMatchObject({ version: '9.9.9', instance: 'fake', source: 'registry' });

      const open = await run(['open', '--genome', 'hg38', '--locus', 'chr1:1-100', '--locus', 'chr2:1-100', '--name', 'n', '--track-opt', 'a.color=red', 'a.bam', '--json']);
      expect(open.code).toBe(EXIT_OK);
      const call = calls.find((c) => c.method === 'viewer.open')!;
      expect(call.params).toMatchObject({ genome: 'hg38', locus: ['chr1:1-100', 'chr2:1-100'], name: 'n', reuse: 'new', waitForRender: true, cwd: home, tracks: [{ path: 'a.bam', options: { color: 'red' } }] });
      expect(JSON.parse(open.out).warnings).toEqual(['w1']);

      const list = await run(['list'], { IGV_VSCODE_HOME: home }, true);
      expect(list.out).toMatch(/^\* v1 {2}v1 {2}hg38/);
      const snap = await run(['snapshot', '--out', 'x.svg', '--json']);
      expect(calls.find((c) => c.method === 'viewer.snapshot')!.params).toMatchObject({ format: 'svg', out: 'x.svg' });
      expect(JSON.parse(snap.out).path).toBe('/tmp/x.png');
      const genomes = await run(['genomes', 'hg'], { IGV_VSCODE_HOME: home }, true);
      expect(genomes.out).toMatch(/hg38 +Human/);
      // env discovery beats the registry
      const viaEnv = await run(['ping', '--json'], { IGV_VSCODE_HOME: join(home, 'empty'), IGV_VSCODE_ENDPOINT: server.endpoint, IGV_VSCODE_TOKEN: server.token });
      expect(JSON.parse(viaEnv.out).source).toBe('env');
      // usage errors never hit the server
      expect((await run(['goto'])).code).toBe(EXIT_USAGE);
      expect((await run(['session', 'nope'])).code).toBe(EXIT_USAGE);
    } finally {
      await server.stop();
    }
  });
});
