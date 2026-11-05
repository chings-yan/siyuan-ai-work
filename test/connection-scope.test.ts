import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourcePath = new URL('../src/index.ts', import.meta.url);

 test('connection status updates are scoped to each SAC root', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const updateConnectionUI = source.match(/private updateConnectionUI[\s\S]*?private refreshConnection/)?.[0] || '';

  assert.match(updateConnectionUI, /this\.roomViews\.forEach/);
  assert.match(updateConnectionUI, /this\.renderStatus\(root\)/);
  assert.doesNotMatch(updateConnectionUI, /document\.querySelectorAll\s*<HTMLElement>\('\[data-status\]'\)/);
  assert.doesNotMatch(source, /document\.querySelectorAll\s*<HTMLElement>\('\[data-status\]'\)/);
});
