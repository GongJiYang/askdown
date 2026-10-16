import type { LanguageModel, LanguageModelUsage, TextPart } from 'ai';
import { contextSettings, missingConfig, modelName, priceKey, type AiTask, type Settings } from '../settings';
import { getFetch } from './transport';
import { anthropicCount, inputBudget, tokenCounter } from './tokens';
import { recordUsage, type UsageRecord } from './usage';
import { loadImageParts, stripImageData } from './images';

export interface StreamOptions {
  prompt: string;
  stablePrefix?: string;
  vault?: string | null;
  task?: AiTask;
  onNotice?: (message: string) => void;
  maxOutputTokens?: number;
  images?: string[];
  /** Structured demo output supplied by the action, independent of user templates. */
  demoText?: string;
  signal?: AbortSignal;
  /** 每次收到新内容时调用，参数是目前为止的完整文本 */
  onText?: (text: string) => void;
}


async function getModel(s: Settings): Promise<LanguageModel> {
  const fetchImpl = await getFetch();
  if (s.provider === 'anthropic') {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const anthropic = createAnthropic({
      apiKey: s.anthropic.apiKey.trim(),
      fetch: fetchImpl,
      // 浏览器开发模式下直连 Anthropic 需要这个头
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    return anthropic(s.anthropic.model.trim());
  }
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  const compat = createOpenAICompatible({
    name: s.compat.preset || 'custom',
    baseURL: s.compat.baseURL.trim().replace(/\/+$/, ''),
    apiKey: s.compat.apiKey.trim() || undefined,
    fetch: fetchImpl,
    includeUsage: true,
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
  const hasImages = !!opts.images?.length;
  if (s.provider === 'demo') {
    if (hasImages) throw new Error('演示模式不能识别图片。请在设置中连接支持图片输入的视觉模型。');
    return demoStream(opts);
  }

  const imageParts = hasImages ? await loadImageParts(opts.images!, opts.signal) : [];
  const prefix = stripImageData(opts.stablePrefix ?? '');
  const prompt = stripImageData(opts.prompt);
  const textParts: TextPart[] = [
    ...(prefix ? [{ type: 'text' as const, text: prefix,
      ...(s.provider === 'anthropic' && s.promptCache !== false ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } } : {}),
    }] : []),
    { type: 'text', text: prompt },
  ];
  const counter = await tokenCounter(s, opts.signal);
  const context = contextSettings(s);
  const maxOutputTokens = opts.maxOutputTokens ?? context.outputTokens;
  let count: number;
  if (s.provider === 'anthropic') {
    const imageContent = imageParts.map((part) => {
      let binary = '';
      for (const byte of part.image) binary += String.fromCharCode(byte);
      return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: btoa(binary) } };
    });
    count = await anthropicCount(s, [...textParts.map((part) => ({ type: 'text', text: part.text })), ...imageContent], opts.signal);
    if (count + maxOutputTokens > context.windowTokens) throw new Error('包含图片的请求超过模型 token 窗口，请减少附件或调整上下文设置。');
  } else {
    count = await counter.count(prefix + '\n\n' + prompt);
    if (count > inputBudget(s, imageParts.length)) throw new Error('请求超过模型 token 预算，请缩短选中内容或调整上下文窗口。');
  }
  const model = await getModel(s);
  const record: UsageRecord = {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), task: opts.task ?? 'test',
    provider: s.provider, model: modelName(s), inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, status: 'error',
  };
  let usage: LanguageModelUsage | undefined;
  let failure: unknown = null;
  let text = '';
  try {
    const { streamText } = await import('ai');
    const result = streamText({
      model, messages: [{ role: 'user', content: [...textParts, ...imageParts] }],
      maxOutputTokens, maxRetries: 0, abortSignal: opts.signal,
      onFinish: (event) => { usage = event.totalUsage; },
      onError: ({ error }: { error: unknown }) => { failure = error; },
    });
    for await (const delta of result.textStream) {
      text += delta;
      opts.onText?.(text);
    }
    if (!failure && !opts.signal?.aborted) usage = await result.totalUsage;
  } catch (err) {
    failure = failure ?? err;
  }
  record.status = opts.signal?.aborted ? 'aborted' : failure || !text.trim() ? 'error' : 'complete';
  const tokenValue = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (s.provider === 'openai-compatible') {
    // The compatibility SDK defaults missing counts to zero and does not normalize DeepSeek cache hits.
    const raw = usage?.raw;
    const details = raw?.prompt_tokens_details;
    const cached = details && typeof details === 'object' && 'cached_tokens' in details ? details.cached_tokens : undefined;
    record.inputTokens = tokenValue(raw?.prompt_tokens);
    record.outputTokens = tokenValue(raw?.completion_tokens);
    record.cacheReadTokens = tokenValue(raw?.prompt_cache_hit_tokens) ?? tokenValue(cached);
    // The OpenAI-compatible protocol has no separately billed cache creation field.
    record.cacheWriteTokens = record.inputTokens === null ? null : tokenValue(raw?.cache_creation_input_tokens) ?? 0;
  } else {
    record.inputTokens = tokenValue(usage?.inputTokens);
    record.outputTokens = tokenValue(usage?.outputTokens);
    record.cacheReadTokens = tokenValue(usage?.inputTokenDetails.cacheReadTokens);
    record.cacheWriteTokens = tokenValue(usage?.inputTokenDetails.cacheWriteTokens);
  }
  const price = s.pricing?.[priceKey(s)];
  if (price && record.inputTokens !== null && record.outputTokens !== null) {
    const read = record.cacheReadTokens ?? 0, write = record.cacheWriteTokens ?? 0;
    // Missing cache breakdown can change the bill; never imply a precise price for unknown usage.
    if (record.cacheReadTokens !== null && record.cacheWriteTokens !== null
      && read + write <= record.inputTokens && (read === 0 || price.cacheRead !== undefined)
      && (write === 0 || price.cacheWrite !== undefined)) {
      record.costUsd = (Math.max(0, record.inputTokens - read - write) * price.input
        + read * (price.cacheRead ?? 0) + write * (price.cacheWrite ?? 0) + record.outputTokens * price.output) / 1_000_000;
    }
  }
  record.note = `${counter.label}；${hasImages && s.provider !== 'anthropic' ? '图片预留预算为估计值；' : ''}${!usage ? '服务未返回用量，实际消耗未知。' : record.costUsd === null ? '缺少价格或缓存明细，费用未知。' : '费用按服务端用量与配置单价计算。'}`;
  try { await recordUsage(opts.vault ?? null, record); }
  catch { opts.onNotice?.('本次调用已结束，但用量记录保存失败；请检查文件库权限或用量账本。'); }
  if (opts.signal?.aborted) {
    const e = new Error('已停止'); e.name = 'AbortError'; throw e;
  }
  if (failure) throw new Error(describeError(failure) + (hasImages ? ' 图片请求失败，请确认模型和接口配置支持图片输入。' : ''));
  if (!text.trim()) throw new Error('模型没有返回内容，换个问法试试。');
  return text;
}

/** 演示模式：不调用任何模型，逐字吐出一段固定说明，用来体验界面。 */
async function demoStream(opts: StreamOptions): Promise<string> {
  const full = opts.demoText ?? '这是**演示模式**的回答：现在还没有连接模型，所以内容是固定的。\n\n打开右上角的「设置」，选择 Claude、DeepSeek、OpenAI 或本地 Ollama，填好 API Key 和模型名，回答就会根据你的文档和问题生成。';
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
