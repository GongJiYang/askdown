import { getFs } from './fs';

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'demo';

export type AiTask = 'ask' | 'tidy' | 'summary' | 'test';

/** USD per million tokens. An absent entry/rate means unknown. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface SearchSettings {
  enabled: boolean;
  provider: 'brave' | 'searxng';
  baseURL: string;
  apiKey: string;
  maxResults: number;
}

export interface ContextSettings {
  windowTokens: number;
  outputTokens: number;
  tokenizer: 'auto' | 'cl100k_base' | 'o200k_base';
  tokenizerUrl: string;
}

export const DEFAULT_CONTEXT: ContextSettings = {
  windowTokens: 32768, outputTokens: 2048, tokenizer: 'auto', tokenizerUrl: '',
};

export const DEFAULT_SEARCH: SearchSettings = {
  enabled: false, provider: 'brave', baseURL: 'https://api.search.brave.com/res/v1/web/search',
  apiKey: '', maxResults: 5,
};

export interface CompatPreset {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  needsKey: boolean;
}

/** OpenAI 兼容接口的常用预设。模型名会过时，用户可以随时改。 */
export const COMPAT_PRESETS: CompatPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: '', needsKey: true },
  { id: 'ollama', label: 'Ollama（本地模型）', baseURL: 'http://localhost:11434/v1', model: '', needsKey: false },
  { id: 'custom', label: '自定义', baseURL: '', model: '', needsKey: true },
];

export interface Settings {
  provider: ProviderKind;
  anthropic: { apiKey: string; model: string };
  compat: { preset: string; baseURL: string; apiKey: string; model: string };
  lastVault?: string;
  lastFile?: string;
  showNotes: boolean;
  qaMode: 'inline' | 'margin';
  taskModels?: Partial<Record<AiTask, string>>;
  context?: ContextSettings;
  promptCache?: boolean;
  pricing?: Record<string, ModelPrice>;
  search?: SearchSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'demo',
  anthropic: { apiKey: '', model: 'claude-sonnet-5-5' },
  compat: { preset: 'deepseek', baseURL: COMPAT_PRESETS[0].baseURL, apiKey: '', model: COMPAT_PRESETS[0].model },
  showNotes: true,
  qaMode: 'inline',
  taskModels: {},
  context: { ...DEFAULT_CONTEXT },
  promptCache: true,
  pricing: {},
  search: { ...DEFAULT_SEARCH },
};

/** Fill nested defaults without dropping stored account, model, or price edits. */
export function mergeSettings(parsed: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    anthropic: { ...DEFAULT_SETTINGS.anthropic, ...parsed.anthropic },
    compat: { ...DEFAULT_SETTINGS.compat, ...parsed.compat },
    taskModels: { ...parsed.taskModels },
    context: { ...DEFAULT_CONTEXT, ...parsed.context },
    pricing: Object.fromEntries(Object.entries(parsed.pricing ?? {}).map(([key, price]) => [key, { ...price }])),
    search: { ...DEFAULT_SEARCH, ...parsed.search },
  };
}

export async function loadSettings(): Promise<Settings> {
  const raw = await (await getFs()).loadSettings();
  if (!raw) return mergeSettings({});
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('设置格式错误');
  return mergeSettings(parsed as Partial<Settings>);
}

export async function saveSettings(s: Settings): Promise<void> {
  const error = validateSettings(s);
  if (error) throw new Error(error);
  await (await getFs()).saveSettings(JSON.stringify(s, null, 2));
}

export function modelName(s: Settings): string {
  if (s.provider === 'anthropic') return s.anthropic.model.trim();
  if (s.provider === 'openai-compatible') return s.compat.model.trim();
  return 'demo';
}

export function priceKey(s: Settings): string {
  return s.provider + ':' + modelName(s);
}

export function effectiveSettings(s: Settings, task: AiTask): Settings {
  const model = s.taskModels?.[task]?.trim() || (task === 'summary' ? s.taskModels?.ask?.trim() : '');
  if (!model || s.provider === 'demo') return s;
  if (s.provider === 'anthropic') return { ...s, anthropic: { ...s.anthropic, model } };
  return { ...s, compat: { ...s.compat, model } };
}

export function contextSettings(s: Settings): ContextSettings {
  const context = { ...DEFAULT_CONTEXT, ...s.context };
  if (!Number.isSafeInteger(context.windowTokens) || context.windowTokens < 2) context.windowTokens = DEFAULT_CONTEXT.windowTokens;
  if (!Number.isSafeInteger(context.outputTokens) || context.outputTokens < 1 || context.outputTokens >= context.windowTokens) {
    context.outputTokens = Math.min(DEFAULT_CONTEXT.outputTokens, context.windowTokens - 1);
  }
  if (!['auto', 'cl100k_base', 'o200k_base'].includes(context.tokenizer)) context.tokenizer = 'auto';
  if (typeof context.tokenizerUrl !== 'string') context.tokenizerUrl = '';
  return context;
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Validate edits before either settings persistence or template navigation. */
export function validateSettings(s: Settings): string | null {
  const context = { ...DEFAULT_CONTEXT, ...s.context };
  if (!Number.isSafeInteger(context.windowTokens) || context.windowTokens < 2
    || !Number.isSafeInteger(context.outputTokens) || context.outputTokens < 1) {
    return '上下文窗口和输出预算必须为正整数，窗口至少为 2。';
  }
  if (context.outputTokens >= context.windowTokens) return '输出预算必须小于上下文窗口。';
  if (context.tokenizerUrl.trim() && !httpUrl(context.tokenizerUrl)) return 'Tokenizer JSON 地址必须是 HTTP 或 HTTPS URL，且不能包含登录凭据。';
  if (s.compat.baseURL.trim() && !httpUrl(s.compat.baseURL)) return '模型接口地址必须是 HTTP 或 HTTPS URL，且不能包含登录凭据。';
  if (s.provider === 'openai-compatible' && !s.compat.baseURL.trim()) return '请填写模型接口地址。';
  for (const [key, price] of Object.entries(s.pricing ?? {})) {
    if (!price || !Number.isFinite(price.input) || price.input < 0 || !Number.isFinite(price.output) || price.output < 0
      || [price.cacheRead, price.cacheWrite].some((rate) => rate !== undefined && (!Number.isFinite(rate) || rate < 0))) {
      return `模型 ${key} 的输入、输出价格必须完整填写为非负数；缓存价格可留空。`;
    }
  }
  const search = { ...DEFAULT_SEARCH, ...s.search };
  if (search.baseURL.trim() && !httpUrl(search.baseURL)) return '搜索接口地址必须是 HTTP 或 HTTPS URL，且不能包含登录凭据。';
  if (!Number.isSafeInteger(search.maxResults) || search.maxResults < 1 || search.maxResults > 10) return '搜索结果数必须是 1–10 的整数。';
  if (search.enabled && !search.baseURL.trim()) return '开启联网搜索前，请填写搜索接口地址。';
  if (search.enabled && search.provider === 'brave' && !search.apiKey.trim()) return '开启 Brave 搜索前，请填写搜索 API Key。';
  return null;
}

/** 当前设置是否足以调用模型；返回缺什么，或 null 表示可用。 */
export function missingConfig(s: Settings): string | null {
  if (s.provider === 'demo') return null;
  if (s.provider === 'anthropic') {
    if (!s.anthropic.apiKey.trim()) return '还没有填写 Anthropic API Key';
    if (!s.anthropic.model.trim()) return '还没有填写模型名';
    return null;
  }
  const preset = COMPAT_PRESETS.find((p) => p.id === s.compat.preset);
  if (!s.compat.baseURL.trim()) return '还没有填写接口地址';
  if (!s.compat.model.trim()) return '还没有填写模型名';
  if ((preset?.needsKey ?? true) && !s.compat.apiKey.trim()) return '还没有填写 API Key';
  return null;
}

export function providerLabel(s: Settings): string {
  if (s.provider === 'demo') return '演示模式';
  if (s.provider === 'anthropic') return 'Claude · ' + s.anthropic.model;
  const preset = COMPAT_PRESETS.find((p) => p.id === s.compat.preset);
  return (preset?.label.replace(/（.*）/, '') ?? '自定义') + ' · ' + (s.compat.model || '未设置模型');
}
