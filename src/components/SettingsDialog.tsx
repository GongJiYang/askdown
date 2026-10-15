import { useState } from 'react';
import { COMPAT_PRESETS, type ProviderKind, type Settings } from '../settings';
import { streamCompletion } from '../ai/providers';
import { PROMPT_LABELS, type PromptName } from '../ai/prompts';
import { isTauri } from '../fs';

interface Props {
  initial: Settings;
  hasVault: boolean;
  onSave: (s: Settings) => void;
  onClose: () => void;
  /** 打开模板文件前会先保存当前填写的设置 */
  onEditPrompt: (name: PromptName, draft: Settings) => void;
}

export function SettingsDialog({ initial, hasVault, onSave, onClose, onEditPrompt }: Props) {
  const [s, setS] = useState<Settings>(() => structuredClone(initial));
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'fail'; text: string }>({ state: 'idle', text: '' });

  const setProvider = (provider: ProviderKind) => setS({ ...s, provider });
  const preset = COMPAT_PRESETS.find((p) => p.id === s.compat.preset) ?? COMPAT_PRESETS[COMPAT_PRESETS.length - 1];

  function choosePreset(id: string) {
    const p = COMPAT_PRESETS.find((x) => x.id === id)!;
    setS({ ...s, compat: { ...s.compat, preset: id, baseURL: p.baseURL || s.compat.baseURL, model: p.model || '' } });
  }

  async function runTest() {
    setTest({ state: 'running', text: '正在连接…' });
    try {
      const text = await streamCompletion(s, { prompt: '只回复四个字：连接成功' });
      setTest({ state: 'ok', text: '模型回复：' + text.trim().slice(0, 60) });
    } catch (e) {
      setTest({ state: 'fail', text: (e as Error).message });
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <h2 id="settings-title">设置</h2>

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
                  placeholder={preset.id === 'ollama' ? '例如 qwen3、llama3.1，需先用 ollama pull 下载' : '填写模型名'}
                  onChange={(e) => setS({ ...s, compat: { ...s.compat, model: e.target.value } })}
                />
              </label>
            </div>
          )}

          <div className="test-row">
            <button type="button" className="btn" onClick={() => void runTest()} disabled={test.state === 'running'}>
              测试连接
            </button>
            {test.text && <span className={'test-' + test.state}>{test.text}</span>}
          </div>
          <p className="hint">
            {isTauri() ? 'API Key 保存在本机的应用配置目录里（settings.json），不会写进你的文件库。' : '浏览器开发模式下，设置保存在本浏览器的 localStorage 里。'}
          </p>
        </section>

        <section>
          <h3>提示词</h3>
          <p className="hint">提问和整理用的提示词是文件库里 <code>.askdown/prompts/</code> 下的 Markdown 文件，可以按自己的习惯改。</p>
          <div className="prompt-row">
            {(Object.keys(PROMPT_LABELS) as PromptName[]).map((n) => (
              <button key={n} type="button" className="btn" disabled={!hasVault} onClick={() => onEditPrompt(n, s)}>
                编辑{PROMPT_LABELS[n]}
              </button>
            ))}
          </div>
        </section>

        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={() => onSave(s)}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
