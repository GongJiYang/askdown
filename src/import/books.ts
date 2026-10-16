import type { ImportedMaterial } from './types';

export function checkBookAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('导入已取消', 'AbortError');
}

export function bookTitle(name: string): string {
  return name.replace(/\.(pdf|epub)$/i, '').trim() || '未命名书籍';
}

export function markdownText(text: string): string {
  return text.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').replace(/\r?\n/g, ' ');
}

export async function importBook(file: File, signal?: AbortSignal): Promise<ImportedMaterial> {
  checkBookAbort(signal);
  if (!file.size) throw new Error('书籍文件为空。');
  if (file.size > 64 * 1024 * 1024) throw new Error('书籍文件超过 64 MB 导入上限。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  checkBookAbort(signal);
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const isPdf = header.includes('%PDF-');
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  const extension = file.name.split('.').pop()?.toLowerCase();
  const mime = file.type.toLowerCase().split(';')[0];
  if (isPdf) {
    if (extension === 'epub' || mime === 'application/epub+zip') {
      throw new Error('文件内容是 PDF，但扩展名或 MIME 类型标记为 EPUB。');
    }
    checkBookAbort(signal);
    const { importPdf } = await import('./bookPdf');
    return importPdf(bytes, file.name, signal);
  }
  if (isZip) {
    if (extension === 'pdf' || mime === 'application/pdf') {
      throw new Error('文件内容不是 PDF，与扩展名或 MIME 类型不符。');
    }
    checkBookAbort(signal);
    const { importEpub } = await import('./bookEpub');
    return importEpub(bytes, file.name, signal);
  }
  throw new Error('无法识别书籍内容。请选择有效的 PDF 或 EPUB 文件。');
}
