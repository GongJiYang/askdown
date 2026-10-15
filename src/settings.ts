import { getFs } from './fs';

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'demo';

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
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'demo',
  anthropic: { apiKey: '', model: 'claude-sonnet-5-5' },
  compat: { preset: 'deepseek', baseURL: COMPAT_PRESETS[0].baseURL, apiKey: '', model: COMPAT_PRESETS[0].model },
  showNotes: true,
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await (await getFs()).loadSettings();
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      anthropic: { ...DEFAULT_SETTINGS.anthropic, ...parsed.anthropic },
      compat: { ...DEFAULT_SETTINGS.compat, ...parsed.compat },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await (await getFs()).saveSettings(JSON.stringify(s, null, 2));
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
