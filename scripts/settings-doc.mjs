// Generates docs/settings.md from package.json contributes.configuration.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const props = pkg.contributes.configuration.properties;
const rows = Object.entries(props)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, p]) => {
    const type = Array.isArray(p.type) ? p.type.join(' | ') : p.enum ? p.enum.map((e) => `\`${e}\``).join(' / ') : p.type;
    const def = p.default === '' ? '(empty)' : typeof p.default === 'object' ? `\`${JSON.stringify(p.default)}\`` : `\`${p.default}\``;
    const desc = (p.markdownDescription ?? p.description ?? '').replace(/\n+/g, ' ');
    return `| \`${key}\` | ${type} | ${def} | ${p.scope ?? 'window'} | ${desc} |`;
  });
const out = `# Settings reference

Generated from \`package.json\` by \`npm run settings-doc\`. All settings live under \`igv.*\`.

| Setting | Type | Default | Scope | Description |
|---|---|---|---|---|
${rows.join('\n')}

## Commands

${pkg.contributes.commands.map((c) => `- **${c.category}: ${c.title}** (\`${c.command}\`)`).join('\n')}
`;
writeFileSync(join(root, 'docs/settings.md'), out);
console.log(`wrote docs/settings.md (${rows.length} settings, ${pkg.contributes.commands.length} commands)`);
