import { isTauri } from '../fs';
import { fetch as desktopFetch } from '@tauri-apps/plugin-http';

/** Keep image attachments portable; local/blob URLs cannot survive a reload. */
export function normalizeImageSource(source: string): string {
  const value = source.trim();
  const data = /^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/]*={0,2})$/i.exec(value);
  if (data && data[2] && data[2].length % 4 !== 1) {
    return `data:image/${/^jpe?g$/i.test(data[1]) ? 'jpeg' : data[1].toLowerCase()};base64,${data[2]}`;
  }
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch { /* Report invalid or nonportable image sources below. */ }
  throw new Error('图片地址无效：请使用 PNG、JPEG、WebP、GIF 的 data URL 或 HTTP(S) 图片地址。');
}

/** Never spend text context on embedded image payloads or attachment metadata. */
export function stripImageData(text: string): string {
  return text.replace(/<!--\s*askdown:question\s+\S+\s*-->/g, '')
    .replace(/data:image\/[^\s<>"')\]]+/gi, '[图片附件]');
}

function imageMediaType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  throw new Error('图片内容不是支持的 PNG、JPEG、WebP 或 GIF，或图片下载地址返回了登录页。');
}

/** Resolve bytes ourselves so the SDK never downloads images with its default fetch. */
export async function loadImageParts(sources: string[], signal?: AbortSignal) {
  const fetchImage = isTauri() ? desktopFetch : globalThis.fetch.bind(globalThis);
  const parts: { type: 'image'; image: Uint8Array; mediaType: string }[] = [];
  for (const source of new Set(sources.map(normalizeImageSource))) {
    signal?.throwIfAborted();
    let bytes: Uint8Array;
    if (source.startsWith('data:')) {
      try {
        bytes = Uint8Array.from(atob(source.slice(source.indexOf(',') + 1)), (character) => character.charCodeAt(0));
      } catch {
        throw new Error('图片附件的 base64 数据无效，请重新导入图片。');
      }
    } else {
      try {
        const response = await fetchImage(source, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`无法下载图片（${new URL(source).hostname}）：${error instanceof Error ? error.message : '网络错误'}。请检查图片访问权限或重新导入。`);
      }
    }
    signal?.throwIfAborted();
    parts.push({ type: 'image', image: bytes, mediaType: imageMediaType(bytes) });
  }
  return parts;
}
