import { GlobalWorkerOptions, getDocument, OPS, AnnotationMode } from 'pdfjs-dist';
import type { PDFDocumentProxy, TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { bookTitle, checkBookAbort, markdownText } from './books';
import type { ImportedMaterial } from './types';

GlobalWorkerOptions.workerSrc = workerUrl;

interface TextLine {
  text: string;
  x: number;
  y: number;
  end: number;
  height: number;
}

function pageMarkdown(items: TextItem[]): string {
  const lines: TextLine[] = [];
  let line: TextLine | undefined;
  const sizes = new Map<number, number>();
  for (const item of items) {
    if (!item.str.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const height = Math.max(1, Math.hypot(item.transform[2], item.transform[3]) || item.height);
    const size = Math.round(height);
    sizes.set(size, (sizes.get(size) ?? 0) + item.str.length);
    if (!line || Math.abs(y - line.y) > Math.max(height, line.height) * 0.35 || x < line.x - height) {
      line = { text: item.str, x, y, end: x + item.width, height };
      lines.push(line);
    } else {
      const separator = x - line.end > height * 0.15 && !/\s$/.test(line.text) && !/^\s/.test(item.str) ? ' ' : '';
      line.text += separator + item.str;
      line.end = x + item.width;
      line.height = Math.max(line.height, height);
    }
    if (item.hasEOL) line = undefined;
  }
  const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12;
  const blocks: string[] = [];
  let paragraph = '';
  let previous: TextLine | undefined;
  for (const current of lines) {
    const text = current.text.trim();
    const heading = text.length <= 160 && (
      current.height >= bodySize * 1.25 || /^(?:chapter\s+\w+|第[一二三四五六七八九十百千零\d]+[章节篇部])(?:\s|[：:.、]|$)/i.test(text)
    );
    const gap = previous ? Math.abs(current.y - previous.y) : 0;
    const paragraphBreak = previous && (gap > Math.max(current.height, previous.height) * 1.65
      || current.y > previous.y + current.height || Math.abs(current.x - previous.x) > bodySize * 2.5);
    if ((heading || paragraphBreak) && paragraph) {
      blocks.push(paragraph);
      paragraph = '';
    }
    if (heading) {
      blocks.push(`### ${markdownText(text)}`);
      previous = undefined;
    } else {
      // Preserve CJK line flow without introducing artificial spaces.
      const separator = paragraph && !/[\u3000-\u9fff]$/.test(paragraph) && !/^[\u3000-\u9fff]/.test(text) ? ' ' : '';
      paragraph += separator + markdownText(text);
      previous = current;
    }
  }
  if (paragraph) blocks.push(paragraph);
  return blocks.join('\n\n');
}

async function chapterHeadings(pdf: PDFDocumentProxy, signal?: AbortSignal): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  const outline = await pdf.getOutline();
  if (!outline) return result;
  const queue = outline.map(item => ({ item, depth: 2 }));
  let count = 0;
  for (let index = 0; index < queue.length; index++) {
    checkBookAbort(signal);
    if (++count > 4000) break;
    const { item, depth } = queue[index];
    let destination = item.dest;
    try {
      if (typeof destination === 'string') destination = await pdf.getDestination(destination);
      if (Array.isArray(destination) && destination[0] != null) {
        const target = destination[0];
        const page = typeof target === 'number' ? target + 1 : await pdf.getPageIndex(target) + 1;
        if (page >= 1 && page <= pdf.numPages && item.title.trim()) {
          const headings = result.get(page) ?? [];
          headings.push(`${'#'.repeat(Math.min(depth, 5))} ${markdownText(item.title.trim())}`);
          result.set(page, headings);
        }
      }
    } catch {
      checkBookAbort(signal);
      // A broken bookmark does not invalidate otherwise readable page content.
    }
    if (depth < 16) queue.push(...item.items.slice(0, 4000 - queue.length).map(child => ({ item: child, depth: depth + 1 })));
  }
  return result;
}

export async function importPdf(bytes: Uint8Array, filename: string, signal?: AbortSignal): Promise<ImportedMaterial> {
  checkBookAbort(signal);
  const assetRoot = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
  const loading = getDocument({
    data: bytes,
    cMapUrl: `${assetRoot}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetRoot}standard_fonts/`,
    wasmUrl: `${assetRoot}wasm/`,
    iccUrl: `${assetRoot}iccs/`,
    useWorkerFetch: true,
    enableXfa: false,
    maxImageSize: 32 * 1024 * 1024,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
  });
  const abort = () => { void loading.destroy().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  const warnings = new Set<string>(['PDF 文字按页面位置重建段落；多栏、表格、公式及阅读顺序可能与原版不同。']);
  let scannedPages = 0;
  let previewCount = 0;
  let previewBytes = 0;
  let textLength = 0;
  try {
    const pdf = await loading.promise;
    checkBookAbort(signal);
    if (pdf.numPages > 1000) throw new Error('PDF 超过 1000 页导入上限，请拆分后重试。');
    const { info } = await pdf.getMetadata();
    const metadata = info as { Title?: unknown; EncryptFilterName?: unknown };
    if (metadata.EncryptFilterName) throw new Error('无法导入加密或受 DRM 保护的 PDF，请提供未加密版本。');
    const title = typeof metadata.Title === 'string' && metadata.Title.trim() ? metadata.Title.trim() : bookTitle(filename);
    const headings = await chapterHeadings(pdf, signal);
    const sections = [`# ${markdownText(title)}`];
    for (let number = 1; number <= pdf.numPages; number++) {
      checkBookAbort(signal);
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        checkBookAbort(signal);
        const items = content.items.filter((item): item is TextItem => 'str' in item);
        const text = pageMarkdown(items);
        textLength += text.length;
        if (textLength > 20 * 1024 * 1024) throw new Error('PDF 提取文字超过 20 MB 上限，请拆分后重试。');
        const chapters = headings.get(number);
        if (chapters) sections.push(...chapters);
        sections.push(`### 第 ${number} 页`);
        if (text) sections.push(text);
        const scanned = !items.some(item => item.str.trim());
        if (scanned) scannedPages++;
        const operators = await page.getOperatorList();
        checkBookAbort(signal);
        const hasGraphics = operators.fnArray.some(operation => operation === OPS.paintImageXObject
          || operation === OPS.paintInlineImageXObject || operation === OPS.paintImageMaskXObject
          || operation === OPS.paintImageXObjectRepeat || operation === OPS.paintInlineImageXObjectGroup
          || operation === OPS.paintImageMaskXObjectGroup || operation === OPS.constructPath
          || operation === OPS.shadingFill);
        if (scanned || hasGraphics) {
          if (previewCount >= 80 || previewBytes >= 24 * 1024 * 1024) {
            warnings.add('为限制文件大小，仅保存最多 80 张页面预览，预览总量不超过 24 MB；部分图表或扫描页未嵌入。');
            continue;
          }
          const viewport = page.getViewport({ scale: 1 });
          const scale = Math.min(2, 1600 / Math.max(viewport.width, viewport.height));
          const preview = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(preview.width));
          canvas.height = Math.max(1, Math.ceil(preview.height));
          const render = page.render({ canvas, viewport: preview, background: 'rgb(255,255,255)', annotationMode: AnnotationMode.DISABLE });
          const cancelRender = () => render.cancel();
          signal?.addEventListener('abort', cancelRender, { once: true });
          try {
            await render.promise;
            checkBookAbort(signal);
            const image = canvas.toDataURL('image/jpeg', 0.8);
            if (previewBytes + image.length <= 24 * 1024 * 1024) {
              sections.push(`![第 ${number} 页原始页面预览](${image})`);
              previewBytes += image.length;
              previewCount++;
            } else {
              warnings.add('页面预览达到 24 MB 上限；部分图表或扫描页未嵌入。');
            }
          } catch {
            checkBookAbort(signal);
            warnings.add(`第 ${number} 页预览渲染失败；已保留可提取文字。`);
          } finally {
            signal?.removeEventListener('abort', cancelRender);
            canvas.width = canvas.height = 0;
          }
        }
      } finally {
        page.cleanup();
      }
    }
    if (scannedPages) warnings.add(`${scannedPages} 页没有可提取文字，可能是扫描页。本次未执行 OCR；可通过原始页面预览进行图片提问。`);
    checkBookAbort(signal);
    return { title, markdown: sections.join('\n\n') + '\n', kind: 'pdf', source: filename, warnings: [...warnings] };
  } catch (error) {
    checkBookAbort(signal);
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new Error('无法导入加密或受 DRM 保护的 PDF，请提供未加密版本。');
    }
    if (error instanceof Error && error.name === 'InvalidPDFException') throw new Error('PDF 文件无效或已损坏。');
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await loading.destroy();
  }
}
