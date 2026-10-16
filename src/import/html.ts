import TurndownService from 'turndown';

const ACTIVE_ELEMENTS = 'script,style,noscript,iframe,frame,frameset,object,embed,applet,form,input,button,textarea,select,option,svg,math,canvas,video,audio,base,link,meta,template';

function safeUrl(value: string | null, baseUrl: string | undefined, image: boolean): string | null {
  const raw = value?.trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (image && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/]+={0,2}$/i.test(raw)) return raw;
  if (!image && raw.startsWith('#')) return raw;
  try {
    const url = new URL(raw, baseUrl ?? 'https://import.invalid/');
    if (!['http:', 'https:', ...(!image ? ['mailto:'] : [])].includes(url.protocol)) return null;
    if (!baseUrl && !/^[a-z][a-z\d+.-]*:/i.test(raw)) {
      if (raw.startsWith('//')) return new URL(`https:${raw}`).href;
      return image ? null : raw;
    }
    return url.href;
  } catch {
    return null;
  }
}

function srcsetCandidates(value: string | null): string[] {
  if (!value) return [];
  // A data URL is already a complete image; its comma is not a candidate separator.
  if (value.trim().startsWith('data:')) return [value.trim().replace(/\s+[\d.]+[wx]\s*$/, '')];
  return value.split(',').map((candidate) => {
    const [url, descriptor = '1x'] = candidate.trim().split(/\s+/);
    return { url, size: Number.parseFloat(descriptor) || 1 };
  }).sort((a, b) => b.size - a.size).map(({ url }) => url);
}

function imageUrl(image: Element, baseUrl?: string): string | null {
  const picture = image.closest('picture');
  const candidates = [
    image.getAttribute('data-src'),
    image.getAttribute('data-original'),
    image.getAttribute('data-lazy-src'),
    image.getAttribute('data-url'),
    ...srcsetCandidates(image.getAttribute('data-srcset')),
    ...srcsetCandidates(image.getAttribute('srcset')),
    ...(picture ? Array.from(picture.querySelectorAll('source')).flatMap((source) => srcsetCandidates(source.getAttribute('srcset'))) : []),
    image.getAttribute('src'),
  ];
  for (const candidate of candidates) {
    const url = safeUrl(candidate, baseUrl, true);
    if (url) return url;
  }
  return null;
}

/** Convert imported HTML to inert Markdown, resolving web assets or retaining embedded book images. */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html');
  document.querySelectorAll(ACTIVE_ELEMENTS).forEach((element) => element.remove());
  for (const image of document.querySelectorAll('img')) {
    const url = imageUrl(image, baseUrl);
    if (url) image.setAttribute('src', url);
    else image.remove();
  }
  document.querySelectorAll('source').forEach((element) => element.remove());
  for (const element of document.body.querySelectorAll('*')) {
    if (element.tagName === 'A') {
      const href = safeUrl(element.getAttribute('href'), baseUrl, false);
      if (href) element.setAttribute('href', href);
      else element.removeAttribute('href');
    }
    for (const attribute of Array.from(element.attributes)) {
      const allowed = (element.tagName === 'A' && attribute.name === 'href')
        || (element.tagName === 'IMG' && ['src', 'alt'].includes(attribute.name))
        || (element.tagName === 'OL' && attribute.name === 'start' && /^\d+$/.test(attribute.value));
      if (!allowed) element.removeAttribute(attribute.name);
    }
  }

  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  const escape = converter.escape.bind(converter);
  // Entity-encoded HTML in source text must remain text after Markdown rendering.
  converter.escape = (text) => escape(text).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const destination = (url: string) => url.replace(/[<>\s()\\]/g, (character) => encodeURIComponent(character).replace(/\(/g, '%28').replace(/\)/g, '%29'));
  converter.addRule('safe-link', {
    filter: 'a',
    replacement: (content, node) => {
      const href = node.getAttribute('href');
      return href ? `[${content}](${destination(href)})` : content;
    },
  });
  converter.addRule('safe-image', {
    filter: 'img',
    replacement: (_content, node) => {
      const src = node.getAttribute('src');
      const alt = converter.escape((node.getAttribute('alt') ?? '').replace(/\s+/g, ' '));
      return src ? `![${alt}](${destination(src)})` : '';
    },
  });
  converter.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = node as HTMLTableElement;
      const rows = Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) =>
        converter.turndown(cell.innerHTML).replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').trim(),
      ));
      const width = Math.max(0, ...rows.map((row) => row.length));
      if (!width) return '';
      const render = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`;
      const caption = table.caption ? converter.turndown(table.caption.innerHTML) : '';
      const hasHeader = Array.from(table.rows[0].cells).some((cell) => cell.tagName === 'TH');
      const header = hasHeader ? rows.shift()! : Array<string>(width).fill('');
      return `\n\n${caption ? `${caption}\n\n` : ''}${[render(header), render(Array<string>(width).fill('---')), ...rows.map(render)].join('\n')}\n\n`;
    },
  });
  return converter.turndown(document.body).trim();
}
