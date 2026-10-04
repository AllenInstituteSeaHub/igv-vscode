// Downloads the igv-data genome list from GitHub into media/genomes.json and
// records the fetch date. Do not use igv.org endpoints (spec §7, §14 #6).
// If the download fails and a previous copy exists, the previous copy is kept
// so offline builds still work.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENOMES_URL =
  'https://raw.githubusercontent.com/igvteam/igv-data/refs/heads/main/genomes/web/genomes.json';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'media/genomes.json');
const metaFile = join(root, 'media/genomes-meta.json');

async function main() {
  mkdirSync(join(root, 'media'), { recursive: true });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(GENOMES_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const list = JSON.parse(text);
    if (!Array.isArray(list) || list.length === 0 || !list.every((g) => typeof g.id === 'string')) {
      throw new Error('unexpected genome list shape');
    }
    writeFileSync(outFile, JSON.stringify(list, null, 2) + '\n');
    writeFileSync(
      metaFile,
      JSON.stringify({ source: GENOMES_URL, fetchedAt: new Date().toISOString(), count: list.length }, null, 2) + '\n',
    );
    console.log(`fetched ${list.length} genomes -> media/genomes.json`);
  } catch (err) {
    if (existsSync(outFile)) {
      const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
      console.warn(`genome list fetch failed (${err.message}); keeping copy from ${meta.fetchedAt ?? 'unknown date'}`);
      return;
    }
    console.error(`genome list fetch failed and no cached copy exists: ${err.message}`);
    process.exit(1);
  }
}

main();
