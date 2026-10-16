import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';

const root = 'import-vault';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const key = (path: string) => `askdown:file:${root}/${path}`;

async function prepare(page: Page) {
  await page.addInitScript((root) => {
    if (localStorage.getItem('import-prepared')) return;
    localStorage.setItem('import-prepared', 'yes');
    localStorage.setItem(`askdown:file:${root}/start.md`, JSON.stringify({ content: '# Start\n\nExisting writing.\n', modified: 1 }));
    localStorage.setItem('askdown:settings', JSON.stringify({ provider: 'openai-compatible', lastVault: root, lastFile: 'start.md', showNotes: false, compat: { preset: 'ollama', baseURL: 'https://model.test/v1', model: 'vision-test', apiKey: '' } }));
  }, root);
  await page.goto('/');
  await expect(page.locator('.doc .ProseMirror')).toContainText('Existing writing.');
}

const stored = (page: Page, path: string) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.content ?? null, key(path));

async function importFile(page: Page, name: string, buffer: Buffer, mimeType: string) {
  await page.getByRole('button', { name: '导入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入阅读材料' });
  await dialog.getByRole('button', { name: 'PDF / EPUB', exact: true }).click();
  await dialog.getByLabel('选择书籍文件').setInputFiles({ name, mimeType, buffer });
  await dialog.getByRole('button', { name: '导入并阅读', exact: true }).click();
  return dialog;
}

function epub(encrypted = false) {
  const entries: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'book/content.opf': strToU8('<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Reading Book</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="z" href="z.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="z"/><itemref idref="a"/></spine></package>'),
    'book/z.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>First chapter</title></head><body><h1>First in spine</h1><p>First chapter content.</p><img src="img.png" alt="Embedded diagram"/><a href="a.xhtml#second">Next chapter</a></body></html>'),
    'book/a.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second chapter</title></head><body><h1 id="second">Second in spine</h1><p>Second chapter content.</p></body></html>'),
    'book/img.png': Uint8Array.from(Buffer.from(png, 'base64')),
  };
  if (encrypted) entries['META-INF/encryption.xml'] = strToU8('<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/></EncryptedData></encryption>');
  return Buffer.from(zipSync(entries));
}

function pdf() {
  const text = 'BT /F1 24 Tf 50 740 Td (Chapter One) Tj /F1 12 Tf 0 -40 Td (Selectable PDF body text.) Tj ET';
  const graphic = '0.2 0.4 0.8 rg 80 450 260 180 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    `<< /Length ${graphic.length} >>\nstream\n${graphic}\nendstream`,
    '<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>',
    '<< /Title (Outline chapter) /Parent 8 0 R /Dest [3 0 R /Fit] >>',
    '<< /Title (PDF Reading) >>',
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 10 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(content);
}

function stream(text: string) {
  return `data: ${JSON.stringify({ id: 'image', object: 'chat.completion.chunk', created: 1, model: 'vision-test', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'image', object: 'chat.completion.chunk', created: 1, model: 'vision-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
}

test('web import keeps originals unchanged while image questions persist and send real image parts', async ({ page }) => {
  const requests: Array<{ messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }> }> = [];
  await page.route('https://model.test/v1/chat/completions', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: 'text/event-stream', body: stream('The diagram explains the reading.') });
  });
  await page.route('https://article.test/essay', (route) => route.fulfill({ contentType: 'text/html', body: `<html><head><title>Imported Essay</title></head><body><nav>Navigation noise</nav><article><h1>Imported Essay</h1><p>${'This article explains reading in depth. '.repeat(30)}</p><h2>Important section</h2><p>The exact source paragraph stays unchanged.</p><img src="/chart.png" alt="Reading chart" onerror="alert('unsafe')"><table><tr><th>Item</th><th>Value</th></tr><tr><td>Reading</td><td>42</td></tr></table><script>alert('unsafe')</script></article></body></html>` }));
  await page.route('https://article.test/chart.png', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }));
  await prepare(page);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.getByLabel('文章链接').fill('https://article.test/essay');
  await page.getByRole('button', { name: '导入并阅读', exact: true }).click();
  const source = page.locator('.source-document .ProseMirror');
  const annotations = page.locator('.annotation-document .ProseMirror');
  await expect(source).toContainText('Important section');
  await expect(source).toHaveAttribute('contenteditable', 'false');
  await expect(source.locator('table')).toContainText('42');
  const original = await stored(page, 'Imported Essay.md');
  expect(original).toContain('https://article.test/chart.png');
  expect(original).not.toContain('onerror');
  await source.locator('img[src]').click();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(annotations.locator('.callout-question')).toHaveCount(1);
  await page.keyboard.type('Explain this image.');
  await page.keyboard.press('Enter');
  await expect(annotations.locator('.callout-ai')).toContainText('The diagram explains');
  const parts = requests[0].messages[0].content;
  expect(parts.find((part) => part.type === 'image_url')?.image_url?.url).toBe(`data:image/png;base64,${png}`);
  expect(parts.find((part) => part.type === 'text')?.text).toContain('The exact source paragraph');
  expect(parts.find((part) => part.type === 'text')?.text).not.toContain(png);
  await expect.poll(() => stored(page, 'Imported Essay.annotations.md')).toContain('Explain this image.');
  expect(await stored(page, 'Imported Essay.md')).toBe(original);
  await page.reload();
  await expect(annotations.locator('.callout-ai')).toContainText('The diagram explains');
  await annotations.getByRole('button', { name: '追问', exact: true }).click();
  await page.keyboard.type('What should I notice next?');
  await page.keyboard.press('Enter');
  await expect(annotations.locator('.callout-ai')).toHaveCount(2);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].messages[0].content.find((part) => part.type === 'image_url')?.image_url?.url).toBe(`data:image/png;base64,${png}`);
  expect(await stored(page, 'Imported Essay.md')).toBe(original);
  await page.getByRole('button', { name: '允许编辑原文', exact: true }).click();
  await expect(source).toHaveAttribute('contenteditable', 'true');
  await source.locator('p').filter({ hasText: 'The exact source paragraph stays unchanged.' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.type('User revision. ');
  await page.getByRole('button', { name: '锁定原文', exact: true }).click();
  await expect(page.getByRole('button', { name: '允许编辑原文', exact: true })).toBeEnabled();
  await expect(source).toHaveAttribute('contenteditable', 'false');
  const revised = await stored(page, 'Imported Essay.md');
  expect(revised).toContain('User revision.');
  await source.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await page.getByRole('treeitem', { name: 'start', exact: true }).click();
  await expect(source).not.toBeVisible();
  await expect(page.locator('.doc .ProseMirror')).toContainText('Existing writing.');
  expect(await stored(page, 'Imported Essay.md')).toBe(revised);
  await page.getByRole('treeitem', { name: 'Imported Essay', exact: true }).click();
  await expect(source).toHaveAttribute('contenteditable', 'false');
  await expect(source).toContainText('User revision.');
});

test('EPUB respects spine order, embeds images, saves personal notes and avoids duplicate overwrite', async ({ page }) => {
  await prepare(page);
  const dialog = await importFile(page, 'reading.epub', epub(), 'application/epub+zip');
  await expect(dialog).not.toBeVisible();
  const source = page.locator('.source-document .ProseMirror');
  await expect(source).toContainText('First chapter content.');
  const original = await stored(page, 'Reading Book.md');
  expect(original.indexOf('First in spine')).toBeLessThan(original.indexOf('Second in spine'));
  expect(original).toContain(`data:image/png;base64,${png}`);
  const annotations = page.locator('.annotation-document .ProseMirror');
  await annotations.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('My independent reading note.');
  await expect.poll(() => stored(page, 'Reading Book.annotations.md')).toContain('My independent reading note.');
  await page.reload();
  await expect(annotations).toContainText('My independent reading note.');
  expect(await stored(page, 'Reading Book.md')).toBe(original);
  await expect(source.locator('img[src]')).toHaveAttribute('src', `data:image/png;base64,${png}`);
  const second = await importFile(page, 'reading.epub', epub(), 'application/epub+zip');
  await expect(second).not.toBeVisible();
  await expect.poll(() => stored(page, 'Reading Book (2).md')).toBe(original);
  expect(await stored(page, 'Reading Book.md')).toBe(original);
});

test('PDF extracts bookmarks and page text and retains image-only pages for image questions', async ({ page }) => {
  await prepare(page);
  const dialog = await importFile(page, 'reading.pdf', pdf(), 'application/pdf');
  await expect(dialog).not.toBeVisible({ timeout: 20000 });
  const source = page.locator('.source-document .ProseMirror');
  await expect(source).toContainText('Outline chapter');
  await expect(source).toContainText('Selectable PDF body text.');
  await expect(source).toContainText('第 2 页');
  await expect(source.locator('img[src]')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect(source.locator('img[src]')).toHaveJSProperty('complete', true);
  const original = await stored(page, 'PDF Reading.md');
  await page.reload();
  await expect(source).toHaveAttribute('contenteditable', 'false');
  await expect(source).toContainText('Selectable PDF body text.');
  expect(await stored(page, 'PDF Reading.md')).toBe(original);
});

test('invalid and DRM-protected books stay unsaved and show actionable errors', async ({ page }) => {
  await prepare(page);
  let dialog = await importFile(page, 'broken.pdf', Buffer.from('not a document'), 'application/pdf');
  await expect(dialog.getByRole('alert')).toContainText('无法识别书籍内容');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  dialog = await importFile(page, 'locked.epub', epub(true), 'application/epub+zip');
  await expect(dialog.getByRole('alert')).toContainText('DRM');
  expect(await stored(page, 'Reading Book.md')).toBeNull();
  expect(await stored(page, 'broken.md')).toBeNull();
});
