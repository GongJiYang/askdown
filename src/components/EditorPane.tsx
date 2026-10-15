import { useEffect, useRef } from 'react';
import { createEditor, type EditorHandle } from '../editor/createEditor';
import type { QaHooks } from '../editor/qa';
import { getFs } from '../fs';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface Props {
  /** 文件的绝对路径；变化时重新加载编辑器 */
  path: string;
  /** 文件不存在时用的初始内容；为 null 表示必须存在 */
  fallback?: string | null;
  qa?: QaHooks;
  editable?: () => boolean;
  className?: string;
  onStatus?: (s: SaveStatus, detail?: string) => void;
  onHandle?: (h: EditorHandle | null) => void;
  onError?: (msg: string) => void;
}

/**
 * 一个挂载 Milkdown 的区域：负责读文件、自动保存（停止输入 0.7 秒后写盘）。
 * 每次切换文件都会新建编辑器，这样撤销历史不会串到别的文件。
 */
export function EditorPane({ path, fallback = null, qa, editable, className, onStatus, onHandle, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  // 回调用 ref 保存，避免它们变化时重建编辑器
  const cbs = useRef({ qa, editable, onStatus, onHandle, onError });
  cbs.current = { qa, editable, onStatus, onHandle, onError };

  useEffect(() => {
    let disposed = false;
    let handle: EditorHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: string | null = null;
    const mount = document.createElement('div');
    mount.className = 'editor-mount';
    host.current?.appendChild(mount);

    const flush = async () => {
      if (pending === null) return;
      const md = pending;
      pending = null;
      cbs.current.onStatus?.('saving');
      try {
        await (await getFs()).write(path, md);
        if (pending === null) cbs.current.onStatus?.('saved');
      } catch (e) {
        cbs.current.onStatus?.('error', String((e as Error)?.message ?? e));
      }
    };

    (async () => {
      const fs = await getFs();
      let md = '';
      try {
        md = await fs.read(path);
      } catch (e) {
        if (fallback === null) cbs.current.onError?.('打不开这个文件：' + String((e as Error)?.message ?? e));
        md = fallback ?? '';
      }
      if (disposed) return;
      const qaHooks: QaHooks | undefined = cbs.current.qa
        ? {
            ask: (req, onText, signal) => cbs.current.qa!.ask(req, onText, signal),
            notify: (m) => cbs.current.qa!.notify(m),
          }
        : undefined;
      const h = await createEditor(mount, {
        markdown: md,
        qa: qaHooks,
        editable: () => cbs.current.editable?.() ?? true,
        onChange: (next) => {
          pending = next;
          cbs.current.onStatus?.('dirty');
          clearTimeout(timer);
          timer = setTimeout(() => void flush(), 700);
        },
      });
      if (disposed) {
        await h.destroy();
        mount.remove();
        return;
      }
      handle = h;
      cbs.current.onStatus?.('idle');
      cbs.current.onHandle?.(h);
    })();

    return () => {
      disposed = true;
      clearTimeout(timer);
      void flush();
      cbs.current.onHandle?.(null);
      const h = handle;
      handle = null;
      void (async () => {
        await h?.destroy();
        mount.remove();
      })();
    };
  }, [path, fallback]);

  return <div className={className} ref={host} />;
}
