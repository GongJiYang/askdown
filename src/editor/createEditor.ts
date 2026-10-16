import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx, rootCtx, serializerCtx } from '@milkdown/kit/core';
import { commonmark, linkAttr } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import { closeHistory } from '@milkdown/kit/prose/history';
import { $prose } from '@milkdown/kit/utils';
import { aiOriginSchema, calloutSchema, remarkCallout } from './callout';
import { createQa } from './qa';
import type { QaHooks, QaPair, QuestionOptions, SelectionContext } from './qa';
import { createOutline, type OutlineHeading } from './outline';
import { createSlashMenu } from './slash';

export interface EditorHandle {
  getMarkdown(): string;
  serialize(doc: PMNode): string;
  outline(): OutlineHeading[];
  jumpToHeading(pos: number): boolean;
  subscribeOutline(listener: () => void): () => void;
  /** Replace the document as one undoable action, or reset history for a disk reload. */
  replaceAll(markdown: string, addToHistory?: boolean): void;
  collectPairs(): QaPair[];
  askSelection(template?: string, label?: string): boolean;
  getSelectionContext(): SelectionContext | null;
  insertQuestion(context: string, options?: QuestionOptions): boolean;
  focusQuestion(id: string): boolean;
  insertFollowUp(id: string, question: string): boolean;
  focus(): void;
  view(): EditorView;
  cancelGeneration(): void;
  isGenerating(): boolean;
  destroy(): Promise<void>;
}

export interface CreateEditorOptions {
  markdown: string;
  onChange?: (markdown: string) => void;
  /** 不传则关闭问答功能（例如整理面板） */
  qa?: QaHooks;
  editable?: () => boolean;
  readonly?: () => boolean;
  onAskSelection?: (selection: SelectionContext, template?: string, label?: string) => void;
  onGenerationChange?: (busy: boolean) => void;
}

export async function createEditor(root: HTMLElement, opts: CreateEditorOptions): Promise<EditorHandle> {
  let qa: ReturnType<typeof createQa> | null = null;
  let destroyed = false;
  const outline = createOutline();
  const slash = createSlashMenu(!!opts.qa, () => !!opts.readonly?.());

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, opts.markdown);
      // 列表用 `-`，和 Obsidian、Typora 的默认写法一致
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' as const }));
      ctx.update(linkAttr.key, (previous) => (mark) => ({
        ...previous(mark),
        tabindex: '0',
        ...(mark.attrs.href.startsWith('#q-') ? { contenteditable: 'false' } : {}),
      }));
      qa = createQa(ctx, opts.qa ?? null, opts.onGenerationChange, opts);
      const q = qa;
      // 直接写在 EditorView 上的 props 比所有插件优先，所以 Enter 会先经过问答逻辑
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        editable: () => !opts.readonly?.() && (opts.editable?.() ?? true),
        handleKeyDown: (view, event) => slash.handleKeyDown(view, event) || q.handleKeyDown(view, event),
        handleDOMEvents: {
          ...(prev.handleDOMEvents ?? {}),
          // Let native button keyboard/mouse behavior run without editor keymaps.
          keydown: (view, event) => {
            if ((event.target as HTMLElement | null)?.closest('button, input, textarea, select, a')) return true;
            // ProseMirror skips handleKeyDown when editable is false.
            return !view.editable && q.handleKeyDown(view, event);
          },
          mousedown: (_view, event) => !!(event.target as HTMLElement | null)?.closest('button'),
          click: (view, event) => q.handleClick(view, event),
          focusin: (view, event) => { q.selectImage(view, event.target); return false; },
        },
      }));
      if (opts.onChange) {
        const cb = opts.onChange;
        ctx.get(listenerCtx).markdownUpdated((_ctx, md, prev) => {
          // Milkdown debounces this callback. Ignore an old document after reload/destroy.
          if (!destroyed && md !== prev && md === ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)) cb(md);
        });
      }
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(remarkCallout)
    .use(calloutSchema)
    .use(aiOriginSchema)
    .use($prose(() => qa!.plugin))
    .use($prose(() => outline.plugin))
    .use($prose(() => slash.plugin))
    .create();

  const view = () => editor.ctx.get(editorViewCtx);
  // Readonly documents still need keyboard focus for selection and image questions.
  view().dom.tabIndex = 0;

  return {
    getMarkdown: () => editor.ctx.get(serializerCtx)(view().state.doc),
    serialize: (doc) => editor.ctx.get(serializerCtx)(doc),
    outline: () => outline.outline(view()),
    jumpToHeading: (pos) => outline.jump(view(), pos),
    subscribeOutline: (listener) => outline.subscribe(listener),
    replaceAll(markdown, addToHistory = true) {
      qa!.cancelGeneration();
      const v = view();
      const content = qa!.parse(markdown);
      const tr = closeHistory(v.state.tr).replaceWith(0, v.state.doc.content.size, content).setMeta('addToHistory', addToHistory).setMeta('askdown-replace', true);
      v.dispatch(tr);
      if (addToHistory) {
        v.dispatch(closeHistory(v.state.tr).setMeta('addToHistory', false));
      } else {
        // Reinitializing plugin state discards both undo and redo, including old disk versions.
        v.updateState(EditorState.create({ schema: v.state.schema, doc: v.state.doc, selection: v.state.selection, plugins: v.state.plugins }));
      }
    },
    collectPairs: () => qa!.collectPairs(view().state.doc),
    askSelection: (template, label) => qa!.askSelection(view(), template, label),
    getSelectionContext: () => qa!.getSelectionContext(view()),
    insertQuestion: (context, options) => qa!.appendQuestion(view(), context, options),
    focusQuestion: (id) => qa!.focusQuestion(view(), id),
    insertFollowUp: (id, question) => qa!.insertFollowUp(view(), id, question),
    focus: () => view().focus(),
    view,
    cancelGeneration: () => qa!.cancelGeneration(),
    isGenerating: () => qa!.isGenerating(),
    async destroy() {
      destroyed = true;
      qa?.destroy();
      outline.destroy();
      await editor.destroy();
    },
  };
}
