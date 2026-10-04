// Builds the three bundles described in the spec (§12 M0):
//   dist/extension.js  Node, CommonJS, runs in the extension host
//   dist/webview.js    browser IIFE, runs inside the webview next to media/igv.min.js
//   dist/cli.js        Node, CommonJS, the `igv-vscode` CLI and MCP server
import * as esbuild from 'esbuild';
import { globSync } from 'glob';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
  {
    ...common,
    entryPoints: ['src/agent/cli.ts'],
    outfile: 'dist/cli.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
  },
  {
    // Integration tests run by @vscode/test-cli inside a real VS Code (spec §11.2).
    ...common,
    minify: false,
    entryPoints: globSync('test/integration/**/*.test.ts'),
    outdir: 'out-test/integration',
    outbase: 'test/integration',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'mocha'],
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
