import { useEffect, useRef, useState } from 'react';
import type { ImportedMaterial } from '../import/types';
import { importWeb } from '../import/web';
import { importBook } from '../import/books';

interface Props {
  onImport: (material: ImportedMaterial) => Promise<void>;
  onClose: () => void;
}

export function ImportDialog({ onImport, onClose }: Props) {
  const [mode, setMode] = useState<'web' | 'book'>('web');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { controller.current?.abort(); previous?.focus(); };
  }, []);

  async function submit() {
    if (controller.current) return;
    const ctl = new AbortController();
    controller.current = ctl;
    setBusy(true);
    setError('');
    try {
      const material = mode === 'web' ? await importWeb(url.trim(), ctl.signal) : await importBook(file!, ctl.signal);
      ctl.signal.throwIfAborted();
      setSaving(true);
      await onImport(material);
      onClose();
    } catch (cause) {
      if (!ctl.signal.aborted) setError(String((cause as Error)?.message ?? cause));
    } finally {
      controller.current = null;
      setBusy(false);
      setSaving(false);
    }
  }

  return <div className="modal-backdrop">
    <form ref={dialog} className="modal import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title" aria-busy={busy}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) { event.preventDefault(); controller.current?.abort(); onClose(); }
        if (event.key === 'Tab') {
          const nodes = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]'));
          const first = nodes[0]; const last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <h2 id="import-title">导入阅读材料</h2>
      <div className="segmented" aria-label="导入格式">
        <button type="button" disabled={busy} aria-pressed={mode === 'web'} className={mode === 'web' ? 'on' : ''} onClick={() => { setMode('web'); setError(''); }}>网页链接</button>
        <button type="button" disabled={busy} aria-pressed={mode === 'book'} className={mode === 'book' ? 'on' : ''} onClick={() => { setMode('book'); setError(''); }}>PDF / EPUB</button>
      </div>
      {mode === 'web' ? <label>文章链接<input className="input" type="url" required disabled={busy} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/article" />
        <span className="hint">提取网页正文并保留标题和图片。受登录或跨域限制的网页可能无法直接导入。</span>
      </label> : <label>选择书籍文件<input className="input" type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" required disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <span className="hint">保留章节结构。扫描 PDF 在容量允许时保留页面图像供看图提问，省略情况会提示；没有文字层的页面不进行 OCR。加密文件需先解密。</span>
      </label>}
      <p className="hint">原文默认只读；问答和个人笔记保存在单独的批注文件中。</p>
      {error && <p className="file-alert" role="alert">{error}</p>}
      {busy && <p role="status">{saving ? '正在保存到文件库…' : '正在提取正文和图片…'}</p>}
      <div className="modal-foot">
        <button type="button" className="btn" disabled={saving} onClick={() => { controller.current?.abort(); onClose(); }}>{busy ? '取消导入' : '取消'}</button>
        <button type="submit" className="btn primary" disabled={busy || (mode === 'web' ? !url.trim() : !file)}>导入并阅读</button>
      </div>
    </form>
  </div>;
}
