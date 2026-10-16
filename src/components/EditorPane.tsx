import { useEffect, useRef, useState } from 'react';
import type { EditorHandle } from '../editor/createEditor';
import type { QaHooks } from '../editor/qa';
import { getFs } from '../fs';
import { DocumentSession, readOptional, type SaveState } from '../document';
export type { SaveStatus } from '../document';
export type LeaveGuard = (persistRendered?: boolean) => Promise<boolean>;

interface Props {
  path: string;
  vault: string;
  fallback?: string | null;
  qa?: QaHooks;
  editable?: () => boolean;
  readonly?: () => boolean;
  onAskSelection?: (selection: { text: string; images: string[] }, template?: string, label?: string) => void;
  className?: string;
  onStatus?: (s: SaveState['status'], detail?: string) => void;
  onChange?: (markdown: string) => void;
  onHandle?: (h: EditorHandle | null) => void;
  onGuard?: (guard: LeaveGuard | null) => void;
  onConflict?: () => void;
  onError?: (msg: string) => void;
}

export function EditorPane(props: Props) {
  const { path, vault, fallback = null, className } = props;
  const host = useRef<HTMLDivElement>(null);
  const cbs = useRef(props);
  cbs.current = props;
  const session = useRef<DocumentSession | null>(null);
  const editor = useRef<EditorHandle | null>(null);
  const [state, setState] = useState<SaveState>({ status: 'idle' });
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Array<{ id: string; created: number }> | null>(null);
  const [selected, setSelected] = useState<{ id: string; content: string } | null>(null);
  const [historyError, setHistoryError] = useState('');
  const historyRequest = useRef(0);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let unwatch: (() => void) | undefined;
    let handle: EditorHandle | null = null;
    let document: DocumentSession | null = null;
    let mounting = true;
    const mount = window.document.createElement('div');
    mount.className = 'editor-mount';
    host.current?.appendChild(mount);
    setLoadError('');

    const check = async () => {
      clearTimeout(timer);
      if (document && handle) document.edit(handle.getMarkdown());
      await document?.checkExternal();
      if (!disposed && document?.state.status === 'dirty') void document.flush();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (document && handle) document.edit(handle.getMarkdown());
      if (document?.unsafeToLeave || handle?.isGenerating() || cbs.current.editable?.() === false) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('focus', check);
    cbs.current.onGuard?.(async (persistRendered = false) => {
      if (!document || !handle) return false;
      if (handle.isGenerating()) {
        if (!window.confirm('回答仍在生成。停止生成并离开？已完成的内容不会丢失。')) return false;
        handle.cancelGeneration();
      }
      clearTimeout(timer);
      // Catch an external change even if its filesystem event has not arrived yet.
      let saved: boolean;
      do {
        document.edit(handle.getMarkdown());
        await document.checkExternal();
        saved = await document.flush(persistRendered && !cbs.current.readonly?.());
      } while (saved && handle.getMarkdown() !== document.content);
      if (!saved) cbs.current.onError?.('请先处理当前文件的冲突或保存错误，再离开');
      return saved;
    });

    void (async () => {
      try {
        const fs = await getFs();
        const raw = await readOptional(fs, path);
        if (raw === null && fallback === null) throw new Error('文件不存在：' + path);
        if (disposed) return;
        document = new DocumentSession(fs, path, vault, raw, (next) => {
          if (disposed) return;
          setState(next);
          cbs.current.onStatus?.(next.status, next.detail);
          if (next.status === 'conflict') {
            clearTimeout(timer);
            handle?.cancelGeneration();
            cbs.current.onConflict?.();
          }
        });
        session.current = document;
        const { createEditor } = await import('../editor/createEditor');
        if (disposed) return;
        const h = await createEditor(mount, {
          markdown: raw ?? fallback ?? '',
          qa: cbs.current.qa ? {
            ask: (req, onText, signal) => cbs.current.qa!.ask(req, onText, signal),
            notify: (message) => cbs.current.qa!.notify(message),
          } : undefined,
          editable: () => cbs.current.editable?.() ?? true,
          readonly: () => cbs.current.readonly?.() ?? false,
          onAskSelection: cbs.current.onAskSelection ? (selection, template, label) => cbs.current.onAskSelection?.(selection, template, label) : undefined,
          onGenerationChange: (generating) => { if (!disposed) setBusy(generating); },
          onChange: (next) => {
            if (disposed || mounting) return;
            document!.edit(next);
            cbs.current.onChange?.(next);
            clearTimeout(timer);
            if (document!.state.status === 'dirty') timer = window.setTimeout(() => void document!.flush(), 700);
          },
        });
        if (disposed) {
          await h.destroy();
          mount.remove();
          return;
        }
        handle = h;
        editor.current = h;
        document.adoptRendered(h.getMarkdown());
        mounting = false;
        cbs.current.onHandle?.(h);
        cbs.current.onStatus?.('idle');
        unwatch = await fs.watch(path, () => { void check(); }, (message) => {
          if (!disposed) setLoadError('文件监听失败：' + message + '。保存时仍会校验磁盘版本。');
        });
        if (disposed) { unwatch(); return; }
        await check();
      } catch (error) {
        if (!disposed) {
          const message = String((error as Error)?.message ?? error);
          setLoadError(message);
          cbs.current.onError?.(message);
        }
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(timer);
      unwatch?.();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('focus', check);
      cbs.current.onHandle?.(null);
      cbs.current.onGuard?.(null);
      handle?.cancelGeneration();
      if (document && handle) document.edit(handle.getMarkdown());
      // Navigation normally flushes first. Preserve a recovery copy on unexpected unmount.
      void document?.preserveRecovery().catch((error: unknown) => cbs.current.onError?.('恢复副本保存失败：' + String(error)));
      session.current = null;
      editor.current = null;
      void handle?.destroy().finally(() => mount.remove());
      if (!handle) mount.remove();
    };
  }, [path, vault, fallback, reloadKey]);

  useEffect(() => {
    const view = editor.current?.view();
    if (view && !view.isDestroyed) view.updateState(view.state);
  }, [props.readonly, props.editable]);

  async function resolve(reload: boolean) {
    const doc = session.current;
    const h = editor.current;
    if (!doc || !h || (!reload && cbs.current.readonly?.())) return;
    h.cancelGeneration();
    doc.edit(h.getMarkdown());
    if (reload) {
      const content = await doc.reload();
      if (content !== undefined) {
        h.replaceAll(content ?? '', false);
        doc.adoptRendered(h.getMarkdown());
      }
    } else {
      await doc.keepMine();
    }
  }

  async function openHistory() {
    try {
      setHistoryError('');
      setSelected(null);
      setHistory(await (await getFs()).history(path, vault));
    } catch (error) {
      cbs.current.onError?.('读取历史失败：' + String(error));
    }
  }

  async function restore() {
    const doc = session.current;
    const h = editor.current;
    if (!doc || !h || !selected || h.isGenerating() || cbs.current.editable?.() === false || cbs.current.readonly?.()) return;
    doc.edit(h.getMarkdown());
    await doc.checkExternal();
    if (!(await doc.flush())) {
      setHistoryError('请先处理文件冲突或保存错误');
      return;
    }
    h.replaceAll(selected.content, true);
    doc.edit(h.getMarkdown());
    if (await doc.flush()) {
      setHistory(null);
      cbs.current.onError?.('已恢复历史版本，替换前的内容也已保留');
    }
  }

  return <div className={className}>
    <div className="document-tools">
      <button type="button" className="btn" onClick={() => void openHistory()} disabled={busy}>版本历史</button>
      {busy && <span className="muted">生成预览中，完成后保存</span>}
    </div>
    {loadError && <div className="file-alert" role="alert">{loadError} <button className="btn" onClick={() => setReloadKey((n) => n + 1)}>重试读取</button></div>}
    {state.status === 'conflict' && <div className="file-alert" role="alert">
      <strong>{state.external === null ? '文件已被外部删除' : '文件已被外部修改'}</strong>
      <p>自动保存已暂停。重新载入会先把当前内容存入版本历史；保留我的版本会备份磁盘内容后再保存。</p>
      <button className="btn" onClick={() => void resolve(true)}>重新载入</button>{' '}
      <button className="btn primary" disabled={props.readonly?.()} onClick={() => void resolve(false)}>保留我的版本</button>
    </div>}
    {state.status === 'error' && <div className="file-alert" role="alert">保存失败：{state.detail}。当前编辑仍保留在窗口中。 <button className="btn" onClick={() => void session.current?.flush()}>重试保存</button></div>}
    <div ref={host} />
    {history !== null && <div className="modal-backdrop">
      <div className="modal history-dialog" role="dialog" aria-modal="true" aria-label="版本历史">
        <h2>版本历史</h2>
        <p className="hint">恢复前会保存当前版本，恢复操作也可以撤销。</p>
        <div className="history-versions">
          {history.length === 0 && <p>尚无历史版本。每次改写保存前会自动备份。</p>}
          {history.map((version) => <button className={'btn' + (selected?.id === version.id ? ' on' : '')} key={version.id} onClick={() => {
            const request = ++historyRequest.current;
            setSelected(null);
            void getFs().then((fs) => fs.readHistory(path, vault, version.id)).then((content) => {
              if (request === historyRequest.current) setSelected({ id: version.id, content });
            }).catch((error) => setHistoryError(String(error)));
          }}>{new Date(version.created).toLocaleString()}</button>)}
        </div>
        {selected && <textarea className="history-preview" aria-label="历史版本内容" readOnly value={selected.content} />}
        {historyError && <p role="alert">{historyError}</p>}
        <div className="modal-foot">
          <button className="btn" onClick={() => { ++historyRequest.current; setHistory(null); }}>关闭</button>
          <button className="btn primary" disabled={!selected || busy || props.readonly?.()} onClick={() => void restore()}>恢复此版本</button>
        </div>
      </div>
    </div>}
  </div>;
}
