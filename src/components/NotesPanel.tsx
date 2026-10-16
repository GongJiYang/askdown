import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent, type KeyboardEvent } from 'react';
import type { EditorHandle } from '../editor/createEditor';
import { checkpointFor, followUps, readNotes, writeNotes, validateNotes, type NotesFollowUp } from '../ai/notes';
import type { Settings } from '../settings';
import { EditorPane } from './EditorPane';
import type { LeaveGuard } from './EditorPane';

const ExportMenu = lazy(() => import('./ExportMenu').then((module) => ({ default: module.ExportMenu })));

interface Props {
  vault: string;
  notesPath: string;
  title: string;
  settings: Settings;
  getMain: () => EditorHandle | null;
  prepareSources: () => Promise<boolean>;
  notify: (msg: string) => void;
  onGuard: (guard: LeaveGuard | null) => void;
  installing: boolean;
}

export function NotesPanel({ vault, notesPath, title, settings, getMain, prepareSources, notify, onGuard, installing }: Props) {
  const notes = useRef<EditorHandle | null>(null);
  const paneGuard = useRef<LeaveGuard | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const lastMarkdown = useRef<string | null>(null);
  const installingNow = useRef(installing);
  installingNow.current = installing;
  const [busy, setBusy] = useState(false);
  const preview = useRef<HTMLPreElement>(null);
  const previewText = useRef('');
  const previewFrame = useRef<number>();
  const [empty, setEmpty] = useState(true);
  const [questions, setQuestions] = useState<NotesFollowUp[]>([]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ctl.current?.abort();
      if (previewFrame.current !== undefined) cancelAnimationFrame(previewFrame.current);
      ctl.current = null;
    };
  }, []);

  function updateNotesState(handle: EditorHandle) {
    const markdown = handle.getMarkdown();
    if (lastMarkdown.current === markdown) return;
    lastMarkdown.current = markdown;
    try {
      const content = readNotes(markdown).notes;
      setEmpty(!content.trim());
      setQuestions(followUps(content));
    } catch {
      // Keep the editable document available so a damaged checkpoint can be reset.
      setEmpty(!markdown.trim());
      setQuestions(followUps(markdown));
    }
  }

  function sourceLink(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) {
    if ('key' in event && event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>('a[href^="#q-"]');
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    const id = link.getAttribute('href')!.slice(3);
    if (!getMain()?.focusQuestion(id)) notify('来源问题已被删除或标识不明确');
  }

  function showPreview(text: string) {
    previewText.current = text;
    if (previewFrame.current !== undefined) return;
    previewFrame.current = requestAnimationFrame(() => {
      previewFrame.current = undefined;
      const target = preview.current;
      if (!target) return;
      const node = target.firstChild;
      const next = previewText.current;
      if (node instanceof Text && next.startsWith(node.data)) node.appendData(next.slice(node.length));
      else target.textContent = next;
    });
  }

  async function tidy(full = false) {
    if (ctl.current) { ctl.current.abort(); return; }
    const main = getMain();
    const panel = notes.current;
    if (!main || !panel || installingNow.current) return;
    const controller = new AbortController();
    ctl.current = controller;
    setBusy(true);
    previewText.current = '';
    panel.view().setProps({ editable: () => !ctl.current && !installingNow.current });
    try {
      if (paneGuard.current && !(await paneGuard.current())) return;
      if (!(await prepareSources())) return;
      if (!alive.current || controller.signal.aborted || notes.current !== panel || getMain() !== main) return;
      const sources = main.collectPairs();
      const pairs = sources.filter((pair) => pair.answer.trim());
      if (!pairs.length) { notify('先在文档里完成几组问答，再来整理'); return; }
      const before = panel.getMarkdown();
      const previous = readNotes(before, full);
      const checkpoint = await checkpointFor(pairs);
      const delta = pairs.filter((pair) => full || checkpoint.revisions[pair.id] !== previous.checkpoint.revisions[pair.id]);
      if (!delta.length) { notify('没有新增或修改的回答，无需再次整理'); return; }
      if (controller.signal.aborted || notes.current !== panel) return;
      const { runTidy } = await import('../ai/actions');
      controller.signal.throwIfAborted();
      const text = await runTidy(settings, vault, {
        title, head: main.getMarkdown(), notes: previous.notes, pairs: delta, sources,
      }, (text) => {
        if (alive.current && !controller.signal.aborted) showPreview(text);
      }, controller.signal, notify);
      if (!alive.current || controller.signal.aborted || notes.current !== panel || getMain() !== main) return;
      if (panel.getMarkdown() !== before) throw new Error('笔记已发生变化，本次整理未覆盖当前内容，请重试');
      validateNotes(text, main.collectPairs(), delta, previous.notes);
      // Text and checkpoint enter the document, history, and autosave atomically.
      panel.replaceAll(writeNotes(text, checkpoint), true);
      updateNotesState(panel);
      notify(`已整理 ${delta.length} 组新增或修改的问答`);
    } catch (error) {
      if (alive.current) notify(controller.signal.aborted ? '已停止整理，笔记和进度保持原样' : String((error as Error)?.message ?? error));
    } finally {
      if (ctl.current === controller) ctl.current = null;
      if (alive.current) {
        if (notes.current === panel) panel.view().setProps({ editable: () => !ctl.current && !installingNow.current });
        setBusy(false);
        if (previewFrame.current !== undefined) cancelAnimationFrame(previewFrame.current);
        previewFrame.current = undefined;
        previewText.current = '';
      }
    }
  }

  return <aside className="notes" onClickCapture={sourceLink} onKeyDownCapture={sourceLink}>
    <div className="notes-head">
      <div><h2>整理</h2><p>独立编辑笔记，与原文并排阅读</p></div>
      <div className="notes-actions">
        <button type="button" disabled={installing} className={busy ? 'btn warn' : 'btn primary'} onClick={() => void tidy()}>{busy ? '停止' : '整理新增问答'}</button>
        <button type="button" className="btn" disabled={busy || installing} onClick={() => void tidy(true)} title="重新处理全部已回答的问题，保留已有笔记作为上下文；完成后更新进度，可撤销">重新整理全部</button>
        <Suspense fallback={null}><ExportMenu title={title + '.notes'} getEditor={() => notes.current} notify={notify} /></Suspense>
      </div>
    </div>
    <div className="notes-body">
      {empty && !busy && <p className="notes-empty">提过几个问题之后，点「整理新增问答」。结果保存为同名的 <code>.notes.md</code> 文件。后续仅处理新增或修改的回答，完成后一次保存；撤销会同时恢复笔记与整理进度。</p>}
      {!empty && <p className="notes-source-help">点击来源链接回到原问题，也可用 Tab 选中后按 Enter。下面的待追问可插回正文继续思考。</p>}
      {questions.length > 0 && <section className="notes-followups" aria-label="待追问">
        <h3>继续追问</h3>
        {questions.map((item, index) => <div className="notes-followup" key={`${item.id}:${index}`}>
          <span>{item.question}</span>
          <button type="button" className="btn" onClick={() => { if (!getMain()?.focusQuestion(item.id)) notify('来源问题已被删除或标识不明确'); }}>查看来源</button>
          <button type="button" className="btn" disabled={installing || busy} onClick={() => {
            if (getMain()?.insertFollowUp(item.id, item.question)) notify('已插入正文，编辑问题后按 Enter 提问');
            else notify('无法插入追问：来源问题已删除、存在歧义或正文暂不可编辑');
          }}>插入正文追问</button>
        </div>)}
      </section>}
      {busy && <section className="generation-preview" aria-label="整理预览" aria-live="polite"><p>正在生成，原笔记和进度保持不变…</p><pre ref={preview} /></section>}
      <EditorPane
        path={notesPath}
        vault={vault}
        fallback=""
        className="notes-editor"
        editable={() => !ctl.current && !installing}
        onConflict={() => ctl.current?.abort()}
        onError={notify}
        onGuard={(guard) => {
          paneGuard.current = guard;
          onGuard(guard ? async (persistRendered = false) => {
            if (ctl.current) {
              if (!window.confirm('笔记仍在整理。停止生成并离开？原笔记和进度会保留。')) return false;
              ctl.current.abort();
            }
            return guard(persistRendered);
          } : null);
        }}
        onHandle={(handle) => {
          if (!handle) ctl.current?.abort();
          notes.current = handle;
          if (handle) updateNotesState(handle);
        }}
        onStatus={() => {
          if (notes.current) updateNotesState(notes.current);
        }}
        onChange={() => { if (notes.current) updateNotesState(notes.current); }}
      />
    </div>
  </aside>;
}
