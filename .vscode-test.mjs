import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out-test/integration/**/*.test.js',
  version: 'stable',
  workspaceFolder: 'test/fixtures/workspace',
  mocha: {
    ui: 'tdd',
    timeout: 180_000,
    color: true,
  },
  launchArgs: ['--disable-extensions', '--disable-gpu'],
  env: { IGV_LOG_CONSOLE: '1' },
});
