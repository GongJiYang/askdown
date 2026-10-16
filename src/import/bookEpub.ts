import { unzip, strFromU8 } from 'fflate';
import type { Unzipped } from 'fflate';
import { htmlToMarkdown } from './html';
import { bookTitle, checkBookAbort, markdownText } from './books';
import type { ImportedMaterial } from './types';

const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_ENTRY = 16 * 1024 * 1024;

function archivePath(reference: string, from = ''): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!decoded || /[\\\u0000-\u001f]/.test(decoded) || /^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith('/')) return null;
  const segments = from ? from.split('/').slice(0, -1) : [];
  for (const segment of decoded.split('/')) {
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
    } else if (segment && segment !== '.') segments.push(segment);
  }
  return segments.join('/') || null;
}

function validateZip(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('EPUB ZIP 目录无效或文件已损坏。');
  const entries = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let cursor = view.getUint32(end + 16, true);
  const directoryEnd = cursor + directorySize;
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || entries !== view.getUint16(end + 8, true)
    || (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50)
    || entries === 65535 || entries > 4000 || directoryEnd > end) throw new Error('EPUB 不支持分卷、ZIP64 或超过 4000 个文件的压缩包。');
  let total = 0;
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('EPUB ZIP 文件目录损坏。');
    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const expanded = view.getUint32(cursor + 24, true);
    const local = view.getUint32(cursor + 42, true);
    if (flags & 1) throw new Error('无法导入加密或受 DRM 保护的 EPUB。');
    if (compression !== 0 && compression !== 8) throw new Error('EPUB 使用了不支持的 ZIP 压缩方式。');
    if (compression === 0 && compressed !== expanded) throw new Error('EPUB 未压缩文件的长度不一致。');
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error('EPUB ZIP 文件头损坏。');
    if (view.getUint16(local + 6, true) & 1) throw new Error('无法导入加密或受 DRM 保护的 EPUB。');
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (dataStart + compressed > bytes.length) throw new Error('EPUB ZIP 文件数据不完整。');
    total += expanded;
    if (expanded > MAX_ENTRY || total > MAX_EXPANDED || (expanded > 1024 * 1024 && expanded > Math.max(1, compressed) * 300)) {
      throw new Error('EPUB 解压资源超过安全上限（单文件 16 MB、总计 128 MB 或压缩比 300:1）。');
    }
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  if (cursor !== directoryEnd) throw new Error('EPUB ZIP 文件目录长度无效。');
}

async function openArchive(bytes: Uint8Array, signal?: AbortSignal): Promise<Unzipped> {
  validateZip(bytes);
  checkBookAbort(signal);
  // The app targets ES2022, where Promise.withResolvers is not available.
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminate: (() => void) | undefined;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      terminate?.();
      reject(new DOMException('导入已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      terminate = unzip(bytes, {
        filter: entry => {
          checkBookAbort(signal);
          // ZIP entry names must already be root-relative and canonical.
          return !entry.name.endsWith('/') && entry.name !== '__proto__'
            && archivePath(entry.name) === entry.name;
        },
      }, (error, files) => {
        signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        if (error) reject(new Error(`EPUB 解压失败：${error.message}`));
        else resolve(files);
      });
    } catch (error) {
      signal?.removeEventListener('abort', onAbort);
      if (!settled) { settled = true; reject(error); }
    }
  });
}

function xmlFile(files: Unzipped, path: string): Document {
  const data = files[path];
  if (!data) throw new Error(`EPUB 缺少文件：${path}`);
  if (data.length > 8 * 1024 * 1024) throw new Error(`EPUB XML/章节超过 8 MB 上限：${path}`);
  const xml = strFromU8(data);
  if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) throw new Error('EPUB 含不支持的 XML 实体声明。');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new Error(`EPUB XML 文件无效：${path}`);
  return document;
}

function rasterMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && strFromU8(bytes.subarray(1, 4)) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(strFromU8(bytes.subarray(0, 6)))) return 'image/gif';
  if (bytes.length >= 12 && strFromU8(bytes.subarray(0, 4)) === 'RIFF' && strFromU8(bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export async function importEpub(bytes: Uint8Array, filename: string, signal?: AbortSignal): Promise<ImportedMaterial> {
  const files = await openArchive(bytes, signal);
  checkBookAbort(signal);
  if (!files.mimetype || strFromU8(files.mimetype).trim() !== 'application/epub+zip') throw new Error('压缩包不是有效的 EPUB（缺少 EPUB mimetype）。');
  const warnings = new Set<string>();
  if (files['META-INF/encryption.xml']) {
    const encryption = xmlFile(files, 'META-INF/encryption.xml');
    const methods = [...encryption.getElementsByTagNameNS('*', 'EncryptionMethod')];
    if (!methods.length || methods.some(method => !['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(method.getAttribute('Algorithm') ?? ''))) {
      throw new Error('无法导入加密或受 DRM 保护的 EPUB，请提供无 DRM 版本。');
    }
    warnings.add('EPUB 使用字体混淆；导入使用阅读器字体，原书字体未保留。');
  }
  const container = xmlFile(files, 'META-INF/container.xml');
  const roots = [...container.getElementsByTagNameNS('*', 'rootfile')];
  const root = roots.find(element => element.getAttribute('media-type') === 'application/oebps-package+xml') ?? roots[0];
  const packagePath = archivePath(root?.getAttribute('full-path') ?? '');
  if (!packagePath) throw new Error('EPUB container.xml 缺少有效 OPF 路径。');
  const opf = xmlFile(files, packagePath);
  const title = [...opf.getElementsByTagNameNS('*', 'title')].map(element => element.textContent?.trim()).find(Boolean) || bookTitle(filename);
  const manifest = new Map<string, { path: string; media: string; properties: string }>();
  for (const item of opf.getElementsByTagNameNS('*', 'item')) {
    const id = item.getAttribute('id');
    const path = archivePath(item.getAttribute('href') ?? '', packagePath);
    if (id && path) manifest.set(id, { path, media: item.getAttribute('media-type') ?? '', properties: item.getAttribute('properties') ?? '' });
  }
  const spine = [...opf.getElementsByTagNameNS('*', 'itemref')].map(item => {
    const id = item.getAttribute('idref') ?? '';
    const entry = manifest.get(id);
    if (!entry) throw new Error(`EPUB 阅读顺序引用了不存在的章节：${id}`);
    if (!['application/xhtml+xml', 'text/html'].includes(entry.media)) throw new Error(`EPUB 章节格式不受支持：${entry.media}`);
    return entry;
  });
  if (!spine.length || spine.length > 1000) throw new Error('EPUB 必须包含 1–1000 个阅读章节。');
  const chapterAnchors = new Map(spine.map((entry, index) => [entry.path, `chapter-${index + 1}`]));
  const tocTitles = new Map<string, string>();
  for (const entry of manifest.values()) {
    if (entry.properties.split(/\s+/).includes('nav')) {
      const nav = xmlFile(files, entry.path);
      for (const link of nav.getElementsByTagNameNS('*', 'a')) {
        const target = archivePath(link.getAttribute('href') ?? '', entry.path);
        if (target && !tocTitles.has(target) && link.textContent?.trim()) tocTitles.set(target, link.textContent.trim());
      }
    } else if (entry.media === 'application/x-dtbncx+xml') {
      const ncx = xmlFile(files, entry.path);
      for (const point of ncx.getElementsByTagNameNS('*', 'navPoint')) {
        const source = point.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
        const label = point.getElementsByTagNameNS('*', 'navLabel')[0]?.textContent?.trim();
        const target = archivePath(source ?? '', entry.path);
        if (target && label && !tocTitles.has(target)) tocTitles.set(target, label);
      }
    }
  }
  const images = new Map<string, string>();
  let imageBytes = 0;
  let outputLength = 0;
  const sections = [`# ${markdownText(title)}`];
  for (let index = 0; index < spine.length; index++) {
    checkBookAbort(signal);
    const entry = spine[index];
    const chapter = xmlFile(files, entry.path);
    for (const element of chapter.querySelectorAll('script, style, iframe, object, embed, form, base, link, meta, audio, video')) element.remove();
    // EPUB cover pages often wrap a real raster image in an SVG viewport.
    for (const svg of chapter.getElementsByTagNameNS('*', 'svg')) {
      const embedded = [...svg.getElementsByTagNameNS('*', 'image')];
      for (const image of embedded) {
        const img = chapter.createElementNS('http://www.w3.org/1999/xhtml', 'img');
        img.setAttribute('src', image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '');
        img.setAttribute('alt', svg.getElementsByTagNameNS('*', 'title')[0]?.textContent ?? '书中插图');
        svg.parentNode?.insertBefore(img, svg);
      }
      if (!embedded.length) warnings.add('EPUB 中的矢量 SVG 插图未嵌入；已保留 PNG、JPEG、GIF 和 WebP 插图。');
    }
    for (const svg of [...chapter.getElementsByTagNameNS('*', 'svg')]) svg.remove();
    for (const image of chapter.getElementsByTagNameNS('*', 'img')) {
      const source = image.getAttribute('src') ?? '';
      const path = archivePath(source, entry.path);
      let dataUri = path ? images.get(path) : undefined;
      const data = path ? files[path] : undefined;
      if (!dataUri && path && data) {
        const mime = rasterMime(data);
        if (mime && imageBytes + Math.ceil(data.length / 3) * 4 <= 24 * 1024 * 1024) {
          let binary = '';
          for (let offset = 0; offset < data.length; offset += 16384) binary += String.fromCharCode(...data.subarray(offset, offset + 16384));
          dataUri = `data:${mime};base64,${btoa(binary)}`;
          images.set(path, dataUri);
          imageBytes += dataUri.length;
        }
      }
      image.removeAttribute('srcset');
      if (dataUri) image.setAttribute('src', dataUri);
      else {
        image.removeAttribute('src');
        warnings.add('部分 EPUB 插图无法嵌入（缺失、外部链接、不支持的格式或超过 24 MB 图片上限）。');
      }
    }
    for (const link of chapter.getElementsByTagNameNS('*', 'a')) {
      const href = link.getAttribute('href');
      if (!href || /^(?:https?:|mailto:)/i.test(href)) continue;
      const target = href.startsWith('#') ? entry.path : archivePath(href, entry.path);
      const anchor = target ? chapterAnchors.get(target) : undefined;
      if (anchor) {
        link.setAttribute('href', `#${anchor}`);
        if (href.includes('#')) warnings.add('EPUB 内部链接已指向对应章节开头；段落级锚点未保留。');
      } else link.removeAttribute('href');
    }
    const heading = chapter.querySelector('h1, h2, h3')?.textContent?.trim();
    const chapterTitle = heading || tocTitles.get(entry.path) || chapter.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || `第 ${index + 1} 章`;
    const body = chapter.getElementsByTagNameNS('*', 'body')[0];
    if (!body) throw new Error(`EPUB 章节缺少正文：${entry.path}`);
    const html = new XMLSerializer().serializeToString(body);
    const markdown = htmlToMarkdown(html);
    const section = `<a id="chapter-${index + 1}"></a>\n\n## ${markdownText(chapterTitle)}\n\n${markdown}`;
    outputLength += section.length;
    if (outputLength > 48 * 1024 * 1024) throw new Error('EPUB 导入内容超过 48 MB 上限，请拆分后重试。');
    sections.push(section);
    // Let the dialog process cancellation between chapters.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  checkBookAbort(signal);
  return { title, markdown: sections.join('\n\n') + '\n', kind: 'epub', source: filename, warnings: [...warnings] };
}
