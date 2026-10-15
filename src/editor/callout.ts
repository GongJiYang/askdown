/**
 * Callout 块：问题块、AI 回答块，以及 Obsidian 风格的其他 callout（note、tip……）。
 *
 * 在 Markdown 里它们是带标记的引用块，和 Obsidian / GitHub 兼容：
 *
 *     > [!question]
 *     > 机会成本怎么算？
 *
 *     > [!ai]
 *     > 回答……
 *
 * 在编辑器里它们是独立的结构化节点（callout），不再依赖用户手动维护的文本标记。
 */
import { $node, $remark } from '@milkdown/kit/utils';

export const QUESTION = 'question';
export const ANSWER = 'ai';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  kind?: string;
  title?: string;
  [k: string]: unknown;
}

const MARKER = /^\[!([A-Za-z][\w-]*)\][+-]?[ \t]*/;

/** 把 `> [!kind] 标题` 形式的引用块转换成 callout 节点。 */
function transformCallouts(node: MdNode) {
  if (!node.children) return;
  for (const child of node.children) transformCallouts(child);
  if (node.type !== 'blockquote') return;
  const first = node.children[0];
  if (!first || first.type !== 'paragraph' || !first.children?.length) return;
  const text = first.children[0];
  if (text.type !== 'text' || typeof text.value !== 'string') return;
  const m = MARKER.exec(text.value);
  if (!m) return;

  let rest = text.value.slice(m[0].length);
  let title = '';
  const nl = rest.indexOf('\n');
  if (nl >= 0) {
    title = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
  } else if (first.children.length === 1) {
    title = rest.trim();
    rest = '';
  }
  // 标题后面紧跟的软换行如果落在下一个文本节点里，也一起去掉
  if (rest) text.value = rest;
  else first.children.shift();
  if (first.children.length && first.children[0].type === 'break') first.children.shift();
  if (!first.children.length) node.children.shift();

  node.type = 'callout';
  node.kind = m[1].toLowerCase();
  node.title = title;
}

interface ToMdState {
  enter(name: string): () => void;
  createTracker(info: unknown): { move(s: string): void; shift(n: number): void; current(): unknown };
  containerFlow(node: unknown, info: unknown): string;
  indentLines(value: string, map: (line: string, index: number, blank: boolean) => string): string;
}

/** callout 节点写回 Markdown：在引用块第一行加上 `[!kind]`。 */
function calloutToMarkdown(node: MdNode, _parent: unknown, state: ToMdState, info: unknown): string {
  const exit = state.enter('blockquote');
  const tracker = state.createTracker(info);
  tracker.move('> ');
  tracker.shift(2);
  const inner = state.containerFlow(node, tracker.current());
  const head = `[!${node.kind || 'note'}]` + (node.title ? ' ' + node.title : '');
  const value = state.indentLines(inner ? head + '\n' + inner : head, (line, _i, blank) => '>' + (blank ? '' : ' ') + line);
  exit();
  return value;
}

export const remarkCallout = $remark('remarkCallout', () => {
  // unified 插件：注册序列化规则，并在解析后把引用块转换成 callout
  return function plugin(this: { data(): Record<string, unknown> }) {
    const data = this.data();
    const exts = (data.toMarkdownExtensions as unknown[] | undefined) ?? [];
    exts.push({ handlers: { callout: calloutToMarkdown } });
    data.toMarkdownExtensions = exts;
    return (tree: MdNode) => {
      transformCallouts(tree);
    };
  } as never;
});

const LABELS: Record<string, string> = {
  [QUESTION]: '问',
  [ANSWER]: 'AI 回答',
  note: '注',
  tip: '提示',
  warning: '注意',
  info: '信息',
  quote: '引',
};

export function calloutLabel(kind: string): string {
  return LABELS[kind] ?? kind.toUpperCase();
}

export const calloutSchema = $node('callout', () => ({
  content: 'block+',
  group: 'block',
  defining: true,
  attrs: {
    kind: { default: 'note' },
    title: { default: '' },
    // 下面几个只在编辑器里使用，不写进 Markdown
    id: { default: null },
    pending: { default: false },
    collapsed: { default: false },
  },
  parseDOM: [
    {
      tag: 'div[data-callout]',
      contentElement: '.callout-body',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return {};
        return { kind: dom.dataset.callout || 'note', title: dom.dataset.title || '' };
      },
    },
  ],
  toDOM: (node) => {
    const { kind, title, pending, collapsed } = node.attrs as { kind: string; title: string; pending: boolean; collapsed: boolean };
    const cls = ['callout', `callout-${kind}`];
    if (pending) cls.push('is-pending');
    if (collapsed) cls.push('is-collapsed');
    const actions: unknown[] = [];
    const btn = (action: string, label: string) => ['button', { type: 'button', class: 'callout-action', 'data-action': action, tabindex: '-1' }, label];
    if (kind === QUESTION) {
      actions.push(btn('ask', '提问'));
    } else if (kind === ANSWER) {
      if (pending) actions.push(btn('stop', '停止'));
      else {
        actions.push(btn('toggle', collapsed ? '展开' : '收起'));
        actions.push(btn('reask', '重问'));
        actions.push(btn('merge', '并入正文'));
        actions.push(btn('delete', '删除'));
      }
    }
    const labelText = kind === ANSWER && pending ? 'AI 回答 · 思考中' : calloutLabel(kind);
    return [
      'div',
      { 'data-callout': kind, 'data-title': title, class: cls.join(' ') },
      [
        'div',
        { class: 'callout-head', contenteditable: 'false' },
        ['span', { class: 'callout-label' }, labelText],
        ['span', { class: 'callout-title' }, title || ''],
        ['span', { class: 'callout-actions' }, ...actions],
      ],
      ['div', { class: 'callout-body' }, 0],
    ] as never;
  },
  parseMarkdown: {
    match: (node) => node.type === 'callout',
    runner: (state, node, type) => {
      state.openNode(type, { kind: (node.kind as string) || 'note', title: (node.title as string) || '' });
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'callout',
    runner: (state, node) => {
      state.openNode('callout', undefined, { kind: node.attrs.kind, title: node.attrs.title || '' });
      state.next(node.content);
      state.closeNode();
    },
  },
}));
