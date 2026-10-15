/**
 * 问答控制：把问题块变成提问、把回答流式写进回答块，以及回答块上的各个按钮。
 * 这里只操作编辑器；真正调用模型的函数由外部通过 QaHooks 传进来。
 */
import type { Ctx } from '@milkdown/kit/ctx';
import { parserCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core';
import { Fragment, Slice, type Node as PMNode } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { ANSWER, QUESTION } from './callout';

export const QUESTION_MARK = '【用户在这里提问】';
const Q_PREFIX = /^\s*(\?\?|？？)\s*/;

export interface AskRequest {
  question: string;
  /** 问题前面最近的一段正文（Markdown） */
  anchor: string;
  /** 整篇文档（Markdown），问题处替换成 QUESTION_MARK */
  document: string;
}

export interface QaHooks {
  ask(req: AskRequest, onText: (text: string) => void, signal: AbortSignal): Promise<string>;
  notify(message: string): void;
}

export interface QaPair {
  question: string;
  anchor: string;
  answer: string;
}

let seq = 0;
const newId = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`;

function isCallout(node: PMNode | null | undefined, kind?: string): node is PMNode {
  return !!node && node.type.name === 'callout' && (!kind || node.attrs.kind === kind);
}

export function createQa(ctx: Ctx, hooks: QaHooks | null) {
  const controllers = new Map<string, AbortController>();

  const schema = () => ctx.get(schemaCtx);
  const serialize = (nodes: PMNode[] | Fragment) => {
    const s = schema();
    const content = nodes instanceof Fragment ? nodes : Fragment.fromArray(nodes);
    if (!content.size) return '';
    return ctx.get(serializerCtx)(s.topNodeType.create(null, content)).trim();
  };
  const parse = (md: string): Fragment => {
    const doc = ctx.get(parserCtx)(md || '');
    if (doc && doc.content.size) return doc.content;
    return Fragment.from(schema().nodes.paragraph.create());
  };

  function findById(doc: PMNode, id: string): { node: PMNode; pos: number } | null {
    let found: { node: PMNode; pos: number } | null = null;
    doc.descendants((node, pos) => {
      if (found) return false;
      if (isCallout(node) && node.attrs.id === id) {
        found = { node, pos };
        return false;
      }
      return true;
    });
    return found;
  }

  /** 问题块所在位置之前、同一层级里最近的一段非 callout 正文 */
  function anchorBefore(doc: PMNode, pos: number): string {
    const $pos = doc.resolve(pos);
    const parent = $pos.parent;
    for (let i = $pos.index() - 1; i >= 0; i--) {
      const child = parent.child(i);
      if (child.type.name !== 'callout' && child.textContent.trim()) return serialize([child]);
    }
    return '';
  }

  function buildRequest(doc: PMNode, qPos: number, question: string): AskRequest {
    const q = doc.nodeAt(qPos)!;
    const s = schema();
    const marker = s.nodes.paragraph.create(null, s.text(`${QUESTION_MARK}${question}`));
    const marked = doc.replace(qPos, qPos + q.nodeSize, new Slice(Fragment.from(marker), 0, 0));
    return {
      question,
      anchor: anchorBefore(doc, qPos),
      document: serialize(marked.content),
    };
  }

  function setAnswer(view: EditorView, id: string, markdown: string, pending: boolean, addToHistory: boolean): boolean {
    const found = findById(view.state.doc, id);
    if (!found) return false;
    const { node, pos } = found;
    const tr = view.state.tr.replaceWith(pos + 1, pos + node.nodeSize - 1, parse(markdown));
    if (node.attrs.pending !== pending) tr.setNodeMarkup(pos, undefined, { ...node.attrs, pending });
    tr.setMeta('addToHistory', addToHistory);
    view.dispatch(tr);
    return true;
  }

  async function ask(view: EditorView, qPos: number) {
    if (!hooks) return;
    const state = view.state;
    const q = state.doc.nodeAt(qPos);
    if (!isCallout(q, QUESTION)) return;
    const question = q.textContent.trim();
    if (!question) {
      hooks.notify('先写下问题');
      return;
    }
    const req = buildRequest(state.doc, qPos, question);
    const s = schema();
    const id = newId();
    const answer = s.nodes.callout.create({ kind: ANSWER, id, pending: true }, s.nodes.paragraph.create());

    const after = qPos + q.nodeSize;
    const next = state.doc.resolve(after).nodeAfter;
    let tr = state.tr;
    if (isCallout(next, ANSWER)) {
      if (next.attrs.pending) return; // 已经在回答了
      tr = tr.replaceWith(after, after + next.nodeSize, answer);
    } else {
      tr = tr.insert(after, answer);
    }
    // 回答块后面留一个空段落，方便接着往下写
    const end = after + answer.nodeSize;
    if (!tr.doc.resolve(end).nodeAfter) tr = tr.insert(end, s.nodes.paragraph.create());
    const selPos = tr.doc.resolve(end).nodeAfter ? end + 1 : end;
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(selPos, tr.doc.content.size))));
    view.dispatch(tr.scrollIntoView());

    const ctl = new AbortController();
    controllers.set(id, ctl);
    let latest = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!setAnswer(view, id, latest, true, false)) ctl.abort(); // 回答块被用户删掉了
    };
    try {
      const text = await hooks.ask(
        req,
        (t) => {
          latest = t;
          if (!timer) timer = setTimeout(flush, 80);
        },
        ctl.signal,
      );
      if (timer) clearTimeout(timer);
      setAnswer(view, id, text, false, true);
    } catch (err) {
      if (timer) clearTimeout(timer);
      const e = err as Error;
      const msg = e?.name === 'AbortError' ? '已停止' : e?.message || '出了点问题';
      const body = latest.trim() ? `${latest}\n\n*（${msg}）*` : `*${msg}*`;
      setAnswer(view, id, body, false, true);
    } finally {
      controllers.delete(id);
    }
  }

  /** 把以 ?? 开头的段落变成问题块，返回问题块的位置 */
  function convertParagraph(view: EditorView, paraPos: number): number | null {
    const para = view.state.doc.nodeAt(paraPos);
    if (!para || para.type.name !== 'paragraph') return null;
    const m = Q_PREFIX.exec(para.textContent);
    if (!m) return null;
    const s = schema();
    const inner = s.nodes.paragraph.create(null, para.content.cut(m[0].length));
    const callout = s.nodes.callout.create({ kind: QUESTION }, inner);
    const tr = view.state.tr.replaceWith(paraPos, paraPos + para.nodeSize, callout);
    view.dispatch(tr);
    return paraPos;
  }

  /** 光标所在的问题块（任意层级），没有则返回 null */
  function questionAtCursor(view: EditorView): number | null {
    const { $from } = view.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (isCallout(node, QUESTION)) return $from.before(d);
      if (isCallout(node)) return null;
    }
    return null;
  }

  function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    if (!hooks || event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return false;
    const mod = event.metaKey || event.ctrlKey;
    const { selection } = view.state;
    const { $from, empty } = selection;

    if (mod) {
      event.preventDefault();
      const qPos = questionAtCursor(view);
      if (qPos !== null) {
        void ask(view, qPos);
        return true;
      }
      if ($from.parent.type.name === 'paragraph' && Q_PREFIX.test($from.parent.textContent)) {
        const pos = convertParagraph(view, $from.before());
        if (pos !== null) void ask(view, pos);
        return true;
      }
      // 普通段落：在当前顶层块后面插入一个空的问题块
      const s = schema();
      const topEnd = $from.depth >= 1 ? $from.after(1) : view.state.doc.content.size;
      const callout = s.nodes.callout.create({ kind: QUESTION }, s.nodes.paragraph.create());
      let tr = view.state.tr.insert(topEnd, callout);
      tr = tr.setSelection(TextSelection.create(tr.doc, topEnd + 2));
      view.dispatch(tr.scrollIntoView());
      return true;
    }

    if (event.shiftKey || event.altKey || !empty) return false;
    const atEnd = $from.parentOffset === $from.parent.content.size;
    if (!atEnd || $from.parent.type.name !== 'paragraph') return false;

    // 问题块里，光标在最后一段末尾按 Enter：提问
    const qPos = questionAtCursor(view);
    if (qPos !== null) {
      const q = view.state.doc.nodeAt(qPos)!;
      const lastPara = $from.index($from.depth - 1) === $from.node($from.depth - 1).childCount - 1;
      if (lastPara && $from.node($from.depth - 1) === q && q.textContent.trim()) {
        event.preventDefault();
        void ask(view, qPos);
        return true;
      }
      return false;
    }
    // 以 ?? 开头的普通段落（不在列表、引用里），在末尾按 Enter：变成问题块并提问
    if ($from.depth === 1 && Q_PREFIX.test($from.parent.textContent) && $from.parent.textContent.replace(Q_PREFIX, '').trim()) {
      event.preventDefault();
      const pos = convertParagraph(view, $from.before());
      if (pos !== null) void ask(view, pos);
      return true;
    }
    return false;
  }

  function calloutPosFromDom(view: EditorView, el: Element): number | null {
    let found: number | null = null;
    view.state.doc.descendants((node, pos) => {
      if (found !== null) return false;
      if (isCallout(node) && view.nodeDOM(pos) === el) {
        found = pos;
        return false;
      }
      return true;
    });
    return found;
  }

  function handleMouseDown(view: EditorView, event: MouseEvent): boolean {
    const target = event.target as HTMLElement | null;
    const btn = target?.closest?.('.callout-action') as HTMLElement | null;
    if (!btn) return false;
    const el = btn.closest('.callout');
    if (!el) return false;
    event.preventDefault();
    const pos = calloutPosFromDom(view, el);
    if (pos === null) return true;
    const node = view.state.doc.nodeAt(pos)!;
    const action = btn.dataset.action;
    const { tr } = view.state;
    switch (action) {
      case 'ask':
        void ask(view, pos);
        break;
      case 'stop':
        if (node.attrs.id) controllers.get(node.attrs.id)?.abort();
        break;
      case 'toggle':
        view.dispatch(tr.setNodeMarkup(pos, undefined, { ...node.attrs, collapsed: !node.attrs.collapsed }).setMeta('addToHistory', false));
        break;
      case 'reask': {
        const $pos = view.state.doc.resolve(pos);
        const idx = $pos.index();
        const prev = idx > 0 ? $pos.parent.child(idx - 1) : null;
        if (isCallout(prev, QUESTION)) void ask(view, pos - prev.nodeSize);
        else hooks?.notify('这个回答前面没有问题块，无法重问');
        break;
      }
      case 'merge':
        view.dispatch(tr.replaceWith(pos, pos + node.nodeSize, node.content));
        break;
      case 'delete':
        if (node.attrs.id) controllers.get(node.attrs.id)?.abort();
        view.dispatch(tr.delete(pos, pos + node.nodeSize));
        break;
    }
    return true;
  }

  /** 收集文档里所有「问题 → 回答」对，给整理功能用 */
  function collectPairs(doc: PMNode): QaPair[] {
    const pairs: QaPair[] = [];
    doc.descendants((node, pos) => {
      if (!isCallout(node, ANSWER)) return true;
      if (node.attrs.pending) return false;
      const answer = serialize(node.content);
      if (!answer) return false;
      const $pos = doc.resolve(pos);
      const idx = $pos.index();
      const prev = idx > 0 ? $pos.parent.child(idx - 1) : null;
      const question = isCallout(prev, QUESTION) ? prev.textContent.trim() : '（没有对应的问题）';
      pairs.push({ question, anchor: anchorBefore(doc, prev ? pos - prev.nodeSize : pos), answer });
      return false;
    });
    return pairs;
  }

  function destroy() {
    for (const c of controllers.values()) c.abort();
    controllers.clear();
  }

  return { ask, handleKeyDown, handleMouseDown, collectPairs, parse, destroy };
}
