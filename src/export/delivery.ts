import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../fs';
import { EXPORT_STYLE } from './document';

export function exportFilename(title: string, extension: 'html' | 'md', clean: boolean): string {
  const base = title.replace(/\.md$/i, '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').trim() || 'Askdown';
  return `${base.slice(0, 120)}${clean ? '-clean' : ''}.${extension}`;
}

/** Native save is a dialog-scoped command; it never writes through the vault adapter. */
export async function saveExport(content: string, filename: string, extension: 'html' | 'md'): Promise<boolean> {
  if (isTauri()) {
    return invoke<boolean>('export_text', { defaultName: filename, content, extension });
  }
  const url = URL.createObjectURL(new Blob([content], { type: extension === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  try { anchor.click(); } finally {
    anchor.remove();
    // WebKit may consume the object URL after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return true;
}

async function assetsReady(root: ParentNode, owner: Document): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners: (() => void)[] = [];
  try {
    await Promise.race([
      Promise.all([
        owner.fonts?.ready ?? Promise.resolve(),
        ...Array.from(root.querySelectorAll('img'), (image) => new Promise<void>((resolve, reject) => {
          const check = () => image.naturalWidth > 0 ? resolve() : reject(new Error('导出图片加载失败，请检查图片链接后重试。'));
          if (image.complete) { check(); return; }
          image.addEventListener('load', check, { once: true });
          image.addEventListener('error', check, { once: true });
          listeners.push(() => { image.removeEventListener('load', check); image.removeEventListener('error', check); });
        })),
      ]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('等待导出字体或图片超时，请检查网络后重试。')), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    for (const remove of listeners) remove();
  }
}

let disposePrint: (() => void) | undefined;

/** Print a rendered, isolated document. PDF creation is the platform print dialog's job. */
export async function printExport(html: string, title: string): Promise<void> {
  disposePrint?.();
  if (isTauri()) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const root = document.createElement('div');
    root.id = 'askdown-print-root';
    root.setAttribute('aria-hidden', 'true');
    root.style.display = 'none';
    // Shadow styles isolate the exported article from the editor/application styles.
    const shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${EXPORT_STYLE}\n:host { color-scheme: light; color: #20242a; background: white; font: 11pt/1.75 system-ui, -apple-system, sans-serif; }`;
    shadow.append(style, ...Array.from(parsed.body.childNodes));
    const printStyle = document.createElement('style');
    printStyle.textContent = '@media print { html, body { height: auto !important; overflow: visible !important; color-scheme: light; } body > :not(#askdown-print-root) { display: none !important; } body { margin: 0 !important; background: white !important; } #askdown-print-root { display: block !important; } }';
    document.head.append(printStyle);
    document.body.append(root);
    const oldTitle = document.title;
    document.title = title;
    const dispose = () => {
      root.remove();
      printStyle.remove();
      document.title = oldTitle;
      window.removeEventListener('afterprint', dispose);
      if (disposePrint === dispose) disposePrint = undefined;
    };
    disposePrint = dispose;
    window.addEventListener('afterprint', dispose, { once: true });
    try {
      await assetsReady(shadow, document);
      await invoke('plugin:webview|print', { label: null });
    } catch (error) {
      dispose();
      throw error;
    }
    // Some WebViews return before the sheet closes and omit afterprint. Keep the hidden
    // surface until afterprint or the next export, so an open dialog never loses its pages.
    return;
  }

  const iframe = document.createElement('iframe');
  iframe.title = '打印 / 保存为 PDF';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:1px;border:0;';
  const dispose = () => {
    iframe.remove();
    if (disposePrint === dispose) disposePrint = undefined;
  };
  disposePrint = dispose;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('无法打开打印预览。')), 20_000);
      iframe.onload = () => { clearTimeout(timer); resolve(); };
      iframe.onerror = () => { clearTimeout(timer); reject(new Error('无法打开打印预览。')); };
      iframe.srcdoc = html;
      document.body.append(iframe);
    });
    const target = iframe.contentWindow;
    const owner = iframe.contentDocument;
    if (!target || !owner) throw new Error('浏览器不允许打开打印预览。');
    await assetsReady(owner, owner);
    target.addEventListener('afterprint', dispose, { once: true });
    target.focus();
    target.print();
  } catch (error) {
    dispose();
    throw error;
  }
}
