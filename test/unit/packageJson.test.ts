import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

/** Turn a VS Code `resourceFilename =~ /re/flags` when-clause into a RegExp. */
function whenRegex(when: string): RegExp {
  const m = /^resourceFilename =~ \/(.*)\/([a-z]*)$/.exec(when);
  if (!m) throw new Error(`unexpected when clause: ${when}`);
  return new RegExp(m[1]!, m[2]);
}

describe('package.json contributions', () => {
  it('explorer context menu matches supported data files and nothing else', () => {
    const all = pkg.contributes.menus['explorer/context'] as { command: string; when: string }[];
    expect(all.map((i) => i.command)).toEqual(['igv.addToViewer', 'igv.openInNewViewer', 'igv.loadSession', 'igv.indexFile', 'igv.subsampleBam']);
    const sessionRe = whenRegex(all[2]!.when);
    const indexRe = whenRegex(all[3]!.when);
    expect(indexRe.test('x.bam')).toBe(true);
    expect(indexRe.test('x.vcf.gz')).toBe(true);
    expect(indexRe.test('x.bw')).toBe(false);
    expect(sessionRe.test('analysis.igv.json')).toBe(true);
    expect(sessionRe.test('package.json')).toBe(false);
    const items = all.slice(0, 2);
    for (const item of items) {
      const re = whenRegex(item.when);
      for (const good of ['small.bam', 'Sample.CRAM', 'cov.bw', 'cov.bigWig', 'x.bb', 'genes.bed', 'genes.bed.gz', 'g.gff3', 'g.gtf.gz', 'v.vcf', 'v.vcf.gz', 'c.bedgraph', 'ref.fa', 'ref.fasta.gz', 'hg38.2bit', 'p.narrowPeak']) {
        expect(re.test(good), `${good} should match`).toBe(true);
      }
      for (const bad of ['x.bai', 'x.vcf.gz.tbi', 'notes.md', 'bam', 'x.json', 'x.txt', 'a.bam.bak']) {
        expect(re.test(bad), `${bad} should not match`).toBe(false);
      }
    }
  });

  it('every contributed command has a title and the IGV category', () => {
    for (const c of pkg.contributes.commands as { command: string; title: string; category: string }[]) {
      expect(c.command).toMatch(/^igv\./);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.category).toBe('IGV');
    }
  });

  it('custom editors cover binary formats and sessions by default, text formats as an option', () => {
    const editors = pkg.contributes.customEditors as { viewType: string; priority: string; selector: { filenamePattern: string }[] }[];
    const byType = Object.fromEntries(editors.map((e) => [e.viewType, e]));
    expect(byType['igv.editor']!.priority).toBe('default');
    expect(byType['igv.editorOption']!.priority).toBe('option');
    const pats = (t: string) => byType[t]!.selector.map((s) => s.filenamePattern);
    expect(pats('igv.editor')).toEqual(expect.arrayContaining(['*.bam', '*.cram', '*.bw', '*.bb', '*.tdf', '*.2bit', '*.igv.json']));
    expect(pats('igv.editorOption')).toEqual(expect.arrayContaining(['*.vcf.gz', '*.bed', '*.gff3', '*.fa', '*.vcf']));
    expect(pkg.activationEvents).toContain('onWebviewPanel:igv.viewer');
  });

  it('menu and palette entries reference contributed commands', () => {
    const commands = new Set((pkg.contributes.commands as { command: string }[]).map((c) => c.command));
    for (const list of Object.values(pkg.contributes.menus as Record<string, { command: string }[]>)) {
      for (const item of list) expect(commands.has(item.command), item.command).toBe(true);
    }
  });
});
