import { afterEach, describe, expect, it } from 'vitest';
import { createEditor, type EditorHandle } from '../editor/createEditor';
import { cleanDocument, exportHtml, exportMarkdown } from './document';

const editors: EditorHandle[] = [];
afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
});

async function open(markdown: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = await createEditor(root, { markdown });
  editor.view().setProps({ handleScrollToSelection: () => true });
  editors.push(editor);
  return editor;
}

function htmlDocument(editor: EditorHandle, clean = false) {
  return new DOMParser().parseFromString(exportHtml(editor, 'Export <title>', clean), 'text/html');
}

describe('structural document export', () => {
  it('omits QA and unedited origin blocks without deleting ordinary callouts, quotes or code', async () => {
    const editor = await open('Personal text\n\n> ordinary quoted text\n\n> [!note] My note\n> Keep this note\n>\n> > [!ai]\n> > Nested generated answer\n\n> [!question]\n> Secret question\n\n> [!ai]\n> Secret answer\n\n<!-- askdown:origin merged-1 -->\n\nUnedited generated paragraph\n\n<!-- askdown:origin-end merged-1 -->\n\n```md\n> [!ai]\n> Literal example\n```');
    const before = editor.getMarkdown();
    const state = editor.view().state;
    const clean = exportMarkdown(editor, true);
    expect(clean).toContain('Personal text');
    expect(clean).toContain('ordinary quoted text');
    expect(clean).toContain('[!note] My note');
    expect(clean).toContain('Keep this note');
    expect(clean).toContain('> [!ai]\n> Literal example');
    for (const text of ['Nested generated answer', 'Secret question', 'Secret answer', 'Unedited generated paragraph', 'askdown:origin']) expect(clean).not.toContain(text);
    const html = htmlDocument(editor, true);
    expect(html.querySelector('section')?.textContent).toContain('Keep this note');
    expect(html.querySelector('pre')?.textContent).toContain('> [!ai]');
    expect(html.body.textContent).not.toContain('Secret answer');
    expect(editor.getMarkdown()).toBe(before);
    expect(editor.view().state).toBe(state);
    cleanDocument(state.doc).check();
  });

  it('preserves human edits after provenance is removed and supports an entirely AI document', async () => {
    const editor = await open('<!-- askdown:origin merged-2 -->\n\nGenerated draft\n\n<!-- askdown:origin-end merged-2 -->');
    const view = editor.view();
    expect(htmlDocument(editor, true).body.textContent).not.toContain('Generated draft');
    cleanDocument(view.state.doc).check();
    view.dispatch(view.state.tr.insertText('My revised ', 2));
    expect(exportMarkdown(editor, true)).toContain('My revised Generated draft');
    expect(htmlDocument(editor, true).body.textContent).toContain('My revised Generated draft');
  });

  it('exports headings, working fragments, rich blocks and expanded answers without editor controls', async () => {
    const editor = await open('# First heading\n\n[Jump](#first-heading)\n\n# First heading\n\n3. Third\n4. Fourth\n\n- [x] Done\n- [ ] Waiting\n\n| A | B |\n| :- | -: |\n| **bold** | *italic* |\n\n```js\nconst html = "<script>";\n```\n\n![Example](https://example.com/image.png)\n\n> [!ai]- Saved answer\n> Answer body');
    const html = htmlDocument(editor);
    expect(html.title).toBe('Export <title>');
    expect(html.getElementById('first-heading')?.tagName).toBe('H1');
    expect(html.querySelector('a')?.getAttribute('href')).toBe('#first-heading');
    const headings = Array.from(html.querySelectorAll('h1'));
    expect(headings.map((heading) => heading.textContent)).toEqual(['First heading', 'First heading']);
    expect(headings[1].id).not.toBe(headings[0].id);
    expect(html.getElementById(headings[1].id)).toBe(headings[1]);
    expect(html.querySelector('ol')?.start).toBe(3);
    expect(html.querySelectorAll('li.task')).toHaveLength(2);
    expect(html.querySelector('td strong')?.textContent).toBe('bold');
    expect(html.querySelector('td em')?.textContent).toBe('italic');
    expect(html.querySelector('pre code')?.textContent).toContain('"<script>"');
    expect(html.querySelector('img')?.getAttribute('src')).toBe('https://example.com/image.png');
    expect(html.querySelector('section')?.textContent).toContain('Answer body');
    expect(html.querySelector('button,input,[contenteditable],[hidden],script')).toBeNull();
  });

  it('makes dangerous URLs and literal HTML inert while preserving safe links and image alt text', async () => {
    const editor = await open('Text');
    const view = editor.view();
    const schema = view.state.schema;
    const content = schema.nodes.paragraph.create(null, [
      schema.text('Bad link', [schema.marks.link.create({ href: 'javascript:alert(1)' })]),
      schema.text('Good link', [schema.marks.link.create({ href: 'https://example.com/?a=1&b=2' })]),
      schema.nodes.image.create({ src: 'data:image/svg+xml,<svg onload="alert(1)"/>', alt: 'Unsafe image' }),
      schema.nodes.html.create({ value: '<img src=x onerror="alert(1)"><script>alert(1)</script>' }),
    ]);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, content));
    const html = htmlDocument(editor);
    const links = html.querySelectorAll('a');
    expect(links[0].hasAttribute('href')).toBe(false);
    expect(links[1].getAttribute('href')).toBe('https://example.com/?a=1&b=2');
    expect(html.querySelector('img,script,[onerror],[onload]')).toBeNull();
    expect(html.body.textContent).toContain('Unsafe image');
    expect(html.body.textContent).toContain('<script>alert(1)</script>');
    expect(html.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
  });
});
