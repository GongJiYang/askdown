import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const root = 'e2e-vault';
const path = `${root}/reading.md`;
const fileKey = `askdown:file:${path}`;
const original = '# Reading\n\nContext paragraph.\n\n> [!question]\n> Why?\n\n> [!ai]\n> Previous complete answer.\n\nTail paragraph.\n';
let response: ServerResponse | undefined;
let apiURL: string;
const server = createServer((request, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (request.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  request.resume();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'Uncommitted preview' }, finish_reason: null }] })}\n\n`);
  response = res;
});

function finish(text = 'Completed answer.') {
  response?.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
  response?.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  response?.end('data: [DONE]\n\n');
  response = undefined;
}

test.beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
test.afterAll(async () => { finish(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
test.afterEach(() => finish());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ root, path, original, apiURL }) => {
    if (localStorage.getItem('e2e-initialized')) return;
    localStorage.setItem('e2e-initialized', 'yes');
    localStorage.setItem(`askdown:file:${path}`, JSON.stringify({ content: original, modified: 1 }));
    localStorage.setItem(`askdown:file:${root}/second.md`, JSON.stringify({ content: '# Second\n', modified: 1 }));
    localStorage.setItem('askdown:settings', JSON.stringify({ provider: 'openai-compatible', lastVault: root, lastFile: 'reading.md', showNotes: true, compat: { preset: 'custom', baseURL: apiURL, model: 'test', apiKey: 'browser-test-key' }, search: { apiKey: 'browser-search-key' } }));
  }, { root, path, original, apiURL });
  await page.goto('/');
  await expect(page.locator('.doc .ProseMirror')).toBeVisible();
});

test('external changes block saves and navigation; reload and history recovery retain both versions', async ({ page, context }) => {
  const editor = page.locator('.doc .ProseMirror');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Local draft');
  const external = await context.newPage();
  await external.goto('/');
  await external.evaluate(({ fileKey }) => localStorage.setItem(fileKey, JSON.stringify({ content: '# External replacement\n', modified: 2 })), { fileKey });
  await expect(page.locator('.doc')).toContainText('文件已被外部修改');
  await page.getByRole('treeitem', { name: 'second', exact: true }).click();
  await expect(page.locator('.doc-title')).toHaveText('reading');
  await page.locator('.doc').getByRole('button', { name: '重新载入', exact: true }).click();
  await expect(editor).toContainText('External replacement');
  await page.locator('.doc').getByRole('button', { name: '版本历史', exact: true }).click();
  const versions = page.locator('.history-versions button');
  for (let i = 0; i < await versions.count(); i++) {
    await versions.nth(i).click();
    if ((await page.getByLabel('历史版本内容').inputValue()).includes('Local draft')) break;
  }
  await expect(page.getByLabel('历史版本内容')).toHaveValue(/Local draft/);
  await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await expect(editor).toContainText('Local draft');
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).content, fileKey)).toContain('Local draft');
  await external.close();
});

test('stream preview never reaches disk; protected content survives stop and complete answer undoes once', async ({ page }) => {
  const editor = page.locator('.doc .ProseMirror');
  const before = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).content, fileKey);
  await page.locator('.doc [data-action="reask"]').click();
  await expect(page.locator('.doc')).toContainText('Uncommitted preview');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).content, fileKey)).toBe(before);
  await page.locator('.doc').getByRole('button', { name: /停止/ }).click();
  finish('Late content');
  await expect(editor).toContainText('Previous complete answer.');
  await expect(editor).not.toContainText('Late content');
  await page.locator('.doc [data-action="reask"]').click();
  await expect(page.locator('.doc')).toContainText('Uncommitted preview');
  finish();
  await expect(editor).toContainText('Completed answer.');
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).content, fileKey)).toContain('Completed answer.');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toContainText('Previous complete answer.');
  await expect(editor).not.toContainText('Completed answer.');
});

test('switching immediately after typing flushes the latest edit; model keys never persist', async ({ page }) => {
  const editor = page.locator('.doc .ProseMirror');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Immediate edit');
  await page.getByRole('treeitem', { name: 'second', exact: true }).click();
  await expect(page.locator('.doc-title')).toHaveText('second');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).content, fileKey)).toContain('Immediate edit');
  expect(await page.evaluate(() => localStorage.getItem('askdown:settings'))).not.toContain('browser-test-key');
  expect(await page.evaluate(() => localStorage.getItem('askdown:settings'))).not.toContain('browser-search-key');
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('#compat-key')).toHaveValue('');
  await expect(page.getByLabel('搜索 API Key')).toHaveValue('');
});

test('tidying uses a separate preview and cancellation retains existing notes', async ({ page }) => {
  await page.getByRole('button', { name: '整理新增问答', exact: true }).click();
  await expect(page.getByLabel('整理预览')).toContainText('Uncommitted preview');
  expect(await page.evaluate((root) => localStorage.getItem(`askdown:file:${root}/reading.notes.md`), root)).toBeNull();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  finish('Late notes');
  await expect(page.getByLabel('整理预览')).not.toBeVisible();
  expect(await page.evaluate((root) => localStorage.getItem(`askdown:file:${root}/reading.notes.md`), root)).toBeNull();
});
