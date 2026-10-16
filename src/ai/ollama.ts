import { getFetch } from './transport';

export interface OllamaModel {
  name: string;
  size: number | null;
  digest: string;
  modifiedAt: string;
}

export interface OllamaPullProgress {
  status: string;
  digest?: string;
  completed?: number;
  total?: number;
}

/** Keep reverse-proxy prefixes when translating the OpenAI-compatible endpoint. */
function apiURL(baseURL: string, endpoint: 'tags' | 'pull'): string {
  const url = new URL(baseURL.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Ollama 地址必须使用 http 或 https。');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:v1|api)$/, '') + '/api/' + endpoint;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function bytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  let detail = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (object(parsed) && typeof parsed.error === 'string') detail = parsed.error;
  } catch { /* Some proxies return plain text errors. */ }
  throw new Error(`Ollama HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
}

export function sameOllamaModel(left: string, right: string): boolean {
  const normalize = (name: string) => {
    const trimmed = name.trim();
    const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    return lastSegment.includes(':') || lastSegment.includes('@') ? trimmed : `${trimmed}:latest`;
  };
  return normalize(left) === normalize(right);
}

export async function listOllamaModels(baseURL: string, signal?: AbortSignal): Promise<OllamaModel[]> {
  const url = apiURL(baseURL, 'tags');
  const fetchImpl = await getFetch();
  signal?.throwIfAborted();
  const response = await fetchImpl(url, { signal });
  await checkResponse(response);
  const data: unknown = await response.json();
  signal?.throwIfAborted();
  if (!object(data) || !Array.isArray(data.models)) throw new Error('Ollama 返回了无效的模型列表。');
  return data.models.map((entry: unknown) => {
    if (!object(entry)) throw new Error('Ollama 返回了无效的模型信息。');
    const name = typeof entry.name === 'string' ? entry.name : entry.model;
    if (typeof name !== 'string' || !name.trim()) throw new Error('Ollama 返回的模型缺少名称。');
    return {
      name,
      size: bytes(entry.size) ?? null,
      digest: typeof entry.digest === 'string' ? entry.digest : '',
      modifiedAt: typeof entry.modified_at === 'string' ? entry.modified_at : '',
    };
  });
}

export async function pullOllamaModel(
  baseURL: string,
  model: string,
  onProgress: (event: OllamaPullProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const url = apiURL(baseURL, 'pull');
  if (!model.trim()) throw new Error('请先填写模型名称。');
  const fetchImpl = await getFetch();
  signal.throwIfAborted();
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model.trim(), stream: true }),
    signal,
  });
  await checkResponse(response);
  signal.throwIfAborted();
  if (!response.body) throw new Error('Ollama 没有返回下载进度。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let succeeded = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  function consume(line: string) {
    if (!line.trim()) return;
    signal.throwIfAborted();
    let data: unknown;
    try { data = JSON.parse(line); }
    catch { throw new Error('Ollama 下载进度不是有效的 JSON。'); }
    if (!object(data)) throw new Error('Ollama 返回了无效的下载进度。');
    if (typeof data.error === 'string') throw new Error(data.error);
    if (typeof data.status !== 'string') throw new Error('Ollama 下载进度缺少状态。');
    onProgress({
      status: data.status,
      digest: typeof data.digest === 'string' ? data.digest : undefined,
      completed: bytes(data.completed),
      total: bytes(data.total),
    });
    if (data.status === 'success') succeeded = true;
  }
  try {
    signal.throwIfAborted();
    while (!succeeded) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      pending += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (done) {
        consume(pending);
        break;
      }
    }
    if (!succeeded) throw new Error('下载连接已结束，但 Ollama 尚未确认成功，请刷新模型列表后重试。');
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
