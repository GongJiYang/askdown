import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx, rootCtx, serializerCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import type { EditorView } from '@milkdown/kit/prose/view';
import { calloutSchema, remarkCallout } from './callout';
import { createQa, type QaHooks, type QaPair } from './qa';

export interface EditorHandle {
  getMarkdown(): string;
  /** 用新的 Markdown 替换全部内容（用于整理结果流式写入） */
  replaceAll(markdown: string, addToHistory?: boolean): void;
  collectPairs(): QaPair[];
  focus(): void;
  view(): EditorView;
  destroy(): Promise<void>;
}

export interface CreateEditorOptions {
  markdown: string;
  onChange?: (markdown: string) => void;
  /** 不传则关闭问答功能（例如整理面板） */
  qa?: QaHooks;
  editable?: () => boolean;
}

export async function createEditor(root: HTMLElement, opts: CreateEditorOptions): Promise<EditorHandle> {
  let qa: ReturnType<typeof createQa> | null = null;

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, opts.markdown);
      // 列表用 `-`，和 Obsidian、Typora 的默认写法一致
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' as const }));
      qa = createQa(ctx, opts.qa ?? null);
      const q = qa;
      // 直接写在 EditorView 上的 props 比所有插件优先，所以 Enter 会先经过问答逻辑
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        editable: opts.editable ?? (() => true),
        handleKeyDown: (view, event) => q.handleKeyDown(view, event),
        handleDOMEvents: {
          ...(prev.handleDOMEvents ?? {}),
          mousedown: (view, event) => q.handleMouseDown(view, event),
        },
      }));
      if (opts.onChange) {
        const cb = opts.onChange;
        ctx.get(listenerCtx).markdownUpdated((_ctx, md, prev) => {
          if (md !== prev) cb(md);
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
    .create();

  const view = () => editor.ctx.get(editorViewCtx);

  return {
    getMarkdown: () => editor.ctx.get(serializerCtx)(view().state.doc),
    replaceAll(markdown, addToHistory = false) {
      const v = view();
      const content = qa!.parse(markdown);
      const tr = v.state.tr.replaceWith(0, v.state.doc.content.size, content).setMeta('addToHistory', addToHistory);
      v.dispatch(tr);
    },
    collectPairs: () => qa!.collectPairs(view().state.doc),
    focus: () => view().focus(),
    view,
    async destroy() {
      qa?.destroy();
      await editor.destroy();
    },
  };
}
