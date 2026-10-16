import { useState } from 'react';
import { COMPAT_PRESETS, DEFAULT_CONTEXT, DEFAULT_SEARCH, effectiveSettings, mergeSettings, modelName, priceKey, validateSettings, type AiTask, type ModelPrice, type ProviderKind, type Settings } from '../settings';
import { streamCompletion } from '../ai/providers';
import { PROMPT_LABELS, type PromptName } from '../ai/prompts';
import { isTauri } from '../fs';
import { OllamaModels } from './OllamaModels';

const TASK_LABELS: [AiTask, string][] = [['ask', '提问'], ['tidy', '整理'], ['summary', '自动摘要']];
const PRICE_LABELS: [keyof ModelPrice, string][] = [['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入']];
type PriceDraft = Partial<Record<keyof ModelPrice, string>>;

interface Props {
  initial: Settings;
  hasVault: boolean;
  onSave: (s: Settings) => Promise<void>;
  onClose: () => void;
  /** 打开模板文件前会先保存当前填写的设置 */
  onEditPrompt: (name: PromptName, draft: Settings) => Promise<void>;
}

export function SettingsDialog({ initial, hasVault, onSave, onClose, onEditPrompt }: Props) {
  const [s, setS] = useState<Settings>(() => mergeSettings(structuredClone(initial)));
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'fail'; text: string }>({ state: 'idle', text: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [priceDrafts, setPriceDrafts] = useState<Record<string, PriceDraft>>({});
  const context = { ...DEFAULT_CONTEXT, ...s.context };
  const search = { ...DEFAULT_SEARCH, ...s.search };
  const pricedModels = new Map<string, { model: string; tasks: string[] }>();
  for (const [task, label] of [['test', '默认 / 连接测试'], ...TASK_LABELS] as [AiTask, string][]) {
    const routed = effectiveSettings(s, task);
    const key = priceKey(routed);
    const entry = pricedModels.get(key);
    if (entry) entry.tasks.push(label);
    else pricedModels.set(key, { model: modelName(routed), tasks: [label] });
  }

  function settingsToSave(): Settings {
    const pricing = { ...s.pricing };
    for (const [key, draft] of Object.entries(priceDrafts)) {
      const fields = Object.fromEntries(PRICE_LABELS.map(([field]) => [field, draft[field] ?? (pricing[key]?.[field]?.toString() ?? '')])) as Record<keyof ModelPrice, string>;
      if (Object.values(fields).every((value) => !value.trim())) {
        delete pricing[key];
        continue;
      }
      if (!fields.input.trim() || !fields.output.trim()) throw new Error(`模型 ${key} 的输入和输出价格需一起填写；全部留空表示未知。`);
      const price: ModelPrice = { input: Number(fields.input), output: Number(fields.output) };
      for (const field of ['cacheRead', 'cacheWrite'] as const) {
        if (fields[field].trim()) price[field] = Number(fields[field]);
      }
      pricing[key] = price;
    }
    const next = { ...s, pricing };
    const message = validateSettings(next);
    if (message) throw new Error(message);
    return next;
  }

  async function persist(prompt?: PromptName) {
    setError('');
    setSaving(true);
    try {
      const next = settingsToSave();
      if (prompt) await onEditPrompt(prompt, next);
      else await onSave(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const setProvider = (provider: ProviderKind) => setS({ ...s, provider });
  const preset = COMPAT_PRESETS.find((p) => p.id === s.compat.preset) ?? COMPAT_PRESETS[COMPAT_PRESETS.length - 1];

  function choosePreset(id: string) {
    const p = COMPAT_PRESETS.find((x) => x.id === id)!;
    setS({ ...s, compat: { ...s.compat, preset: id, baseURL: p.baseURL || s.compat.baseURL, model: p.model || '' } });
  }

  async function runTest() {
    setTest({ state: 'running', text: '正在连接…' });
    try {
      const text = await streamCompletion(settingsToSave(), { prompt: '只回复四个字：连接成功', task: 'test', vault: null });
      setTest({ state: 'ok', text: '模型回复：' + text.trim().slice(0, 60) });
    } catch (e) {
      setTest({ state: 'fail', text: (e as Error).message });
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <h2 id="settings-title">设置</h2>
        <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>

        <section>
          <h3>模型</h3>
          <div className="segmented" role="radiogroup">
            {(
              [
                ['demo', '演示'],
                ['anthropic', 'Claude'],
                ['openai-compatible', 'OpenAI 兼容'],
              ] as [ProviderKind, string][]
            ).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={s.provider === k} className={s.provider === k ? 'on' : ''} onClick={() => setProvider(k)}>
                {label}
              </button>
            ))}
          </div>

          {s.provider === 'demo' && <p className="hint">演示模式不调用任何模型，回答是固定的示例文字，用来熟悉界面。</p>}

          {s.provider === 'anthropic' && (
            <div className="fields">
              <label>
                API Key
                <input id="anthropic-key" className="input" type="password" value={s.anthropic.apiKey} placeholder="sk-ant-…" onChange={(e) => setS({ ...s, anthropic: { ...s.anthropic, apiKey: e.target.value } })} />
              </label>
              <label>
                模型
                <input id="anthropic-model" className="input" value={s.anthropic.model} placeholder="claude-sonnet-5-5" onChange={(e) => setS({ ...s, anthropic: { ...s.anthropic, model: e.target.value } })} />
              </label>
            </div>
          )}

          {s.provider === 'openai-compatible' && (
            <div className="fields">
              <label>
                服务
                <select id="compat-preset" className="input" value={s.compat.preset} onChange={(e) => choosePreset(e.target.value)}>
                  {COMPAT_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                接口地址
                <input id="compat-url" className="input" value={s.compat.baseURL} placeholder="https://…/v1" onChange={(e) => setS({ ...s, compat: { ...s.compat, baseURL: e.target.value } })} />
              </label>
              <label>
                API Key{!preset.needsKey && <span className="opt">（本地模型可不填）</span>}
                <input id="compat-key" className="input" type="password" value={s.compat.apiKey} onChange={(e) => setS({ ...s, compat: { ...s.compat, apiKey: e.target.value } })} />
              </label>
              <label>
                模型
                <input
                  id="compat-model"
                  className="input"
                  value={s.compat.model}
                  placeholder={preset.id === 'ollama' ? '例如 qwen3、llama3.1' : '填写模型名'}
                  onChange={(e) => setS({ ...s, compat: { ...s.compat, model: e.target.value } })}
                />
              </label>
              {preset.id === 'ollama' && <OllamaModels baseURL={s.compat.baseURL} model={s.compat.model} onSelect={(model) => setS((current) => ({ ...current, compat: { ...current.compat, model } }))} />}
            </div>
          )}

          <div className="test-row">
            <button type="button" className="btn" onClick={() => void runTest()} disabled={test.state === 'running'}>
              测试连接
            </button>
            {test.text && <span className={'test-' + test.state}>{test.text}</span>}
          </div>
          <p className="hint">
            {isTauri() ? 'API Key 存入系统钥匙串，设置文件仅保存非敏感配置。拒绝钥匙串访问时不会降级为明文保存。' : '浏览器模式的 API Key 仅在当前页面内存中保留，刷新后需重新填写。其他设置保存在 localStorage。'}
          </p>
        </section>

        <section>
          <h3>任务模型</h3>
          <p className="hint">各任务共用当前服务与凭据。留空使用默认模型；自动摘要留空时使用提问模型。</p>
          <div className="fields">
            {TASK_LABELS.map(([task, label]) => (
              <label key={task}>
                {label}模型
                <input className="input" value={s.taskModels?.[task] ?? ''} placeholder={task === 'summary' ? '继承提问模型' : '继承默认模型'} onChange={(e) => setS({ ...s, taskModels: { ...s.taskModels, [task]: e.target.value } })} />
              </label>
            ))}
          </div>
        </section>

        <section>
          <h3>上下文与 Token 预算</h3>
          <p className="hint">窗口包含输入与输出；超出预算的材料会分段摘要。各任务共用此预算，请按所选模型中最小的窗口填写上限。</p>
          <div className="fields">
            <label>
              上下文窗口（Token）
              <input className="input" type="number" min="2" step="1" value={Number.isFinite(context.windowTokens) ? context.windowTokens : ''} onChange={(e) => setS({ ...s, context: { ...context, windowTokens: e.target.valueAsNumber } })} />
            </label>
            <label>
              最大输出（Token）
              <input className="input" type="number" min="1" max={context.windowTokens - 1} step="1" value={Number.isFinite(context.outputTokens) ? context.outputTokens : ''} onChange={(e) => setS({ ...s, context: { ...context, outputTokens: e.target.valueAsNumber } })} />
            </label>
            <label>
              Tokenizer
              <select className="input" value={context.tokenizer} onChange={(e) => setS({ ...s, context: { ...context, tokenizer: e.target.value as typeof context.tokenizer } })}>
                <option value="auto">自动选择</option>
                <option value="cl100k_base">cl100k_base</option>
                <option value="o200k_base">o200k_base</option>
              </select>
            </label>
            <label>
              自定义 Tokenizer JSON URL（可选）
              <input className="input" type="url" value={context.tokenizerUrl} placeholder="https://…/tokenizer.json" onChange={(e) => setS({ ...s, context: { ...context, tokenizerUrl: e.target.value } })} />
            </label>
          </div>
          <p className="hint">Claude 使用官方计数；已知 OpenAI 模型使用对应 tokenizer。其他模型可提供 Hugging Face tokenizer.json；未配置时按 UTF-8 字节做保守预算，并明确标注为估计。消息包装和图片另留余量，账单用量以服务返回值为准。</p>
        </section>

        <section>
          <h3>提示词缓存</h3>
          <label><input type="checkbox" checked={s.promptCache ?? true} onChange={(e) => setS({ ...s, promptCache: e.target.checked })} /> 启用提供商支持的提示词缓存</label>
          <p className="hint">文档正文放在稳定前缀，Claude 显式请求缓存；OpenAI 兼容服务自动决定是否缓存，无法在此关闭服务端自动缓存。命中门槛、有效期与价格取决于提供商。</p>
        </section>

        <section>
          <h3>模型价格 · USD / 百万 Token</h3>
          <p className="hint">输入和输出价格需一起填写。全部留空表示费用未知，缓存单价也可留空；0 表示已确认免费。同一模型的任务共用单价。</p>
          {s.provider === 'demo' ? <p className="hint">选择模型服务后可设置价格。</p> : Array.from(pricedModels, ([key, entry]) => (
            <div key={key}>
              <p className="hint"><strong>{entry.model || '未设置模型'}</strong> · {entry.tasks.join(' / ')}</p>
              <div className="fields" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                {PRICE_LABELS.map(([field, label]) => (
                  <label key={field}>
                    {label}
                    <input className="input" type="number" min="0" step="any" placeholder="未知" disabled={!entry.model} value={priceDrafts[key]?.[field] ?? s.pricing?.[key]?.[field] ?? ''} onChange={(e) => setPriceDrafts({ ...priceDrafts, [key]: { ...priceDrafts[key], [field]: e.target.value } })} />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section>
          <h3>联网搜索与引用</h3>
          <label><input type="checkbox" checked={search.enabled} onChange={(e) => setS({ ...s, search: { ...search, enabled: e.target.checked } })} /> 允许提问时联网搜索</label>
          <p className="hint">配置后，在阅读工具栏勾选「联网查证」。问题会发送给搜索服务，搜索摘要与来源链接提供给模型引用；搜索服务费用不计入模型用量。</p>
          <div className="fields">
            <label>
              搜索服务
              <select className="input" value={search.provider} onChange={(e) => {
                const provider = e.target.value as typeof search.provider;
                setS({ ...s, search: { ...search, provider, baseURL: provider === 'brave' ? DEFAULT_SEARCH.baseURL : '' } });
              }}>
                <option value="brave">Brave Search</option>
                <option value="searxng">SearXNG</option>
              </select>
            </label>
            <label>
              搜索接口地址
              <input className="input" type="url" value={search.baseURL} placeholder={search.provider === 'brave' ? DEFAULT_SEARCH.baseURL : 'https://search.example.com/search'} onChange={(e) => setS({ ...s, search: { ...search, baseURL: e.target.value } })} />
            </label>
            <label>
              搜索 API Key{search.provider === 'searxng' && '（可选）'}
              <input className="input" type="password" autoComplete="off" value={search.apiKey} onChange={(e) => setS({ ...s, search: { ...search, apiKey: e.target.value } })} />
            </label>
            <label>
              最多搜索结果（1–10）
              <input className="input" type="number" min="1" max="10" step="1" value={Number.isFinite(search.maxResults) ? search.maxResults : ''} onChange={(e) => setS({ ...s, search: { ...search, maxResults: e.target.valueAsNumber } })} />
            </label>
          </div>
        </section>

        <section>
          <h3>提示词</h3>
          <p className="hint">提问和整理用的提示词是文件库里 <code>.askdown/prompts/</code> 下的 Markdown 文件，可以按自己的习惯改。</p>
          <div className="prompt-row">
            {(Object.keys(PROMPT_LABELS) as PromptName[]).map((n) => (
              <button key={n} type="button" className="btn" disabled={!hasVault || saving} onClick={() => void persist(n)}>
                编辑{PROMPT_LABELS[n]}
              </button>
            ))}
          </div>
        </section>

        {error && <p className="test-fail" role="alert">{error}</p>}
        <div className="modal-foot">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={saving} onClick={() => void persist()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
        </fieldset>
      </div>
    </div>
  );
}
