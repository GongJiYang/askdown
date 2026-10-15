import { useRef, useState } from 'react';
import type { EditorHandle } from '../editor/createEditor';
import { runTidy } from '../ai/actions';
import type { Settings } from '../settings';
import { EditorPane } from './EditorPane';

interface Props {
  vault: string;
  notesPath: string;
  title: string;
  settings: Settings;
  getMain: () => EditorHandle | null;
  notify: (msg: string) => void;
}

/** 右侧整理面板：把文档里散落的问答归并成一份笔记，存为同名的 .notes.md 文件。 */
export function NotesPanel({ vault, notesPath, title, settings, getMain, notify }: Props) {
  const notes = useRef<EditorHandle | null>(null);
  const tidying = useRef(false);
  const ctl = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [empty, setEmpty] = useState(true);

  async function tidy() {
    if (busy) {
      ctl.current?.abort();
      return;
    }
    const main = getMain();
    const panel = notes.current;
    if (!main || !panel) return;
    const pairs = main.collectPairs();
    if (!pairs.length) {
      notify('先在文档里提几个问题，再来整理');
      return;
    }
    const before = panel.getMarkdown();
    const head = main.getMarkdown().slice(0, 1500);
    const controller = new AbortController();
    ctl.current = controller;
    tidying.current = true;
    setBusy(true);
    let last = 0;
    try {
      const text = await runTidy(
        settings,
        vault,
        { title, head, notes: before, pairs },
        (t) => {
          const now = Date.now();
          if (now - last < 120) return;
          last = now;
          panel.replaceAll(t, false);
          setEmpty(false);
        },
        controller.signal,
      );
      panel.replaceAll(text, true);
      setEmpty(false);
      notify(`已整理 ${pairs.length} 组问答`);
    } catch (e) {
      panel.replaceAll(before, false);
      const err = e as Error;
      notify(err?.name === 'AbortError' ? '已停止整理，笔记保持原样' : err?.message || '整理失败');
    } finally {
      tidying.current = false;
      ctl.current = null;
      setBusy(false);
    }
  }

  return (
    <aside className="notes">
      <div className="notes-head">
        <div>
          <h2>整理</h2>
          <p>把散落的问答归并成一份笔记</p>
        </div>
        <button type="button" className={busy ? 'btn warn' : 'btn primary'} onClick={() => void tidy()}>
          {busy ? '停止' : '整理问答'}
        </button>
      </div>
      <div className="notes-body">
        {empty && !busy && (
          <p className="notes-empty">
            提过几个问题之后，点「整理问答」。散落在文档各处的问答会被归并成三部分：核心概念、要点、还没搞懂的。整理结果保存在同名的 <code>.notes.md</code> 文件里，可以直接编辑；再次整理时会在你改过的版本上合并新内容。
          </p>
        )}
        <EditorPane
          key={notesPath}
          path={notesPath}
          fallback=""
          className="notes-editor"
          editable={() => !tidying.current}
          onHandle={(h) => {
            notes.current = h;
            if (h) setEmpty(!h.getMarkdown().trim());
          }}
          onStatus={(s) => {
            if (s === 'dirty' && notes.current) setEmpty(!notes.current.getMarkdown().trim());
          }}
        />
      </div>
    </aside>
  );
}
