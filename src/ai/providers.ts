import { streamText, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { isTauri } from '../fs';
import { missingConfig, type Settings } from '../settings';

export interface StreamOptions {
  prompt: string;
  signal?: AbortSignal;
  /** 每次收到新内容时调用，参数是目前为止的完整文本 */
  onText?: (text: string) => void;
}

/**
 * 桌面端用 Tauri 的 HTTP 插件发请求（走 Rust，没有浏览器跨域限制）；
 * 浏览器开发模式下用普通 fetch。
 */
async function getFetch(): Promise<typeof fetch> {
  if (isTauri()) {
    const mod = await import('@tauri-apps/plugin-http');
    return mod.fetch as typeof fetch;
  }
  return window.fetch.bind(window);
}

async function getModel(s: Settings): Promise<LanguageModel> {
  const fetchImpl = await getFetch();
  if (s.provider === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: s.anthropic.apiKey.trim(),
      fetch: fetchImpl,
      // 浏览器开发模式下直连 Anthropic 需要这个头
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    return anthropic(s.anthropic.model.trim());
  }
  const compat = createOpenAICompatible({
    name: s.compat.preset || 'custom',
    baseURL: s.compat.baseURL.trim().replace(/\/+$/, ''),
    apiKey: s.compat.apiKey.trim() || undefined,
    fetch: fetchImpl,
  });
  return compat.chatModel(s.compat.model.trim());
}

/** 把底层错误翻译成用户看得懂的一句话。 */
export function describeError(err: unknown): string {
  const e = err as { name?: string; statusCode?: number; message?: string; responseBody?: string };
  if (e?.name === 'AbortError') return '已停止';
  const status = e?.statusCode;
  if (status === 401 || status === 403) return 'API Key 无效或没有权限，请在设置里检查。';
  if (status === 404) return '找不到这个模型或接口地址，请在设置里检查模型名和地址。';
  if (status === 429) return '请求太频繁或额度用完了，稍后再试。';
  if (status && status >= 500) return '模型服务暂时出错（' + status + '），稍后再试。';
  const msg = String(e?.message ?? err ?? '');
  if (/fetch|network|connect|ECONNREFUSED|Failed to/i.test(msg)) return '连不上模型服务，请检查网络或接口地址。' + (msg ? `（${msg.slice(0, 120)}）` : '');
  return msg ? msg.slice(0, 200) : '出了点问题，请重试。';
}

/** 流式调用模型，返回完整文本。出错时抛出 Error（message 已是中文说明）。 */
export async function streamCompletion(s: Settings, opts: StreamOptions): Promise<string> {
  const missing = missingConfig(s);
  if (missing) throw new Error(missing + '，请打开设置。');
  if (s.provider === 'demo') return demoStream(opts);

  const model = await getModel(s);
  let failure: unknown = null;
  const result = streamText({
    model,
    prompt: opts.prompt,
    abortSignal: opts.signal,
    onError: ({ error }: { error: unknown }) => {
      failure = error;
    },
  });
  let text = '';
  try {
    for await (const delta of result.textStream) {
      text += delta;
      opts.onText?.(text);
    }
  } catch (err) {
    failure = failure ?? err;
  }
  if (opts.signal?.aborted) {
    const e = new Error('已停止');
    e.name = 'AbortError';
    throw e;
  }
  if (failure) throw new Error(describeError(failure));
  if (!text.trim()) throw new Error('模型没有返回内容，换个问法试试。');
  return text;
}

/** 演示模式：不调用任何模型，逐字吐出一段固定说明，用来体验界面。 */
async function demoStream(opts: StreamOptions): Promise<string> {
  const isTidy = opts.prompt.includes('{{TIDY}}') || opts.prompt.includes('## 核心概念');
  const full = isTidy
    ? '## 核心概念\n\n- **演示模式**：现在没有连接任何模型，这里的内容是固定的示例。\n\n## 要点\n\n- 在设置里选择 Claude、DeepSeek、OpenAI 或本地 Ollama，填好 Key 和模型名，就能得到真实的整理结果。\n\n## 还没搞懂的\n\n- ?? 我应该选哪个模型？\n'
    : '这是**演示模式**的回答：现在还没有连接模型，所以内容是固定的。\n\n打开右上角的「设置」，选择 Claude、DeepSeek、OpenAI 或本地 Ollama，填好 API Key 和模型名，回答就会根据你的文档和问题生成。';
  let text = '';
  for (const ch of full) {
    if (opts.signal?.aborted) {
      const e = new Error('已停止');
      e.name = 'AbortError';
      throw e;
    }
    text += ch;
    opts.onText?.(text);
    await new Promise((r) => setTimeout(r, 12));
  }
  return text;
}
