import type { Ctx } from '@milkdown/kit/ctx';
import { parserCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core';
import { Fragment, Slice, type Node as PMNode } from '@milkdown/kit/prose/model';
import { closeHistory } from '@milkdown/kit/prose/history';
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { ANSWER, QUESTION, newCalloutId } from './callout';
import { normalizeImageSource, stripImageData } from '../ai/images';

export const QUESTION_MARK = '【用户在这里提问】';
const Q_PREFIX = /^\s*(\?\?|？？)\s*/;
const previewKey = new PluginKey('askdown-generation');

export interface AskRequest {
  question: string;
  anchor: string;
  document: string;
  /** Stable body, excluding transient question/answer blocks. */
  sourceDocument?: string;
  webSearch?: boolean;
  images?: string[];
  template?: string;
  style?: 'shorter' | 'detailed' | 'alternative';
  history?: { question: string; answer: string }[];
  previousAnswer?: string;
}
export interface QaHooks {
  ask(req: AskRequest, onText: (text: string) => void, signal: AbortSignal): Promise<string>;
  notify(message: string): void;
}
export interface QaPair { id: string; answerId: string; question: string; anchor: string; answer: string }
export interface SelectionContext { text: string; images: string[] }
export interface QuestionOptions { template?: string; label?: string; images?: string[] }
export interface QaEditorOptions {
  readonly?: () => boolean;
  onAskSelection?: (selection: SelectionContext, template?: string, label?: string) => void;
}

interface Located { node: PMNode; pos: number }
interface Generation {
  id: string;
  controller: AbortController;
  view: EditorView;
  question: Located;
  answer: Located | null;
  convert: boolean;
  preview: string;
  element: HTMLElement;
  text: Text;
  frame: number | null;
}

function isCallout(node: PMNode | null | undefined, kind?: string): node is PMNode & { type: PMNode['type'] & { name: 'callout' } } {
  return !!node && node.type.name === 'callout' && (!kind || node.attrs.kind === kind);
}

function withId(doc: PMNode, id: string, kind: string): Located[] {
  const found: Located[] = [];
  doc.descendants((node, pos) => {
    if (isCallout(node, kind) && node.attrs.id === id) found.push({ node, pos });
  });
  return found;
}

function answersFor(doc: PMNode, questionId: string): Located[] {
  const found: Located[] = [];
  doc.descendants((node, pos) => {
    if (isCallout(node, ANSWER) && node.attrs.answerTo === questionId) found.push({ node, pos });
  });
  return found;
}

export function createQa(ctx: Ctx, hooks: QaHooks | null, onGenerationChange?: (busy: boolean) => void, options: QaEditorOptions = {}) {
  const generations = new Map<string, Generation>();
  let destroyed = false;
  const schema = () => ctx.get(schemaCtx);
  const serialize = (nodes: PMNode[] | Fragment) => {
    const content = nodes instanceof Fragment ? nodes : Fragment.fromArray(nodes);
    return content.size ? ctx.get(serializerCtx)(schema().topNodeType.create(null, content)).trim() : '';
  };
  const parse = (md: string): Fragment => {
    const doc = ctx.get(parserCtx)(md || '');
    return doc?.content.size ? doc.content : Fragment.from(schema().nodes.paragraph.create());
  };

  // Model context is Markdown content, without document identity/provenance metadata.
  function modelContent(content: Fragment, omitQa = false, omitNode?: PMNode): Fragment {
    const nodes: PMNode[] = [];
    content.forEach((node) => {
      if (node === omitNode || omitQa && (isCallout(node, QUESTION) || isCallout(node, ANSWER))) return;
      if (isCallout(node, QUESTION) || isCallout(node, ANSWER) || node.type.name === 'ai_origin') {
        modelContent(node.content, omitQa, omitNode).forEach((child) => nodes.push(child));
      } else nodes.push(node.isLeaf ? node : node.copy(modelContent(node.content, omitQa, omitNode)));
    });
    return Fragment.fromArray(nodes);
  }
  const modelMarkdown = (content: Fragment) => stripImageData(serialize(modelContent(content)));

  function ancestry(doc: PMNode, question: PMNode, images?: Set<string>): AskRequest['history'] | null {
    const history: NonNullable<AskRequest['history']> = [];
    const seen = new Set<string>([question.attrs.id]);
    for (const image of question.attrs.images ?? []) images?.add(image);
    let parentId = question.attrs.parentId;
    while (parentId) {
      if (seen.has(parentId)) { ambiguous(); return null; }
      seen.add(parentId);
      const parents = withId(doc, parentId, QUESTION);
      const answers = answersFor(doc, parentId);
      if (parents.length !== 1 || answers.length !== 1 || !answers[0].node.attrs.id || withId(doc, answers[0].node.attrs.id, ANSWER).length !== 1) {
        ambiguous();
        return null;
      }
      history.unshift({ question: parents[0].node.textContent.trim(), answer: modelMarkdown(answers[0].node.content) });
      for (const image of parents[0].node.attrs.images ?? []) images?.add(image);
      parentId = parents[0].node.attrs.parentId;
    }
    return history;
  }

  function refresh(view: EditorView) {
    if (destroyed || view.isDestroyed || !view.dom.isConnected) return;
    const focused = view.dom.contains(document.activeElement) ? (document.activeElement as HTMLElement | null)?.dataset.stopGeneration : null;
    view.dispatch(view.state.tr.setMeta(previewKey, true).setMeta('addToHistory', false));
    if (focused) view.dom.querySelector<HTMLButtonElement>(`[data-stop-generation="${focused}"]`)?.focus();
  }

  function createPreview(id: string): { element: HTMLElement; text: Text } {
    const element = document.createElement('div');
    element.className = 'callout callout-ai is-pending';
    element.contentEditable = 'false';
    element.dataset.generation = id;
    const head = document.createElement('div');
    head.className = 'callout-head';
    const label = document.createElement('span');
    label.textContent = 'AI 回答 · 生成预览';
    label.setAttribute('role', 'status');
    const stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.textContent = '停止';
    stopButton.className = 'callout-action';
    stopButton.dataset.stopGeneration = id;
    stopButton.setAttribute('aria-label', '停止生成回答');
    head.append(label, stopButton);
    const body = document.createElement('div');
    body.className = 'callout-body';
    body.style.whiteSpace = 'pre-wrap';
    body.setAttribute('aria-live', 'polite');
    const text = document.createTextNode('思考中…');
    body.append(text);
    element.append(head, body);
    return { element, text };
  }

  function cancelPreviewFrame(generation: Generation) {
    if (generation.frame !== null) cancelAnimationFrame(generation.frame);
    generation.frame = null;
  }

  function stop(id: string) {
    const generation = generations.get(id);
    if (!generation) return;
    const view = generation.view;
    const restoreFocus = !destroyed && !view.isDestroyed && view.dom.isConnected
      && (document.activeElement as HTMLElement | null)?.dataset.stopGeneration === id;
    generations.delete(id);
    cancelPreviewFrame(generation);
    generation.controller.abort();
    refresh(generation.view);
    if (restoreFocus) {
      if (generation.answer) focusControl(view, generation.answer.node.attrs.id, 'reask');
      else if (!generation.convert) focusQuestion(view, generation.question.node.attrs.id);
      else view.focus();
    }
    if (!generations.size) onGenerationChange?.(false);
  }

  function cancelGeneration() {
    for (const id of [...generations.keys()]) stop(id);
  }

  function anchorBefore(doc: PMNode, pos: number): string {
    const $pos = doc.resolve(pos);
    for (let i = $pos.index() - 1; i >= 0; i--) {
      const child = $pos.parent.child(i);
      if (child.type.name !== 'callout' && child.textContent.trim()) return modelMarkdown(Fragment.from(child));
    }
    return '';
  }

  function buildRequest(doc: PMNode, qPos: number, question: string): AskRequest | null {
    const q = doc.nodeAt(qPos)!;
    const images = new Set<string>();
    q.descendants((node) => { if (node.type.name === 'image' && node.attrs.src) images.add(node.attrs.src); });
    const history = ancestry(doc, q, images);
    if (!history) return null;
    const marker = schema().nodes.paragraph.create(null, schema().text(`${QUESTION_MARK}${question}`));
    const marked = doc.replace(qPos, qPos + q.nodeSize, new Slice(Fragment.from(marker), 0, 0));
    return { question, anchor: stripImageData(q.attrs.context ?? anchorBefore(doc, qPos)), document: modelMarkdown(marked.content), sourceDocument: stripImageData(serialize(modelContent(doc.content, true, q))), ...(history.length ? { history } : {}), ...(images.size ? { images: [...images] } : {}) };
  }

  function ambiguous() {
    hooks?.notify('问答标识重复或关联不明确，已停止操作。请删除重复块或为复制的问题重新建立问答。');
  }

  /** Track protected nodes through edits elsewhere; never infer a relationship from position. */
  function locate(g: Generation, tr: Transaction): { question: Located; answer: Located | null } | null {
    const questions = g.convert
      ? [{ node: tr.doc.nodeAt(tr.mapping.map(g.question.pos, 1)), pos: tr.mapping.map(g.question.pos, 1) }]
      : withId(tr.doc, g.question.node.attrs.id, QUESTION);
    if (questions.length !== 1 || !questions[0].node?.eq(g.question.node)) return null;
    const question = questions[0] as Located;
    const answers = g.convert ? [] : answersFor(tr.doc, question.node.attrs.id);
    if (!g.answer) return answers.length ? null : { question, answer: null };
    if (answers.length !== 1 || !answers[0].node.eq(g.answer.node) || withId(tr.doc, g.answer.node.attrs.id, ANSWER).length !== 1) return null;
    return { question, answer: answers[0] };
  }

  const plugin = new Plugin({
    key: previewKey,
    state: {
      init: () => null,
      apply(tr) {
        if (tr.docChanged) {
          for (const generation of generations.values()) {
            const found = locate(generation, tr);
            if (found) Object.assign(generation, found);
          }
        }
        return null;
      },
    },
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta('askdown-replace'))) return null;
      const wrappers: number[] = [];
      oldState.doc.descendants((node, pos) => {
        if (node.type.name !== 'ai_origin') return;
        let mapped = pos;
        for (const transaction of transactions) {
          const result = transaction.mapping.mapResult(mapped, 1);
          if (result.deletedAcross) return;
          mapped = result.pos;
        }
        const current = newState.doc.nodeAt(mapped);
        if (current?.type.name === 'ai_origin' && current.attrs.id === node.attrs.id && !current.content.eq(node.content)) wrappers.push(mapped);
      });
      if (!wrappers.length) return null;
      const tr = newState.tr;
      for (const pos of wrappers.reverse()) {
        const from = tr.mapping.map(pos);
        const current = tr.doc.nodeAt(from);
        if (current?.type.name === 'ai_origin') tr.replaceWith(from, from + current.nodeSize, current.content);
      }
      return tr.docChanged ? tr : null;
    },
    filterTransaction(tr) {
      if (!tr.docChanged) return true;
      if (options.readonly?.() && !tr.getMeta('askdown-replace')) return false;
      for (const generation of generations.values()) {
        if (!locate(generation, tr)) {
          hooks?.notify('正在生成的问答已锁定，请先停止生成再修改；其他正文仍可编辑。');
          return false;
        }
      }
      return true;
    },
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'image') decorations.push(Decoration.node(pos, pos + node.nodeSize, {
            tabindex: '0',
            role: 'button',
            title: '选择图片后按 ⌘/Ctrl+Enter 提问',
            'aria-label': `${node.attrs.alt || '图片'}；选择后按 Command 或 Control 加 Enter 提问`,
          }));
        });
        for (const g of generations.values()) {
          for (const found of [g.question, g.answer]) {
            if (found) decorations.push(Decoration.node(found.pos, found.pos + found.node.nodeSize, { contenteditable: 'false', 'data-generating': 'true' }));
          }
          const target = g.answer ?? g.question;
          decorations.push(Decoration.widget(target.pos + target.node.nodeSize, g.element, { key: g.id, side: -1, ignoreSelection: true }));
        }
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });

  async function ask(view: EditorView, qPos: number, convert = false, requestOptions: Pick<AskRequest, 'template' | 'style' | 'previousAnswer'> = {}) {
    if (!hooks || options.readonly?.() || !view.editable || destroyed || view.isDestroyed) return;
    const q = view.state.doc.nodeAt(qPos);
    if (!q || (convert ? q.type.name !== 'paragraph' : !isCallout(q, QUESTION))) return;
    if ([...generations.values()].some((g) => g.question.pos === qPos)) return;
    const question = (convert ? q.textContent.replace(Q_PREFIX, '') : q.textContent).trim();
    if (!question) { hooks.notify('先写下问题'); return; }
    const existing = convert ? [] : answersFor(view.state.doc, q.attrs.id);
    if (!convert && (!q.attrs.id || withId(view.state.doc, q.attrs.id, QUESTION).length !== 1 || existing.length > 1 || (existing[0] && withId(view.state.doc, existing[0].node.attrs.id, ANSWER).length !== 1))) {
      ambiguous();
      return;
    }
    const targets = [{ node: q, pos: qPos }, ...existing];
    for (const active of generations.values()) {
      if (targets.some((target) => [active.question, active.answer].some((locked) => locked && target.pos < locked.pos + locked.node.nodeSize && locked.pos < target.pos + target.node.nodeSize))) {
        hooks.notify('这部分内容正在生成，请先停止当前生成。');
        return;
      }
    }
    const req = buildRequest(view.state.doc, qPos, question);
    if (!req) return;
    Object.assign(req, requestOptions);
    const id = newCalloutId();
    const generation: Generation = { id, controller: new AbortController(), view, question: { node: q, pos: qPos }, answer: existing[0] ?? null, convert, preview: '', frame: null, ...createPreview(id) };
    const wasIdle = !generations.size;
    generations.set(generation.id, generation);
    // Start and finish form boundaries so typing before/during/after the request stays separate.
    view.dispatch(closeHistory(view.state.tr).setMeta('addToHistory', false));
    if (wasIdle) onGenerationChange?.(true);
    const live = () => !destroyed && !view.isDestroyed && view.dom.isConnected && generations.get(generation.id) === generation && !generation.controller.signal.aborted;
    try {
      const text = await hooks.ask(req, (preview) => {
        if (!live()) { stop(generation.id); return; }
        generation.preview = preview;
        if (generation.frame === null) generation.frame = requestAnimationFrame(() => {
          generation.frame = null;
          if (!live()) { stop(generation.id); return; }
          const next = generation.preview || '思考中…';
          const previous = generation.text.data;
          if (next === previous) return;
          if (next.startsWith(previous)) generation.text.appendData(next.slice(previous.length));
          else generation.text.replaceData(0, previous.length, next);
        });
      }, generation.controller.signal);
      if (!live()) { stop(generation.id); return; }
      if (options.readonly?.()) { stop(generation.id); return; }
      const found = locate(generation, view.state.tr);
      if (!found) { stop(generation.id); ambiguous(); return; }
      const answerContent = parse(text);
      const focused = view.dom.contains(document.activeElement) && (document.activeElement as HTMLElement | null)?.closest('button');
      const focusedAction = focused && (focused.closest<HTMLElement>('.callout')?.dataset.id === found.answer?.node.attrs.id || focused.hasAttribute('data-stop-generation'))
        ? (focused as HTMLElement).dataset.action ?? 'reask' : null;
      const questionId = convert ? newCalloutId() : found.question.node.attrs.id;
      const answer = schema().nodes.callout.create({ ...(found.answer?.node.attrs ?? {}), kind: ANSWER, id: found.answer?.node.attrs.id ?? newCalloutId(), answerTo: questionId }, answerContent);
      let tr = closeHistory(view.state.tr);
      if (convert) {
        const prefix = Q_PREFIX.exec(found.question.node.textContent)!;
        const paragraph = schema().nodes.paragraph.create(found.question.node.attrs, found.question.node.content.cut(prefix[0].length));
        const questionNode = schema().nodes.callout.create({ kind: QUESTION, id: questionId }, paragraph);
        tr = tr.replaceWith(found.question.pos, found.question.pos + found.question.node.nodeSize, Fragment.fromArray([questionNode, answer]));
      } else if (found.answer) {
        tr = tr.replaceWith(found.answer.pos, found.answer.pos + found.answer.node.nodeSize, answer);
      } else {
        tr = tr.insert(found.question.pos + found.question.node.nodeSize, answer);
      }
      const committed = withId(tr.doc, answer.attrs.id, ANSWER)[0];
      const afterAnswer = committed.pos + committed.node.nodeSize;
      if (!tr.doc.resolve(afterAnswer).nodeAfter) tr = tr.insert(afterAnswer, schema().nodes.paragraph.create());
      generations.delete(generation.id);
      cancelPreviewFrame(generation);
      view.dispatch(tr);
      view.dispatch(closeHistory(view.state.tr).setMeta('addToHistory', false));
      if (focusedAction) focusControl(view, answer.attrs.id, focusedAction);
      if (!generations.size) onGenerationChange?.(false);
    } catch (error) {
      if (live()) {
        stop(generation.id);
        if ((error as Error)?.name !== 'AbortError') hooks.notify((error as Error)?.message || '生成失败，原有内容已保留');
      } else stop(generation.id);
    }
  }

  function questionAtCursor(view: EditorView): number | null {
    const { $from } = view.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (isCallout(node, QUESTION)) return $from.before(d);
      if (isCallout(node)) return null;
    }
    return null;
  }

  function commit(view: EditorView, tr: Transaction) {
    view.dispatch(closeHistory(tr));
    view.dispatch(closeHistory(view.state.tr).setMeta('addToHistory', false));
  }

  function focusControl(view: EditorView, id: string, action: string) {
    const found = withId(view.state.doc, id, ANSWER);
    const dom = found.length === 1 ? view.nodeDOM(found[0].pos) : null;
    if (dom instanceof HTMLElement) dom.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.focus();
  }

  function focusQuestion(view: EditorView, id: string): boolean {
    const found = withId(view.state.doc, id, QUESTION);
    if (found.length !== 1) { ambiguous(); return false; }
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(found[0].pos + 1))).scrollIntoView());
    view.focus();
    return true;
  }

  function insertQuestion(view: EditorView, pos: number, text: string, attrs: Record<string, unknown>): string | null {
    const id = newCalloutId();
    const paragraph = schema().nodes.paragraph.create(null, text ? schema().text(text) : undefined);
    const question = schema().nodes.callout.create({ kind: QUESTION, id, ...attrs }, paragraph);
    const tr = view.state.tr.insert(pos, question);
    commit(view, tr.setSelection(TextSelection.create(tr.doc, pos + 2 + text.length)).scrollIntoView());
    if (withId(view.state.doc, id, QUESTION).length !== 1) return null;
    view.focus();
    return id;
  }

  function getSelectionContext(view: EditorView): SelectionContext | null {
    const { from, to, empty, $from } = view.state.selection;
    const images = new Set<string>();
    const collect = (node: PMNode) => {
      if (node.type.name === 'image' && typeof node.attrs.src === 'string') images.add(node.attrs.src);
    };
    let text: string;
    if (empty) {
      if (!$from.parent.isTextblock) return null;
      $from.parent.descendants(collect);
      text = modelMarkdown(Fragment.from($from.parent));
    } else {
      view.state.doc.nodesBetween(from, to, collect);
      text = stripImageData(view.state.doc.textBetween(from, to, '\n', (node) => node.type.name === 'image' ? node.attrs.alt || '[图片]' : ''));
    }
    return text.trim() || images.size ? { text, images: [...images] } : null;
  }

  function addQuestion(view: EditorView, pos: number, context: string, questionOptions: QuestionOptions): boolean {
    if (!hooks || options.readonly?.() || !view.editable) return false;
    let images: string[];
    try {
      images = [...new Set((questionOptions.images ?? []).map(normalizeImageSource))];
    } catch (error) {
      hooks.notify((error as Error).message);
      return false;
    }
    const { template, label } = questionOptions;
    const id = insertQuestion(view, pos, template ? label || template : '', { context: stripImageData(context), images });
    if (!id) return false;
    if (template) void ask(view, withId(view.state.doc, id, QUESTION)[0].pos, false, { template });
    return true;
  }

  function appendQuestion(view: EditorView, context: string, questionOptions: QuestionOptions = {}): boolean {
    return addQuestion(view, view.state.doc.content.size, context, questionOptions);
  }

  function askSelection(view: EditorView, template?: string, label?: string): boolean {
    const selection = getSelectionContext(view) ?? (hooks && !options.readonly?.() && view.editable ? { text: '', images: [] } : null);
    if (!selection) return false;
    if (options.onAskSelection) {
      options.onAskSelection(selection, template, label);
      return true;
    }
    const { $to } = view.state.selection;
    const pos = $to.depth ? $to.after(1) : view.state.doc.content.size;
    return addQuestion(view, pos, selection.text, { template, label, images: selection.images });
  }

  function insertFollowUp(view: EditorView, id: string, question: string): boolean {
    if (!hooks || options.readonly?.() || !view.editable) return false;
    const parents = withId(view.state.doc, id, QUESTION);
    const answers = answersFor(view.state.doc, id);
    if (parents.length !== 1 || answers.length !== 1 || withId(view.state.doc, answers[0].node.attrs.id, ANSWER).length !== 1) { ambiguous(); return false; }
    const parent = parents[0];
    if (!ancestry(view.state.doc, parent.node)) return false;
    const end = answers[0].pos + answers[0].node.nodeSize;
    return insertQuestion(view, end, question, { parentId: id, context: parent.node.attrs.context ?? anchorBefore(view.state.doc, parent.pos) }) !== null;
  }
  function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    if ((event.target as HTMLElement | null)?.closest('button, input, textarea, select, a')) return false;
    if (view.composing || event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return false;
    if (options.readonly?.() || !hooks) {
      if ((event.metaKey || event.ctrlKey) && options.onAskSelection) {
        event.preventDefault();
        return askSelection(view);
      }
      return false;
    }
    const { $from, empty } = view.state.selection;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      if (!empty) askSelection(view);
      else {
        const pos = questionAtCursor(view);
        if (pos !== null) void ask(view, pos);
        else if ($from.parent.type.name === 'paragraph' && Q_PREFIX.test($from.parent.textContent)) void ask(view, $from.before(), true);
        else askSelection(view);
      }
      return true;
    }
    if (event.shiftKey || event.altKey || !empty || $from.parentOffset !== $from.parent.content.size || $from.parent.type.name !== 'paragraph') return false;
    const pos = questionAtCursor(view);
    if (pos !== null) {
      const q = view.state.doc.nodeAt(pos)!;
      if ($from.index($from.depth - 1) === $from.node($from.depth - 1).childCount - 1 && $from.node($from.depth - 1) === q && q.textContent.trim()) {
        event.preventDefault();
        void ask(view, pos);
        return true;
      }
    } else if ($from.depth === 1 && Q_PREFIX.test($from.parent.textContent) && $from.parent.textContent.replace(Q_PREFIX, '').trim()) {
      event.preventDefault();
      void ask(view, $from.before(), true);
      return true;
    }
    return false;
  }

  function selectImage(view: EditorView, target: EventTarget | null): boolean {
    const image = target instanceof HTMLElement ? target.closest('img') : null;
    if (!image) return false;
    let imagePos: number | null = null;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return;
      const dom = view.nodeDOM(pos);
      if (dom === image || dom instanceof HTMLElement && dom.contains(image)) imagePos = pos;
    });
    if (imagePos === null) return false;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, imagePos)));
    return true;
  }

  function handleClick(view: EditorView, event: MouseEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (selectImage(view, target)) {
      event.preventDefault();
      if (!view.editable) view.dom.focus({ preventScroll: true });
      view.focus();
      return true;
    }
    const stopButton = target?.closest<HTMLElement>('[data-stop-generation]');
    if (stopButton) {
      stop(stopButton.dataset.stopGeneration!);
      return true;
    }
    const button = target?.closest<HTMLElement>('.callout-action');
    const element = button?.closest('.callout');
    if (!button || !element) return false;
    if (options.readonly?.() || !view.editable) return true;
    let found: Located | null = null;
    view.state.doc.descendants((node, pos) => {
      if (isCallout(node) && view.nodeDOM(pos) === element) found = { node, pos };
    });
    if (!found) return true;
    const { node, pos } = found as Located;
    const tr = view.state.tr;
    const action = button.dataset.action;
    switch (action) {
      case 'ask': void ask(view, pos); break;
      case 'toggle':
        commit(view, tr.setNodeMarkup(pos, undefined, { ...node.attrs, fold: node.attrs.fold === '-' ? '+' : '-' }));
        focusControl(view, node.attrs.id, 'toggle');
        break;
      case 'followup': insertFollowUp(view, node.attrs.answerTo, ''); break;
      case 'shorter':
      case 'detailed':
      case 'alternative':
      case 'reask': {
        const questions = node.attrs.answerTo ? withId(view.state.doc, node.attrs.answerTo, QUESTION) : [];
        if (questions.length === 1 && withId(view.state.doc, node.attrs.id, ANSWER).length === 1 && answersFor(view.state.doc, node.attrs.answerTo).length === 1) {
          void ask(view, questions[0].pos, false, action === 'reask' ? {} : { style: action, previousAnswer: modelMarkdown(node.content) });
        } else ambiguous();
        break;
      }
      case 'merge': {
        const origin = schema().nodes.ai_origin.create({ id: newCalloutId() }, node.content);
        commit(view, tr.replaceWith(pos, pos + node.nodeSize, origin).setSelection(TextSelection.near(tr.doc.resolve(pos + 1))).scrollIntoView());
        view.focus();
        break;
      }
      case 'delete':
        tr.delete(pos, pos + node.nodeSize);
        commit(view, tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)))).scrollIntoView());
        view.focus();
        break;
    }
    return true;
  }

  function collectPairs(doc: PMNode): QaPair[] {
    const pairs: QaPair[] = [];
    const questions = new Map<string, Located | null>();
    const answerIds = new Map<string, number>();
    const relations = new Map<string, number>();
    doc.descendants((node, pos) => {
      if (isCallout(node, QUESTION) && node.attrs.id) questions.set(node.attrs.id, questions.has(node.attrs.id) ? null : { node, pos });
      if (isCallout(node, ANSWER)) {
        answerIds.set(node.attrs.id, (answerIds.get(node.attrs.id) ?? 0) + 1);
        relations.set(node.attrs.answerTo, (relations.get(node.attrs.answerTo) ?? 0) + 1);
      }
    });
    let invalid = false;
    doc.descendants((node) => {
      if (!isCallout(node, ANSWER)) return true;
      const question = questions.get(node.attrs.answerTo);
      if (!question || !node.attrs.id || answerIds.get(node.attrs.id) !== 1 || relations.get(node.attrs.answerTo) !== 1) { invalid = true; return false; }
      const answer = modelMarkdown(node.content);
      if (answer) pairs.push({ id: question.node.attrs.id, answerId: node.attrs.id, question: question.node.textContent.trim(), anchor: question.node.attrs.context ?? anchorBefore(doc, question.pos), answer });
      return false;
    });
    if (invalid) ambiguous();
    return pairs;
  }

  function destroy() {
    destroyed = true;
    cancelGeneration();
  }

  return { plugin, ask, askSelection, getSelectionContext, appendQuestion, focusQuestion, insertFollowUp, handleKeyDown, handleClick, selectImage, collectPairs, parse, cancelGeneration, isGenerating: () => generations.size > 0, destroy };
}
