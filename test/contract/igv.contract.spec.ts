/**
 * igv.js contract test (spec §11.2). Loads the exact `media/igv.min.js` we
 * ship into a bare page and drives it with File-like objects whose reads come
 * from an in-page fake broker backed by Node `fs` via Playwright. It pins the
 * behaviours the extension depends on. If an igv upgrade breaks the File-like
 * hook, this suite fails loudly.
 */
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import type * as FileLikeModule from '../../webview/FileLike';
import type { IgvBrowser, IgvTrack } from '../../webview/igv';

const ROOT = resolve(__dirname, '../..');
const FIXTURES = join(ROOT, 'test/fixtures/generated');
const IGV_JS = join(ROOT, 'media/igv.min.js');
const PINNED_IGV_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies.igv as string;

interface ReadCall {
  fileId: string;
  start: number;
  end: number;
}

declare global {
  interface Window {
    __calls: ReadCall[];
    __read(fileId: string, start: number, end: number): Promise<string>;
    __sizes: Record<string, number>;
    IgvFileLike: typeof FileLikeModule;
    __browser: IgvBrowser;
    __tracks: Record<string, IgvTrack>;
  }
}

let fileLikeBundle: string;

test.beforeAll(async () => {
  test.skip(!existsSync(join(FIXTURES, 'small.bam')), `fixtures missing: run .venv/bin/python scripts/make-fixtures.py (looked in ${FIXTURES})`);
  const r = await esbuild.build({
    entryPoints: [join(ROOT, 'webview/FileLike.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'IgvFileLike',
    platform: 'browser',
    target: 'es2022',
  });
  fileLikeBundle = r.outputFiles[0]!.text;
});

async function setupPage(page: Page, files: string[]): Promise<void> {
  const sizes: Record<string, number> = {};
  for (const f of files) sizes[f] = statSync(join(FIXTURES, f)).size;
  await page.exposeFunction('__read', (fileId: string, start: number, end: number) => {
    const fd = openSync(join(FIXTURES, fileId), 'r');
    try {
      const len = Math.max(0, end - start);
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, start);
      return buf.subarray(0, n).toString('base64');
    } finally {
      closeSync(fd);
    }
  });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text());
  });
  await page.setContent('<!doctype html><html><body><div id="root" style="width:1000px"></div></body></html>');
  await page.addScriptTag({ path: IGV_JS });
  await page.addScriptTag({ content: fileLikeBundle });
  await page.evaluate((sizes) => {
    window.__calls = [];
    window.__sizes = sizes;
    window.__tracks = {};
  }, sizes);
}

/** In-page: build a File-like for a fixture, recording every read. */
const makeFileLike = `(name) => {
  const handle = { fileId: name, name, size: window.__sizes[name], displayPath: name };
  const transport = { read: async (p) => { window.__calls.push({ fileId: p.fileId, start: p.start, end: p.end }); return window.__read(p.fileId, p.start, p.end); } };
  return window.IgvFileLike.fileLike(handle, transport, { maxChunkBytes: 8 * 1024 * 1024, encoding: 'base64' });
}`;

async function createBrowser(page: Page, locus: string): Promise<void> {
  await page.evaluate(
    async ({ makeFileLike, locus }) => {
      const mk = eval(makeFileLike) as (n: string) => unknown;
      const container = document.createElement('div');
      document.getElementById('root')!.appendChild(container);
      window.__browser = await igv.createBrowser(container, {
        reference: { id: 'ref', name: 'fixture ref', fastaURL: mk('ref.fa'), indexURL: mk('ref.fa.fai') },
        loadDefaultGenomes: false,
        genomeList: [],
        showSVGButton: false,
        locus,
        tracks: [],
      });
    },
    { makeFileLike, locus },
  );
}

async function loadTrack(page: Page, id: string, config: Record<string, unknown>, data: string, index?: string): Promise<{ type?: string; id?: string; name?: string }> {
  return page.evaluate(
    async ({ makeFileLike, id, config, data, index }) => {
      const mk = eval(makeFileLike) as (n: string) => unknown;
      const cfg: Record<string, unknown> = { ...config, id, url: mk(data) };
      if (index) cfg.indexURL = mk(index);
      const track = await window.__browser.loadTrack(cfg);
      window.__tracks[id] = track;
      return { type: track.type, id: track.id, name: track.name };
    },
    { makeFileLike, id, config, data, index },
  );
}

const calls = (page: Page) => page.evaluate(() => window.__calls);
const svg = (page: Page) => page.evaluate(() => window.__browser.toSVG());
const countRects = (s: string) => (s.match(/<rect\b/g) ?? []).length;

test.describe('igv.js contract', () => {
  test('ships the pinned version and exposes the API we use', async ({ page }) => {
    await setupPage(page, []);
    const info = await page.evaluate(() => ({
      version: typeof igv.version === 'function' ? igv.version() : igv.version,
      versionIsFunction: typeof igv.version === 'function',
      createBrowser: typeof igv.createBrowser,
      removeBrowser: typeof igv.removeBrowser,
    }));
    expect(info.version).toBe(PINNED_IGV_VERSION);
    expect(info.versionIsFunction).toBe(true); // BrowserAdapter.igvVersion() relies on this shape being handled
    expect(info.createBrowser).toBe('function');
    expect(info.removeBrowser).toBe('function');
  });

  test('accepts File-like objects for an indexed FASTA reference and calls slice with finite integers', async ({ page }) => {
    await setupPage(page, ['ref.fa', 'ref.fa.fai']);
    await createBrowser(page, 'chrT:1-2000');
    const frame = await page.evaluate(() => {
      const f = window.__browser.referenceFrameList[0]!;
      return { chr: f.chr, start: f.start, end: f.end, loci: window.__browser.currentLoci() };
    });
    expect(frame.chr).toBe('chrT');
    expect(frame.loci).toBe('chrT:1-2000');
    const c = await calls(page);
    expect(c.length).toBeGreaterThan(0);
    for (const r of c) {
      expect(Number.isInteger(r.start)).toBe(true);
      expect(Number.isInteger(r.end)).toBe(true);
      expect(r.end).toBeGreaterThanOrEqual(r.start);
    }
    // The .fai index is read whole in one go (spec §14 #4).
    const fai = c.filter((r) => r.fileId === 'ref.fa.fai');
    expect(fai.length).toBeGreaterThanOrEqual(1);
    expect(fai[0]).toMatchObject({ start: 0, end: 46 });
    // Only a small part of the 5 MB FASTA is read for a 2 kb view.
    const fastaBytes = c.filter((r) => r.fileId === 'ref.fa').reduce((n, r) => n + (r.end - r.start), 0);
    expect(fastaBytes).toBeLessThan(100_000);
  });

  test('loads BAM+BAI, bigWig, BED, GFF3 and VCF.gz+TBI through File-likes and keeps config.id', async ({ page }) => {
    await setupPage(page, ['ref.fa', 'ref.fa.fai', 'small.bam', 'small.bam.bai', 'coverage.bw', 'genes.bed', 'genes.gff3', 'variants.vcf.gz', 'variants.vcf.gz.tbi']);
    await createBrowser(page, 'chrT:1000-4000');
    const bam = await loadTrack(page, 't1', { name: 'small', type: 'alignment', format: 'bam' }, 'small.bam', 'small.bam.bai');
    expect(bam.type).toBe('alignment');
    expect(bam.id).toBe('t1');
    const bw = await loadTrack(page, 't2', { name: 'cov', type: 'wig', format: 'bigwig' }, 'coverage.bw');
    expect(bw.type).toBe('wig');
    const bed = await loadTrack(page, 't3', { name: 'genes', type: 'annotation', format: 'bed', indexed: false }, 'genes.bed');
    expect(bed.type).toBe('annotation');
    const gff = await loadTrack(page, 't4', { name: 'gff', type: 'annotation', format: 'gff3', indexed: false }, 'genes.gff3');
    expect(gff.type).toBe('annotation');
    const vcf = await loadTrack(page, 't5', { name: 'vars', type: 'variant', format: 'vcf' }, 'variants.vcf.gz', 'variants.vcf.gz.tbi');
    expect(vcf.type).toBe('variant');

    // Let igv finish drawing, then check the SVG has real content.
    await page.waitForTimeout(1500);
    const s = await svg(page);
    expect(s.startsWith('<svg')).toBe(true);
    expect(countRects(s)).toBeGreaterThan(50);

    const c = await calls(page);
    const bai = c.filter((r) => r.fileId === 'small.bam.bai');
    expect(bai.length).toBeGreaterThanOrEqual(1);
    expect(bai[0]).toMatchObject({ start: 0, end: 128 }); // index read whole
    const bedReads = c.filter((r) => r.fileId === 'genes.bed');
    expect(bedReads.some((r) => r.start === 0 && r.end === 1665)).toBe(true); // unindexed text read whole via arrayBuffer()
    const trackCount = await page.evaluate(() => window.__browser.trackViews.filter((tv) => tv.track && !['ruler', 'ideogram', 'sequence'].includes(tv.track.type ?? '')).length);
    expect(trackCount).toBe(5);
  });

  test('renders the planted SNP in large.bam and reads under 3% of the file over 5 navigations', async ({ page }) => {
    await setupPage(page, ['ref.fa', 'ref.fa.fai', 'large.bam', 'large.bam.bai']);
    const manifest = JSON.parse(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8')) as { facts: { snp: { alt: string; ref: string; pos?: number } } };
    const alt = manifest.facts.snp.alt;
    // igv 3.8.9 nucleotide colours as they appear in toSVG() output (spacing varies).
    const altColor: Record<string, RegExp> = {
      A: /fill="rgb\(\s*0\s*,\s*200\s*,\s*0\s*\)"/g,
      C: /fill="rgb\(\s*0\s*,\s*0\s*,\s*200\s*\)"/g,
      G: /fill="rgb\(\s*209\s*,\s*113\s*,\s*5\s*\)"/g,
      T: /fill="rgb\(\s*255\s*,\s*0\s*,\s*0\s*\)"/g,
    };
    await createBrowser(page, 'chrS:999,950-1,000,050');
    const t = await loadTrack(page, 't1', { name: 'large', type: 'alignment', format: 'bam', visibilityWindow: 30000 }, 'large.bam', 'large.bam.bai');
    expect(t.type).toBe('alignment');
    await page.waitForTimeout(2000);
    const s = await svg(page);
    const altHits = (s.match(altColor[alt]!) ?? []).length;
    expect(altHits, `expected mismatch marks coloured for alt base ${alt}`).toBeGreaterThanOrEqual(5);
    expect(countRects(s)).toBeGreaterThan(40);

    const bamBytes = (list: ReadCall[]) => list.filter((r) => r.fileId === 'large.bam').reduce((n, r) => n + (r.end - r.start), 0);
    const size = statSync(join(FIXTURES, 'large.bam')).size;
    const initial = await calls(page);
    const initialBytes = bamBytes(initial);
    for (const locus of ['chrS:2,000,000-2,002,000', 'chrS:3,500,000-3,502,000', 'chrS:100,000-102,000', 'chrS:4,900,000-4,902,000', 'chrS:999,900-1,000,100']) {
      await page.evaluate((l) => window.__browser.search(l), locus);
      await page.waitForTimeout(600);
    }
    const all = await calls(page);
    const navBytes = bamBytes(all) - initialBytes;
    const navPct = (100 * navBytes) / size;
    const totalPct = (100 * bamBytes(all)) / size;
    console.log(
      `large.bam (${size} bytes): initial load ${initialBytes} bytes; 5 navigations ${navBytes} bytes = ${navPct.toFixed(2)}% ` +
        `(${all.filter((r) => r.fileId === 'large.bam').length - initial.filter((r) => r.fileId === 'large.bam').length} reads); total ${totalPct.toFixed(2)}%`,
    );
    // Spec §12 M1: <3% of large.bam over 5 navigations. BAI chunk granularity (16 kb linear-index bins
    // at 12x depth) sets a floor of roughly 150-300 kB per 2 kb view, which on a 55 MB fixture is a visible
    // percentage; on real multi-GB files the same reads are a rounding error.
    expect(navPct).toBeLessThan(3);
    expect(totalPct).toBeLessThan(5);
  });

  test('loads CRAM+CRAI through File-likes when the reference has a sequence', async ({ page }) => {
    test.skip(!existsSync(join(FIXTURES, 'small.cram')), 'small.cram fixture missing');
    await setupPage(page, ['ref.fa', 'ref.fa.fai', 'small.cram', 'small.cram.crai']);
    await createBrowser(page, 'chrT:1000-3000');
    const cram = await loadTrack(page, 't1', { name: 'cram', type: 'alignment', format: 'cram' }, 'small.cram', 'small.cram.crai');
    expect(cram.type).toBe('alignment');
    await page.waitForTimeout(1500);
    const s = await svg(page);
    expect(countRects(s)).toBeGreaterThan(50);
    const c = await calls(page);
    expect(c.some((r) => r.fileId === 'small.cram.crai')).toBe(true);
    expect(c.some((r) => r.fileId === 'ref.fa')).toBe(true); // CRAM decoding reads the reference
  });

  test('removeBrowser disposes and a fresh container can host a new browser', async ({ page }) => {
    await setupPage(page, ['ref.fa', 'ref.fa.fai']);
    await createBrowser(page, 'chrT:1-2000');
    await page.evaluate(() => {
      igv.removeBrowser(window.__browser);
      document.getElementById('root')!.replaceChildren();
    });
    await createBrowser(page, 'chrT:5000-6000');
    expect(await page.evaluate(() => window.__browser.currentLoci())).toBe('chrT:5000-6000');
  });
});
