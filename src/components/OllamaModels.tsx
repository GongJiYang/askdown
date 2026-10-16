import { useCallback, useEffect, useRef, useState } from 'react';
import { listOllamaModels, pullOllamaModel, sameOllamaModel, type OllamaModel, type OllamaPullProgress } from '../ai/ollama';
import './OllamaModels.css';

interface Props {
  baseURL: string;
  model: string;
  onSelect: (model: string) => void;
}

type Discovery =
  | { state: 'loading' }
  | { state: 'ready'; models: OllamaModel[] }
  | { state: 'offline'; error: string };

type Download = {
  state: 'running' | 'success' | 'cancelled' | 'error';
  model: string;
  status: string;
  layers: Record<string, OllamaPullProgress>;
};

function formatBytes(value: number | null | undefined): string {
  if (value == null) return '大小未知';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0;
  return `${(value / 1024 ** Math.max(0, unit)).toFixed(unit > 0 ? 1 : 0)} ${units[Math.max(0, unit)]}`;
}

/** A new server gets an independent lifecycle, including pending request cancellation. */
export function OllamaModels(props: Props) {
  return <OllamaServerModels key={props.baseURL} {...props} />;
}

function OllamaServerModels({ baseURL, model, onSelect }: Props) {
  const [discovery, setDiscovery] = useState<Discovery>({ state: 'loading' });
  const [download, setDownload] = useState<Download | null>(null);
  const listing = useRef<AbortController | null>(null);
  const pulling = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    listing.current?.abort();
    const controller = new AbortController();
    listing.current = controller;
    setDiscovery({ state: 'loading' });
    try {
      const models = await listOllamaModels(baseURL, controller.signal);
      if (!controller.signal.aborted && listing.current === controller) setDiscovery({ state: 'ready', models });
    } catch (error) {
      if (!controller.signal.aborted && listing.current === controller) {
        setDiscovery({ state: 'offline', error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (listing.current === controller) listing.current = null;
    }
  }, [baseURL]);

  useEffect(() => {
    void refresh();
    return () => {
      listing.current?.abort();
      pulling.current?.abort();
    };
  }, [refresh]);

  async function downloadModel() {
    const requestedModel = model.trim();
    if (pulling.current || !requestedModel || discovery.state !== 'ready') return;
    const controller = new AbortController();
    pulling.current = controller;
    setDownload({ state: 'running', model: requestedModel, status: '正在请求下载…', layers: {} });
    try {
      await pullOllamaModel(baseURL, requestedModel, (event) => {
        if (controller.signal.aborted || pulling.current !== controller) return;
        setDownload((previous) => {
          if (!previous) return previous;
          const layers = event.digest ? {
            ...previous.layers,
            [event.digest]: {
              ...previous.layers[event.digest],
              ...event,
              completed: event.completed ?? previous.layers[event.digest]?.completed,
              total: event.total ?? previous.layers[event.digest]?.total,
            },
          } : previous.layers;
          return { ...previous, status: event.status, layers };
        });
      }, controller.signal);
      if (controller.signal.aborted || pulling.current !== controller) return;
      setDownload((previous) => previous && { ...previous, state: 'success', status: '下载成功' });
      void refresh();
    } catch (error) {
      if (!controller.signal.aborted && pulling.current === controller) {
        setDownload((previous) => previous && {
          ...previous,
          state: 'error',
          status: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (pulling.current === controller) pulling.current = null;
    }
  }

  function cancelDownload() {
    pulling.current?.abort();
    pulling.current = null;
    setDownload((previous) => previous && { ...previous, state: 'cancelled', status: '已取消当前下载请求' });
  }

  const installed = discovery.state === 'ready' ? discovery.models.find((item) => sameOllamaModel(item.name, model)) : undefined;
  const missing = discovery.state === 'ready' && !!model.trim() && !installed;
  const running = download?.state === 'running';

  return (
    <div className="ollama-models">
      <div className="ollama-models-head">
        <strong>Ollama 本地模型</strong>
        <button type="button" className="btn" onClick={() => void refresh()}>
          {discovery.state === 'loading' ? '重新连接' : '刷新列表'}
        </button>
      </div>
      <p className={discovery.state === 'offline' ? 'hint ollama-error' : 'hint'} role={discovery.state === 'offline' ? 'alert' : 'status'}>
        {discovery.state === 'loading' && '正在连接 Ollama 并读取模型列表…'}
        {discovery.state === 'offline' && `无法读取 Ollama 模型列表，安装状态未知：${discovery.error}`}
        {discovery.state === 'ready' && (installed
          ? `已安装 ${installed.name}（${formatBytes(installed.size)}）`
          : model.trim() ? `服务器在线，尚未安装 ${model.trim()}` : `服务器在线，已安装 ${discovery.models.length} 个模型。请填写或选择模型。`)}
      </p>
      {discovery.state === 'ready' && discovery.models.length > 0 && (
        <label className="ollama-model-choice">
          选择已安装模型
          <select className="input" value={installed?.name ?? ''} onChange={(event) => { if (event.target.value) onSelect(event.target.value); }}>
            <option value="" disabled>选择本地模型…</option>
            {discovery.models.map((item) => <option key={item.name} value={item.name}>{item.name} · {formatBytes(item.size)}</option>)}
          </select>
        </label>
      )}
      {missing && !running && (
        <button type="button" className="btn" onClick={() => void downloadModel()}>下载 {model.trim()}</button>
      )}
      {download && (
        <div className="ollama-download" aria-busy={running}>
          <div className="ollama-models-head">
            <span>下载模型：{download.model}</span>
            {running && <button type="button" className="btn" onClick={cancelDownload}>取消下载</button>}
          </div>
          <p className={download.state === 'error' ? 'hint ollama-error' : 'hint'} role={download.state === 'error' ? 'alert' : 'status'}>{download.status}</p>
          {Object.entries(download.layers).map(([digest, layer]) => (
            <div className="ollama-layer" key={digest}>
              <code title={digest}>{digest.replace(/^sha256:/, '').slice(0, 12)}</code>
              <span>{layer.completed === undefined ? '等待进度' : formatBytes(layer.completed)} / {formatBytes(layer.total)}</span>
              <progress aria-label={`${digest} 下载进度`} max={layer.total && layer.total > 0 ? layer.total : 1} value={layer.total && layer.total > 0 && layer.completed !== undefined ? Math.min(layer.completed, layer.total) : undefined} />
              <span className="ollama-layer-status">{layer.status}</span>
            </div>
          ))}
        </div>
      )}
      <p className="hint">仅点击下载时才会拉取模型。Ollama 不提供其他程序下载任务的进度查询；外部下载完成后请刷新列表。</p>
    </div>
  );
}
