import { test, expect, type Page } from '@playwright/test';

const root = 'p1-vault';
const source = '# Reading\n\nImportant chosen clause. Other context.\n\nTrailing paragraph.\n';
const fileKey = `askdown:file:${root}/reading.md`;

function messageText(message: { content: string | { type: string; text?: string }[] }): string {
  return typeof message.content === 'string' ? message.content : message.content.map((part) => part.text ?? '').join('\n\n');
}

async function selectClause(page: Page) {
  await page.locator('.doc .ProseMirror > p').filter({ hasText: 'Important chosen clause.' }).evaluate((element) => {
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'Important chosen clause.'.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    (element.closest('.ProseMirror') as HTMLElement).focus();
    document.dispatchEvent(new Event('selectionchange'));
  });
}

async function prepare(page: Page, markdown = source) {
  await page.addInitScript(({ root, source }) => {
    if (localStorage.getItem('p1-initialized')) return;
    localStorage.setItem('p1-initialized', 'yes');
    localStorage.setItem(`askdown:file:${root}/reading.md`, JSON.stringify({ content: source, modified: 1 }));
    localStorage.setItem('askdown:settings', JSON.stringify({ provider: 'openai-compatible', lastVault: root, lastFile: 'reading.md', showNotes: true, compat: { preset: 'ollama', baseURL: 'https://model.test/v1', model: 'test', apiKey: '' } }));
  }, { root, source: markdown });
  await page.goto('/');
  await expect(page.locator('.doc .ProseMirror')).toContainText('Important chosen clause.');
}

function stream(text: string) {
  return `data: ${JSON.stringify({ id: 'p1', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'p1', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
}

test('selection, keyboard controls, follow-up context, margin layout and AI provenance survive saving', async ({ page }) => {
  const prompts: string[] = [];
  await page.route('https://model.test/v1/chat/completions', async (route) => {
    prompts.push(route.request().postDataJSON().messages.map(messageText).join('\n'));
    await route.fulfill({ contentType: 'text/event-stream', body: stream(`Answer number ${prompts.length}.`) });
  });
  await prepare(page);
  await selectClause(page);
  await page.keyboard.press('ControlOrMeta+Enter');
  const questions = page.locator('.doc .callout-question');
  await expect(questions).toHaveCount(1);
  await questions.first().locator('.callout-body').click();
  await page.keyboard.type('Why this clause?');
  await page.keyboard.press('Enter');
  const answers = page.locator('.doc .callout-ai');
  await expect(answers.first()).toContainText('Answer number 1.');
  expect(prompts[0]).toContain('Important chosen clause.');
  await answers.first().getByRole('button', { name: '追问', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(questions).toHaveCount(2);
  await page.keyboard.type('What follows from that?');
  await page.keyboard.press('Enter');
  await expect(answers.nth(1)).toContainText('Answer number 2.');
  expect(prompts[1]).toContain('Why this clause?');
  expect(prompts[1]).toContain('Answer number 1.');
  await answers.first().getByRole('button', { name: '更短', exact: true }).click();
  await expect(answers.first()).toContainText('Answer number 3.');
  expect(prompts[2]).toContain('Answer number 1.');
  const collapse = answers.first().getByRole('button', { name: '收起', exact: true });
  await collapse.focus();
  await page.keyboard.press('Space');
  await expect(answers.first().getByRole('button', { name: '展开', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).content, fileKey)).toContain('[!ai]-');
  await page.getByRole('button', { name: '页边批注', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('askdown:settings')!).qaMode)).toBe('margin');
  await page.reload();
  await expect(page.locator('.doc')).toHaveClass(/margin-mode/);
  await expect(answers.first().getByRole('button', { name: '展开', exact: true })).toHaveAttribute('aria-expanded', 'false');
  const bodyBox = await page.locator('.doc .ProseMirror > p').filter({ hasText: 'Important chosen clause.' }).boundingBox();
  const questionBox = await questions.first().boundingBox();
  expect(questionBox!.x).toBeGreaterThan(bodyBox!.x + bodyBox!.width);
  await answers.first().getByRole('button', { name: '并入正文', exact: true }).click();
  await expect(page.locator('.doc .ai-origin')).toContainText('Answer number 3.');
  await page.locator('.doc .ai-origin').locator('p').first().click();
  await page.keyboard.type('Edited ');
  await expect(page.locator('.doc .ai-origin')).toHaveCount(0);
  await expect(page.locator('.doc .ProseMirror')).toContainText('Important chosen clause. Other context.');
});

test('a user-created prompt file becomes a runnable selection action', async ({ page }) => {
  const prompts: string[] = [];
  await page.route('https://model.test/v1/chat/completions', async (route) => {
    prompts.push(route.request().postDataJSON().messages.map(messageText).join('\n'));
    await route.fulfill({ contentType: 'text/event-stream', body: stream('Custom action result.') });
  });
  await prepare(page);
  await page.evaluate((root) => localStorage.setItem(`askdown:file:${root}/.askdown/prompts/Check assumptions.md`, JSON.stringify({ content: 'CHECK_ASSUMPTIONS\n{{anchor}}\n{{document}}', modified: Date.now() })), root);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await selectClause(page);
  await page.locator('.action-menu summary').click();
  await page.getByRole('button', { name: 'Check assumptions', exact: true }).click();
  await expect(page.locator('.doc .callout-ai')).toContainText('Custom action result.');
  expect(prompts[0]).toContain('CHECK_ASSUMPTIONS');
  expect(prompts[0]).toContain('Important chosen clause.');
});

test('notes sources navigate, unresolved items become follow-ups, and saved progress excludes old answers', async ({ page }) => {
  const tidyPrompts: string[] = [];
  let notesText = '';
  await page.route('https://model.test/v1/chat/completions', async (route) => {
    const prompt = route.request().postDataJSON().messages.map(messageText).join('\n');
    let text = 'Follow-up answer.';
    if (prompt.includes('必须遵守的来源约定')) {
      tidyPrompts.push(prompt);
      const ids = [...prompt.matchAll(/来源：\[来源\]\(#q-([a-f0-9-]+)\)/g)].map((match) => match[1]);
      if (tidyPrompts.length === 1) {
        notesText = `## 要点\n\n- Initial insight. [来源](#q-${ids[0]})\n\n## 还没搞懂的\n\n- ?? What assumption should I check? [来源](#q-${ids[0]})`;
      } else {
        notesText += `\n\n## 新要点\n\n- Follow-up insight. [来源](#q-${ids[0]})`;
      }
      text = notesText;
    }
    await route.fulfill({ contentType: 'text/event-stream', body: stream(text) });
  });
  await prepare(page, source + '\n> [!question]\n> Original question?\n\n> [!ai]\n> Original answer.\n');
  await page.getByRole('button', { name: '整理新增问答', exact: true }).click();
  await expect(page.locator('.notes-editor')).toContainText('Initial insight.');
  const originalId = await page.locator('.doc .callout-question').getAttribute('data-id');
  const notesKey = `askdown:file:${root}/reading.notes.md`;
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.content, notesKey)).toContain('Initial insight.');
  await page.reload();
  await expect(page.locator('.doc .callout-question')).toHaveAttribute('data-id', originalId!);
  await expect(page.locator('.notes-editor')).toContainText('Initial insight.');
  const sourceLink = page.locator('.notes-editor').getByRole('link', { name: '来源', exact: true }).first();
  await sourceLink.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('.callout-question')?.textContent)).toContain('Original question?');
  await page.getByRole('button', { name: '插入正文追问', exact: true }).click();
  await expect(page.locator('.doc .callout-question')).toHaveCount(2);
  await expect(page.locator('.doc .callout-question').last()).toContainText('What assumption should I check?');
  await page.keyboard.press('Enter');
  await expect(page.locator('.doc .callout-ai').last()).toContainText('Follow-up answer.');
  await page.getByRole('button', { name: '整理新增问答', exact: true }).click();
  await expect(page.locator('.notes-editor')).toContainText('Follow-up insight.');
  expect(tidyPrompts).toHaveLength(2);
  const secondBatch = tidyPrompts[1].matchAll(/来源：\[来源\]\(#q-([a-f0-9-]+)\)/g);
  expect([...secondBatch].map((match) => match[1])).toEqual([await page.locator('.doc .callout-question').last().getAttribute('data-id')]);
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).content, notesKey)).toContain('Follow-up insight.');
  await page.reload();
  await expect(page.locator('.notes-editor')).toContainText('Follow-up insight.');
  await page.getByRole('button', { name: '整理新增问答', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('没有新增或修改的回答');
  expect(tidyPrompts).toHaveLength(2);
});
