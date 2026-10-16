import { Readability } from '@mozilla/readability';
import { fetch as desktopFetch } from '@tauri-apps/plugin-http';
import { isTauri } from '../fs';
import { htmlToMarkdown } from './html';
import type { ImportedMaterial } from './types';

/** Download a public web article directly; desktop requests bypass browser CORS restrictions. */
export async function importWeb(url: string, signal?: AbortSignal): Promise<ImportedMaterial> {
  signal?.throwIfAborted();
  let requested: URL;
  try {
    requested = new URL(url.trim());
  } catch {
    throw new Error('请输入完整的 http:// 或 https:// 网页地址。');
  }
  if (!['http:', 'https:'].includes(requested.protocol)) {
    throw new Error('网页导入仅支持 http:// 和 https:// 地址。');
  }
  const desktop = isTauri();
  let response: Response;
  let html: string;
  try {
    const fetchImpl = desktop ? desktopFetch : window.fetch.bind(window);
    signal?.throwIfAborted();
    response = await fetchImpl(requested.href, {
      signal,
      headers: { Accept: 'text/html, application/xhtml+xml' },
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(desktop
      ? `网页下载失败，请检查网络、网址及桌面 HTTP 访问权限。${detail ? `（${detail}）` : ''}`
      : '网页下载失败：浏览器跨域（CORS）限制或网络错误。若网站未允许跨域访问，请使用桌面版导入；不会使用第三方代理。');
  }
  signal?.throwIfAborted();
  if (!response.ok) {
    throw new Error(`网页下载失败：HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}。${response.status === 401 || response.status === 403 ? '网站要求登录或拒绝访问。' : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)) {
    throw new Error(`此地址返回的不是 HTML 网页（${contentType}）。PDF 或 EPUB 请使用文件导入。`);
  }
  try {
    // Respect declared legacy encodings, which are still common in older articles.
    const bytes = await response.arrayBuffer();
    signal?.throwIfAborted();
    const charset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ?? 'utf-8';
    try {
      html = new TextDecoder(charset).decode(bytes);
    } catch {
      html = new TextDecoder().decode(bytes);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error('网页内容下载中断，请检查网络后重新导入。');
  }
  const source = new URL(response.url || requested.href);
  if (!['http:', 'https:'].includes(source.protocol)) throw new Error('网页重定向到了不支持的地址。');
  const document = new DOMParser().parseFromString(html, 'text/html');
  // Resolve all article-relative links against the actual downloaded page, not our app URL.
  document.querySelectorAll('base').forEach((element) => element.remove());
  const base = document.createElement('base');
  base.href = source.href;
  document.head.prepend(base);
  document.querySelectorAll('script,style,iframe,object,embed,form,template').forEach((element) => element.remove());
  const fallbackTitle = document.title.trim() || source.hostname;
  let article;
  try {
    article = new Readability(document, { disableJSONLD: true }).parse();
  } catch {
    throw new Error('无法解析此网页的正文。网站可能需要 JavaScript、登录或使用了不支持的页面结构。');
  }
  signal?.throwIfAborted();
  if (!article?.content || !article.textContent?.trim()) {
    throw new Error('未找到可阅读的网页正文。网站可能需要 JavaScript 或登录；请尝试文章的公开直达链接。');
  }
  const body = htmlToMarkdown(article.content, source.href);
  if (!body.trim()) throw new Error('此网页没有可导入的正文。');
  const title = (article.title?.trim() || fallbackTitle).replace(/\s+/g, ' ');
  const heading = document.createElement('h1');
  heading.textContent = title;
  const provenance = document.createElement('p');
  provenance.append('来源：');
  const link = document.createElement('a');
  link.href = source.href;
  link.textContent = source.href;
  provenance.append(link);
  const header = htmlToMarkdown(heading.outerHTML + provenance.outerHTML, source.href);
  signal?.throwIfAborted();
  return {
    title,
    markdown: `${header}\n\n${body}\n`,
    kind: 'web',
    source: source.href,
    warnings: ['仅导入服务器返回的文章正文；需要 JavaScript 或登录后显示的内容可能缺失。', ...(body.includes('![') ? ['网页图片保留原站链接，离线或原站限制访问时可能无法显示。'] : [])],
  };
}
