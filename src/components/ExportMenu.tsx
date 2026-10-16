import { useEffect, useId, useRef, useState } from 'react';
import type { EditorHandle } from '../editor/createEditor';
import { exportHtml, exportMarkdown } from '../export/document';
import { exportFilename, printExport, saveExport } from '../export/delivery';
import './ExportMenu.css';

interface Props {
  getEditor: () => EditorHandle | null;
  title: string;
  notify: (message: string) => void;
}

export function ExportMenu({ getEditor, title, notify }: Props) {
  const [open, setOpen] = useState(false);
  const [clean, setClean] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const running = useRef(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLInputElement>('input')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  async function run(format: 'md' | 'html' | 'pdf', cleanExport = clean) {
    if (running.current) return;
    const editor = getEditor();
    if (!editor) { notify('请先打开要导出的文档。'); return; }
    running.current = true;
    setBusy(true);
    try {
      if (format === 'pdf') {
        await printExport(exportHtml(editor, title, cleanExport), title);
        notify('已打开打印对话框；可在系统支持时选择“保存为 PDF”。');
      } else {
        const content = format === 'md' ? exportMarkdown(editor, cleanExport) : exportHtml(editor, title, cleanExport);
        const saved = await saveExport(content, exportFilename(title, format, cleanExport), format);
        if (saved) notify('已提交导出保存。');
      }
      setOpen(false);
      trigger.current?.focus();
    } catch (error) {
      notify(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return <div className="export-menu" ref={root} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>导出</button>
    {open && <div id={id} className="export-popover" role="group" aria-label="导出当前文档" aria-busy={busy}>
      <label className="export-clean"><input type="checkbox" checked={clean} disabled={busy} onChange={(event) => setClean(event.target.checked)} />清洁版本</label>
      <p>清洁版本移除提问、AI 回答和未经编辑的 AI 正文，保留个人编辑与普通提示块。</p>
      <button type="button" className="btn" disabled={busy} onClick={() => void run('html')}>导出 HTML</button>
      <button type="button" className="btn" disabled={busy} onClick={() => void run('pdf')}>打印 / 保存为 PDF</button>
      <button type="button" className="btn" disabled={busy} onClick={() => void run('md', true)}>导出清洁 Markdown</button>
      <p>导出当前编辑内容；生成中的临时预览不包含在内。PDF 通过打印对话框保存。</p>
      {busy && <span role="status">正在准备导出…</span>}
    </div>}
  </div>;
}
