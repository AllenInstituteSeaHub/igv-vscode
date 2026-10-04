// Copies the pinned igv.js UMD bundle from node_modules into media/ so the
// webview can load it from an extension resource URI. igv.js is never
// modified (spec §1 principle 4).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'node_modules/igv/package.json'), 'utf8'));
const pinned = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies.igv;
if (pkg.version !== pinned) {
  console.error(`igv version mismatch: installed ${pkg.version}, package.json pins ${pinned}`);
  process.exit(1);
}
mkdirSync(join(root, 'media'), { recursive: true });
copyFileSync(join(root, 'node_modules/igv/dist/igv.min.js'), join(root, 'media/igv.min.js'));
writeFileSync(join(root, 'media/igv-version.json'), JSON.stringify({ version: pkg.version }) + '\n');
console.log(`copied igv ${pkg.version} -> media/igv.min.js`);
