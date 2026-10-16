import { contextSettings, modelName, type Settings } from '../settings';
import { getFetch } from './transport';

export interface TokenCounter {
  label: string;
  count(text: string): Promise<number>;
}
const encoders = new Map<string, Promise<(text: string) => number>>();

export async function anthropicCount(s: Settings, content: unknown[], signal?: AbortSignal): Promise<number> {
  const response = await (await getFetch())('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': s.anthropic.apiKey.trim(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: modelName(s), messages: [{ role: 'user', content }] }),
  });
  if (!response.ok) throw new Error(`Claude token 计数失败（HTTP ${response.status}），未发送生成请求。`);
  const data = await response.json();
  if (!Number.isSafeInteger(data.input_tokens) || data.input_tokens < 0) throw new Error('Claude 未返回有效的 token 计数。');
  return data.input_tokens;
}

export async function tokenCounter(s: Settings, signal?: AbortSignal): Promise<TokenCounter> {
  if (s.provider === 'anthropic') return { label: 'Claude 官方计数', count: (text) => anthropicCount(s, [{ type: 'text', text: text || ' ' }], signal) };
  const context = contextSettings(s);
  const model = modelName(s);
  const encoding = context.tokenizer !== 'auto' ? context.tokenizer
    : /^(gpt-4o|gpt-4\.1|gpt-5|o[134])(?:[-.]|$)/i.test(model) ? 'o200k_base'
    : /^(gpt-4|gpt-3\.5)(?:[-.]|$)/i.test(model) ? 'cl100k_base' : null;
  const url = context.tokenizerUrl.trim();
  const key = url || encoding;
  if (!key) return {
    label: '未知 tokenizer：UTF-8 字节保守预算（非实际 token）',
    count: async (text) => new TextEncoder().encode(text).length,
  };
  let encoder = encoders.get(key);
  if (!encoder) {
    encoder = (async () => {
      if (url) {
        const response = await (await getFetch())(url, { signal });
        if (!response.ok) throw new Error(`Tokenizer 下载失败（HTTP ${response.status}）。`);
        const { Tokenizer } = await import('@huggingface/tokenizers');
        const tokenizer = new Tokenizer(await response.json(), {});
        return (text: string) => tokenizer.encode(text, { add_special_tokens: false }).ids.length;
      }
      const [{ Tiktoken }, { default: ranks }] = await Promise.all([
        import('js-tiktoken/lite'),
        encoding === 'o200k_base' ? import('js-tiktoken/ranks/o200k_base') : import('js-tiktoken/ranks/cl100k_base'),
      ]);
      const tokenizer = new Tiktoken(ranks);
      return (text: string) => tokenizer.encode(text, [], []).length;
    })();
    encoders.set(key, encoder);
    encoder.catch(() => encoders.delete(key));
  }
  const count = await encoder;
  signal?.throwIfAborted();
  return { label: url ? '自定义模型 tokenizer（消息包装另留余量）' : `${encoding}（消息包装另留余量）`, count: async (text) => count(text) };
}

export function inputBudget(s: Settings, images = 0): number {
  const context = contextSettings(s);
  // Vision accounting varies across compatible providers; final Claude calls count image bytes officially.
  return context.windowTokens - context.outputTokens - 256 - images * 4096;
}

/** Split on Unicode code points and count every candidate; no character/token ratio or discarded tail. */
export async function splitTokens(text: string, limit: number, counter: TokenCounter, signal?: AbortSignal): Promise<string[]> {
  if (limit < 1) throw new Error('上下文预算不足，请增大窗口或减少输出预算。');
  const points = Array.from(text);
  const chunks: string[] = [];
  let start = 0;
  while (start < points.length) {
    signal?.throwIfAborted();
    let low = 1, high = points.length - start, best = 0;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      if (await counter.count(points.slice(start, start + size).join('')) <= limit) { best = size; low = size + 1; }
      else high = size - 1;
    }
    if (!best) throw new Error('单个字符超过可用 token 预算，请调整窗口。');
    chunks.push(points.slice(start, start + best).join(''));
    start += best;
  }
  return chunks;
}
