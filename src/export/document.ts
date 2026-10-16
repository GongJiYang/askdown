import { DOMSerializer, Fragment, type Node as PMNode, type DOMOutputSpec } from '@milkdown/kit/prose/model';
import type { EditorHandle } from '../editor/createEditor';
import { ANSWER, QUESTION, calloutLabel } from '../editor/callout';

/** Provenance wrappers survive only until a user edits their content. */
export function cleanDocument(doc: PMNode): PMNode {
  function visit(node: PMNode): PMNode | null {
    if (node.type.name === 'ai_origin' || node.type.name === 'callout' && [QUESTION, ANSWER].includes(node.attrs.kind)) return null;
    if (node.isLeaf) return node;
    const children: PMNode[] = [];
    let changed = false;
    node.forEach((child) => {
      const kept = visit(child);
      if (kept) children.push(kept);
      if (kept !== child) changed = true;
    });
    if (!changed) return node;
    if (!children.length && node !== doc && !['table_cell', 'table_header'].includes(node.type.name)) return null;
    const result = node.type.createAndFill(node.attrs, Fragment.fromArray(children), node.marks);
    if (!result) throw new Error('无法保留清洁导出的文档结构。');
    return result;
  }
  return visit(doc)!;
}

export function exportMarkdown(editor: EditorHandle, clean = false): string {
  const doc = editor.view().state.doc;
  return editor.serialize(clean ? cleanDocument(doc) : doc);
}

// A relative URL remains relative in a downloaded document; never resolve it to the app origin.
function safeUrl(value: string, image: boolean): string | null {
  const raw = value.trim();
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw) || raw.includes('\\')) return null;
  if (image && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/]+={0,2}$/i.test(raw)) return raw;
  if (raw.startsWith('#')) return image ? null : raw;
  try {
    const url = new URL(raw, 'https://export.invalid/');
    if (url.protocol === 'https:' || url.protocol === 'http:' || !image && ['mailto:', 'tel:'].includes(url.protocol)) return raw;
  } catch { /* Invalid URLs become inert text or image alt text. */ }
  return null;
}

const TAGS: Record<string, true | undefined> = {
  p: true, br: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
  blockquote: true, ul: true, ol: true, li: true, pre: true, code: true,
  strong: true, em: true, s: true, del: true, a: true, img: true, hr: true,
  table: true, thead: true, tbody: true, tfoot: true, tr: true, th: true, td: true,
  div: true, span: true, sup: true, sub: true, section: true,
};

/** Rebuild rather than copy attributes: raw HTML, event handlers and active elements stay inert. */
function sanitize(source: Node, document: Document): Node {
  if (source.nodeType === Node.TEXT_NODE) return document.createTextNode(source.textContent ?? '');
  if (source.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
  const element = source as Element;
  const tag = element.tagName.toLowerCase();
  if (TAGS[tag] !== true) return document.createTextNode(element.textContent ?? '');
  const result = document.createElement(tag);
  if (element.hasAttribute('title')) result.title = element.getAttribute('title')!;
  if (/^h[1-6]$/.test(tag) || tag === 'section' || tag === 'sup') {
    const id = element.getAttribute('id');
    if (id && !/[\u0000-\u0020\u007f]/.test(id)) result.id = id;
  }
  if (tag === 'a') {
    const href = safeUrl(element.getAttribute('href') ?? '', false);
    if (href) result.setAttribute('href', href);
    result.setAttribute('rel', 'noopener noreferrer');
  }
  if (tag === 'img') {
    const alt = element.getAttribute('alt') ?? '';
    const src = safeUrl(element.getAttribute('src') ?? '', true);
    if (!src) return document.createTextNode(alt);
    result.setAttribute('src', src);
    result.setAttribute('alt', alt);
    result.setAttribute('referrerpolicy', 'no-referrer');
  }
  if (tag === 'ol' && /^-?\d+$/.test(element.getAttribute('start') ?? '')) result.setAttribute('start', element.getAttribute('start')!);
  if (tag === 'td' || tag === 'th') {
    for (const name of ['colspan', 'rowspan']) {
      const value = element.getAttribute(name);
      if (value && /^[1-9]\d{0,3}$/.test(value)) result.setAttribute(name, value);
    }
    const alignment = (element as HTMLElement).style.textAlign;
    if (['left', 'center', 'right'].includes(alignment)) result.style.textAlign = alignment;
  }
  if (tag === 'section') result.className = 'callout';
  if (tag === 'li' && ['true', 'false'].includes(element.getAttribute('data-checked') ?? '')) {
    result.className = 'task';
    const checkbox = document.createElement('span');
    checkbox.className = 'task-check';
    const checked = element.getAttribute('data-checked') === 'true';
    checkbox.textContent = checked ? '☑' : '☐';
    checkbox.setAttribute('aria-label', checked ? '已完成' : '未完成');
    result.append(checkbox);
  }
  for (const child of element.childNodes) result.append(sanitize(child, document));
  return result;
}

export const EXPORT_STYLE = `
:root { color-scheme: light; }
body { margin: 0; color: #20242a; background: white; font: 16px/1.75 system-ui, -apple-system, sans-serif; }
article { max-width: 780px; margin: 0 auto; padding: 40px 32px; overflow-wrap: anywhere; }
h1,h2,h3,h4,h5,h6 { line-height: 1.3; margin: 1.5em 0 .6em; break-after: avoid; }
h1 { font-size: 2em; } h2 { font-size: 1.6em; } h3 { font-size: 1.3em; }
a { color: #175ca3; text-decoration: underline; } p { margin: .8em 0; }
blockquote,.callout { border-left: 3px solid #bac7d8; margin: 1em 0; padding: .2em 1em; background: #f5f7fa; }
.callout > header { font-weight: 600; } .callout > div > :first-child { margin-top: .4em; }
pre { padding: 1em; background: #f3f4f6; white-space: pre-wrap; overflow-wrap: anywhere; }
code { font: .9em/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
:not(pre) > code { background: #f3f4f6; padding: .1em .25em; }
img { max-width: 100%; height: auto; } table { width: 100%; border-collapse: collapse; margin: 1em 0; }
th,td { border: 1px solid #cfd5dc; padding: .4em .65em; } th { background: #f3f4f6; }
ul,ol { padding-left: 1.75em; } li > p { margin: .25em 0; }
li.task { list-style: none; position: relative; } .task-check { position: absolute; left: -1.4em; }
hr { border: 0; border-top: 1px solid #cfd5dc; margin: 2em 0; }
@page { margin: 18mm; }
@media print { body { font-size: 11pt; } article { max-width: none; margin: 0; padding: 0; } img,tr { break-inside: avoid; } thead { display: table-header-group; } }
`;

/** Serialize the model, never the editor DOM (which contains controls and streaming previews). */
export function exportHtml(editor: EditorHandle, title: string, clean = false): string {
  const state = editor.view().state;
  const doc = clean ? cleanDocument(state.doc) : state.doc;
  const output = document.implementation.createHTMLDocument(title);
  output.documentElement.lang = 'zh-CN';
  const charset = output.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  output.head.prepend(charset);
  const viewport = output.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  output.head.append(viewport);
  const policy = output.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  output.head.append(policy);
  const style = output.createElement('style');
  style.textContent = EXPORT_STYLE;
  output.head.append(style);
  const base = DOMSerializer.fromSchema(state.schema);
  const serializer = new DOMSerializer({ ...base.nodes, callout: (node): DOMOutputSpec => {
    const id = node.attrs.id && [QUESTION, ANSWER].includes(node.attrs.kind)
      ? `${node.attrs.kind === QUESTION ? 'q' : 'a'}-${node.attrs.id}` : null;
    const images: DOMOutputSpec[] = Array.isArray(node.attrs.images)
      ? node.attrs.images.filter((image: unknown): image is string => typeof image === 'string').map((src: string) => ['img', { src, alt: '提问图片' }]) : [];
    return ['section', { id }, ['strong', `${calloutLabel(node.attrs.kind)}${node.attrs.title ? ` · ${node.attrs.title}` : ''}`], ...images, ['div', 0]];
  }, ai_origin: () => ['div', 0] }, base.marks);
  const rendered = serializer.serializeFragment(doc.content, { document: output });
  const article = output.createElement('article');
  for (const child of rendered.childNodes) article.append(sanitize(child, output));
  // Keep the schema's heading IDs, adding deterministic suffixes for duplicates.
  const used = new Set<string>();
  for (const element of article.querySelectorAll('[id]')) {
    const baseId = element.id;
    let id = baseId;
    let index = 1;
    while (used.has(id)) id = `${baseId}-${index++}`;
    element.id = id;
    used.add(id);
  }
  output.body.append(article);
  return `<!doctype html>\n${output.documentElement.outerHTML}`;
}
