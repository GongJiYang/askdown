import { $node, $remark } from '@milkdown/kit/utils';

export const QUESTION = 'question';
export const ANSWER = 'ai';
export const newCalloutId = () => crypto.randomUUID();

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  [key: string]: unknown;
}

const MARKER = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*/;
const REF = /^\^([qa])-([A-Za-z0-9-]+)$/;
const RELATION = /^<!--\s*askdown:answer-to\s+(q-[A-Za-z0-9-]+|none)\s*-->$/;
const QUESTION_META = /^<!--\s*askdown:question\s+(\S+)\s*-->$/;
const ORIGIN_START = /^<!-- askdown:origin ([A-Za-z0-9-]+) -->$/;
const ORIGIN_END = /^<!-- askdown:origin-end ([A-Za-z0-9-]+) -->$/;

function htmlValue(node: MdNode | undefined): string {
  const html = node?.type === 'paragraph' && node.children?.length === 1 ? node.children[0] : node;
  return html?.type === 'html' ? html.value ?? '' : '';
}

/** Split the header from its body without flattening emphasis, links, or code. */
function splitHeader(nodes: MdNode[]): [MdNode[], MdNode[]] {
  const head: MdNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === 'break') return [head, nodes.slice(i + 1)];
    if (typeof node.value === 'string' && node.type === 'text') {
      const nl = node.value.indexOf('\n');
      if (nl >= 0) {
        if (nl) head.push({ ...node, value: node.value.slice(0, nl) });
        const tail = nodes.slice(i + 1);
        if (node.value.slice(nl + 1)) tail.unshift({ ...node, value: node.value.slice(nl + 1) });
        return [head, tail];
      }
    }
    head.push(node);
  }
  return [head, []];
}

function plainText(nodes: MdNode[]): string {
  return nodes.map((n) => n.value ?? plainText(n.children ?? [])).join('');
}

function transformCallouts(parent: MdNode) {
  if (!parent.children) return;
  for (const child of parent.children) transformCallouts(child);
  const children = parent.children;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type !== 'blockquote') continue;
    const first = node.children?.[0];
    const text = first?.children?.[0];
    if (first?.type !== 'paragraph' || text?.type !== 'text' || typeof text.value !== 'string') continue;
    const match = MARKER.exec(text.value);
    if (!match) continue;
    const [titleInline, body] = splitHeader([{ ...text, value: text.value.slice(match[0].length) }, ...first.children!.slice(1)]);
    node.type = 'callout';
    node.kind = match[1].toLowerCase();
    node.fold = match[2];
    node.titleInline = titleInline;
    node.title = plainText(titleInline).trim();
    if (body.length) first.children = body;
    else node.children!.shift();
    if (node.kind !== QUESTION && node.kind !== ANSWER) continue;
    const next = children[i + 1];
    const ref = next?.type === 'paragraph' && next.children?.length === 1 && next.children[0].type === 'text'
      ? REF.exec(next.children[0].value ?? '') : null;
    if (ref && ref[1] === (node.kind === QUESTION ? 'q' : 'a')) {
      node.id = ref[2];
      children.splice(i + 1, 1);
    }
    // Also accept IDs inside the quote, as produced by some Markdown editors.
    const last = node.children?.at(-1);
    const innerRef = last?.type === 'paragraph' && last.children?.length === 1 ? REF.exec(last.children[0].value ?? '') : null;
    if (!node.id && innerRef && innerRef[1] === (node.kind === QUESTION ? 'q' : 'a')) {
      node.id = innerRef[2];
      node.children!.pop();
    }
    if (node.kind === QUESTION) {
      const metadata = QUESTION_META.exec(htmlValue(node.children?.at(-1)));
      if (metadata) {
        try {
          const value = JSON.parse(decodeURIComponent(metadata[1]));
          if (value && typeof value === 'object') {
            node.context = typeof value.context === 'string' ? value.context : null;
            node.parentId = typeof value.parentId === 'string' ? value.parentId : null;
            node.images = Array.isArray(value.images) && value.images.every((image: unknown) => typeof image === 'string') ? value.images : [];
            node.children!.pop();
          }
        } catch { /* Keep malformed metadata as ordinary Markdown. */ }
      }
    }
    const metadata = node.children?.at(-1);
    // CommonMark wraps block HTML in a paragraph before this transform runs.
    const relationNode = metadata?.type === 'paragraph' && metadata.children?.length === 1
      ? metadata.children[0] : metadata;
    const relation = relationNode?.type === 'html' ? RELATION.exec(relationNode.value ?? '') : null;
    if (relation) {
      node.answerTo = relation[1] === 'none' ? null : relation[1].slice(2);
      node.children!.pop();
    }
    const legacy = !node.id && !relation;
    node.id ??= newCalloutId();
    // Adjacency is used only for legacy Markdown, never for an existing ID.
    if (legacy && node.kind === ANSWER) {
      const prev = children[i - 1];
      node.answerTo = prev?.type === 'callout' && prev.kind === QUESTION ? prev.id : null;
    }
  }
  for (let i = 0; i < children.length; i++) {
    const start = ORIGIN_START.exec(htmlValue(children[i]));
    if (!start) continue;
    let end = i + 1;
    while (end < children.length && ORIGIN_END.exec(htmlValue(children[end]))?.[1] !== start[1]) end++;
    if (end < children.length && end > i + 1) {
      children.splice(i, end - i + 1, { type: 'ai_origin', id: start[1], children: children.slice(i + 1, end) });
    }
  }
}

interface ToMdState {
  enter(name: string): () => void;
  createTracker(info: unknown): { move(s: string): void; shift(n: number): void; current(): unknown };
  containerFlow(node: unknown, info: unknown): string;
  containerPhrasing(node: unknown, info: unknown): string;
  indentLines(value: string, map: (line: string, index: number, blank: boolean) => string): string;
}

function calloutToMarkdown(node: MdNode, _parent: unknown, state: ToMdState, info: unknown): string {
  const exit = state.enter('blockquote');
  const tracker = state.createTracker(info);
  tracker.move('> ');
  tracker.shift(2);
  const inner = state.containerFlow(node, tracker.current());
  const title = (node.titleInline as MdNode[] | undefined)?.length
    ? state.containerPhrasing({ type: 'paragraph', children: node.titleInline }, { ...tracker.current() as object, before: ' ', after: '\n' })
    : node.title || '';
  const head = `[!${node.kind || 'note'}]${node.fold || ''}` + (title ? ' ' + title : '');
  let body = inner ? head + '\n' + inner : head;
  if (node.kind === ANSWER) body += `\n\n<!-- askdown:answer-to ${node.answerTo ? `q-${node.answerTo}` : 'none'} -->`;
  if (node.kind === QUESTION && (node.context !== null && node.context !== undefined || node.parentId || (node.images as string[] | undefined)?.length)) {
    const metadata = encodeURIComponent(JSON.stringify({ context: node.context ?? null, parentId: node.parentId ?? null, ...((node.images as string[] | undefined)?.length ? { images: node.images } : {}) })).replace(/-/g, '%2D');
    body += `\n\n<!-- askdown:question ${metadata} -->`;
  }
  let value = state.indentLines(body, (line, _i, blank) => '>' + (blank ? '' : ' ') + line);
  exit();
  if ((node.kind === QUESTION || node.kind === ANSWER) && node.id) value += `\n\n^${node.kind === QUESTION ? 'q' : 'a'}-${node.id}`;
  return value;
}

export const remarkCallout = $remark('remarkCallout', () => {
  return function plugin(this: { data(): Record<string, unknown> }) {
    const data = this.data();
    const exts = (data.toMarkdownExtensions as unknown[] | undefined) ?? [];
    exts.push({ handlers: {
      callout: calloutToMarkdown,
      ai_origin: (node: MdNode, _parent: unknown, state: ToMdState, info: unknown) =>
        `<!-- askdown:origin ${node.id} -->\n\n${state.containerFlow(node, info)}\n\n<!-- askdown:origin-end ${node.id} -->`,
    } });
    data.toMarkdownExtensions = exts;
    return transformCallouts;
  } as never;
});

const LABELS: Record<string, string> = { [QUESTION]: '问', [ANSWER]: 'AI 回答', note: '注', tip: '提示', warning: '注意', info: '信息', quote: '引' };
export const calloutLabel = (kind: string) => LABELS[kind] ?? kind.toUpperCase();

export const calloutSchema = $node('callout', () => ({
  content: 'block+',
  group: 'block',
  defining: true,
  attrs: {
    kind: { default: 'note' }, title: { default: '' }, titleInline: { default: null }, fold: { default: '' },
    id: { default: null }, answerTo: { default: null }, context: { default: null }, parentId: { default: null },
    images: { default: [] },
  },
  parseDOM: [{
    tag: 'div[data-callout]', contentElement: '.callout-body',
    getAttrs: (dom: HTMLElement | string) => {
      if (typeof dom === 'string') return {};
      let titleInline = null;
      let images: unknown = [];
      try { images = JSON.parse(dom.dataset.images || '[]'); } catch { /* External HTML may omit attachments. */ }
      try { titleInline = JSON.parse(dom.dataset.titleInline || 'null'); } catch { /* External HTML may omit structured titles. */ }
      const kind = dom.dataset.callout || 'note';
      return { kind, title: dom.dataset.title || '', titleInline: Array.isArray(titleInline) ? titleInline : null, fold: dom.dataset.fold || '', id: dom.dataset.id || (kind === QUESTION || kind === ANSWER ? newCalloutId() : null), answerTo: dom.dataset.answerTo || null, context: dom.hasAttribute('data-context') ? dom.dataset.context : null, parentId: dom.dataset.parentId || null, images: Array.isArray(images) && images.every((image) => typeof image === 'string') ? images : [] };
    },
  }],
  toDOM: (node) => {
    const { kind, title, id, answerTo, titleInline, fold, context, parentId, images } = node.attrs;
    const collapsed = fold === '-';
    const bodyId = `callout-body-${id ?? kind}`;
    const btn = (action: string, label: string) => ['button', {
      type: 'button', class: 'callout-action', 'data-action': action, 'aria-label': label,
      ...(action === 'toggle' ? { 'aria-expanded': String(!collapsed), 'aria-controls': bodyId } : {}),
    }, label];
    const actions = kind === QUESTION ? [btn('ask', '提问')] : kind === ANSWER
      ? [btn('toggle', collapsed ? '展开' : '收起'), btn('followup', '追问'), btn('reask', '重问'), btn('shorter', '更短'), btn('detailed', '更详细'), btn('alternative', '换个角度'), btn('merge', '并入正文'), btn('delete', '删除')] : [];
    return ['div', {
      'data-callout': kind, 'data-title': title, 'data-title-inline': JSON.stringify(titleInline), 'data-fold': fold,
      'data-id': id, 'data-answer-to': answerTo, 'data-context': context, 'data-parent-id': parentId, 'data-images': JSON.stringify(images),
      id: id ? `${kind === QUESTION ? 'q' : 'a'}-${id}` : null,
      class: `callout callout-${kind}${collapsed ? ' is-collapsed' : ''}`,
    }, ['div', { class: 'callout-head', contenteditable: 'false' }, ['span', { class: 'callout-label' }, calloutLabel(kind)],
      ['span', { class: 'callout-title' }, title || ''], ['span', { class: 'callout-actions' }, ...actions]],
    ['div', { class: 'callout-body', id: bodyId, ...(collapsed ? { hidden: 'hidden' } : {}) }, 0]] as never;
  },
  parseMarkdown: {
    match: (node) => node.type === 'callout',
    runner: (state, node, type) => {
      state.openNode(type, { kind: node.kind || 'note', title: node.title || '', titleInline: node.titleInline || null, fold: node.fold || '', id: node.id || null, answerTo: node.answerTo || null, context: node.context ?? null, parentId: node.parentId || null, images: node.images || [] });
      if (node.children?.length) state.next(node.children);
      else state.addNode(state.schema.nodes.paragraph);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'callout',
    runner: (state, node) => {
      state.openNode('callout', undefined, { ...node.attrs });
      state.next(node.content);
      state.closeNode();
    },
  },
}));

/** Ordinary Markdown blocks bounded by comments, never rendered as opaque HTML. */
export const aiOriginSchema = $node('ai_origin', () => ({
  content: 'block+',
  group: 'block',
  defining: true,
  attrs: { id: { default: null } },
  parseDOM: [{
    tag: 'div[data-ai-origin]',
    getAttrs: (dom: HTMLElement | string) => typeof dom === 'string' ? {} : { id: dom.dataset.aiOrigin || newCalloutId() },
  }],
  toDOM: (node) => ['div', { class: 'ai-origin', 'data-ai-origin': node.attrs.id, 'aria-label': 'AI 生成的正文' }, 0],
  parseMarkdown: {
    match: (node) => node.type === 'ai_origin',
    runner: (state, node, type) => {
      state.openNode(type, { id: node.id });
      state.next(node.children!);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'ai_origin',
    runner: (state, node) => {
      state.openNode('ai_origin', undefined, { id: node.attrs.id });
      state.next(node.content);
      state.closeNode();
    },
  },
}));
