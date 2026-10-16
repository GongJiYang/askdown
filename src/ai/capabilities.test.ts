import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mergeSettings, priceKey } from '../settings';
import { getFs } from '../fs';
import { streamCompletion } from './providers';
import { loadUsage, recordUsage } from './usage';
import { runAsk } from './actions';
import { fitContext } from './context';
import { tokenCounter } from './tokens';

const root = 'capabilities-vault';
const settings = () => mergeSettings({
  provider: 'openai-compatible',
  compat: { preset: 'ollama', baseURL: 'https://model.test/v1', model: 'test-model', apiKey: '' },
});
const sse = (text: string, usage?: Record<string, unknown>) => new Response(
  `data: ${JSON.stringify({ id: 'call', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
  + `data: ${JSON.stringify({ id: 'call', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`,
  { headers: { 'content-type': 'text/event-stream' } },
);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  let queue: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: (_name: string, action: () => unknown) => {
      const result = queue.then(action);
      queue = result.catch(() => undefined);
      return result;
    },
  } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('bills DeepSeek cache hits from raw usage and preserves unknown counts instead of SDK zeros', async () => {
  const s = settings();
  s.pricing = { [priceKey(s)]: { input: 2, output: 4, cacheRead: 0.2 } };
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(sse('Cached response.', { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 600 }))
    .mockResolvedValueOnce(sse('Usage absent.'))
    .mockResolvedValueOnce(sse('Cache breakdown absent.', { prompt_tokens: 1000, completion_tokens: 100 })));
  for (let index = 0; index < 3; index++) await streamCompletion(s, { prompt: 'Private question', vault: root, task: 'ask' });
  const records = await loadUsage(root);
  expect(records[0]).toMatchObject({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 0, costUsd: 0.00132, status: 'complete' });
  expect(records[1]).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null });
  expect(records[2]).toMatchObject({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: null, costUsd: null });
  expect(JSON.stringify(records)).not.toContain('Private question');
});

it('requests Anthropic prefix caching and includes cache reads and writes in total input cost', async () => {
  const s = mergeSettings({ provider: 'anthropic', anthropic: { apiKey: 'test-key', model: 'claude-test' } });
  s.pricing = { [priceKey(s)]: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
  const requests: { messages: { content: { text: string; cache_control?: { type: string } }[] }[] }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: 1200 });
    requests.push(body);
    const events = [
      { type: 'message_start', message: { id: 'msg-test', model: 'claude-test', role: 'assistant', content: [], usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 800, cache_creation_input_tokens: 300 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }));
  await streamCompletion(s, { prompt: 'First question', stablePrefix: 'Stable document', vault: root });
  await streamCompletion({ ...s, promptCache: false }, { prompt: 'Second question', stablePrefix: 'Stable document', vault: root });
  expect(requests[0].messages[0].content[0]).toMatchObject({ text: 'Stable document', cache_control: { type: 'ephemeral' } });
  expect(requests[1].messages[0].content[0].cache_control).toBeUndefined();
  const [record] = await loadUsage(root);
  expect(record).toMatchObject({ inputTokens: 1200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 300 });
  expect(record.costUsd).toBeCloseTo(0.002415, 10);
});

it('records a cancelled stream without claiming zero cost or losing earlier records', async () => {
  const s = settings();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(sse('First answer.')));
  await streamCompletion(s, { prompt: 'First', vault: root });
  const abort = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'cancel', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: 'Partial answer' }, finish_reason: null }] })}\n\n`));
      abort.signal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } })));
  await expect(streamCompletion(s, { prompt: 'Cancel', vault: root, signal: abort.signal, onText: () => abort.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  const records = await loadUsage(root);
  expect(records.map((record) => record.status)).toEqual(['complete', 'aborted']);
  expect(records[1].costUsd).toBeNull();
});

it('merges concurrent ledger writes and rejects corrupt ledgers without overwriting them', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => sse('Answer.')));
  await streamCompletion(settings(), { prompt: 'Q', vault: root });
  const [record] = await loadUsage(root);
  await Promise.all(['a', 'b', 'c'].map((id) => recordUsage(root, { ...record, id })));
  expect((await loadUsage(root)).map((entry) => entry.id).sort()).toEqual([record.id, 'a', 'b', 'c'].sort());
  const fs = await getFs();
  const path = root + '/.askdown/usage.json';
  await fs.write(path, 'broken', { root, expected: await fs.read(path) });
  await expect(recordUsage(root, { ...record, id: 'd' })).rejects.toThrow('账本损坏');
  expect(await fs.read(path)).toBe('broken');
});

it('summarizes every source chunk and reuses the summary without another billable call', async () => {
  const s = settings();
  s.context = { windowTokens: 4096, outputTokens: 256, tokenizer: 'auto', tokenizerUrl: '' };
  s.taskModels = { ask: 'reader', summary: 'summarizer' };
  const document = '甲段内容🙂\n'.repeat(900) + 'FINAL_SENTINEL';
  const chunks: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    expect(body.model).toBe('summarizer');
    chunks.push(body.messages[0].content.split('\n\n').slice(1).join('\n\n'));
    return sse('简明摘要。');
  }));
  const counter = await tokenCounter(s);
  const first = await fitContext(s, root, document, 800, counter, new AbortController().signal);
  expect(chunks.join('')).toBe(document);
  expect(await counter.count(first)).toBeLessThanOrEqual(800);
  const before = await loadUsage(root);
  const second = await fitContext(s, root, document, 600, counter, new AbortController().signal);
  expect(second).toBe(first);
  expect(await counter.count(second)).toBeLessThanOrEqual(600);
  expect(await loadUsage(root)).toEqual(before);
});

it('keeps the document prefix stable and rejects invented web citations before returning an answer', async () => {
  const s = settings();
  s.taskModels = { ask: 'reader' };
  s.search = { enabled: true, provider: 'searxng', baseURL: 'https://search.test/search', apiKey: '', maxResults: 5 };
  const prompts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).startsWith('https://search.test/')) return Response.json({ results: [{ title: 'Verified title', url: 'https://source.test/article', content: 'Evidence.' }] });
    const body = JSON.parse(init.body);
    expect(body.model).toBe('reader');
    prompts.push(body.messages[0].content.map((part: { text: string }) => part.text).join('\n\n'));
    return sse(prompts.length === 1 ? 'Supported claim [W1].' : 'Invented claim [W99].');
  }));
  const req = { question: 'Check this', anchor: 'Clause', document: 'Transient Q&A', sourceDocument: 'Original source', webSearch: true };
  const answer = await runAsk(s, root, req, () => {}, new AbortController().signal);
  expect(answer).toContain('[W1](https://source.test/article)');
  expect(answer).toContain('Verified title');
  await expect(runAsk(s, root, { ...req, question: 'Next question', document: 'Changed Q&A' }, () => {}, new AbortController().signal)).rejects.toThrow('来源编号');
  expect(prompts[0].split('Original source')[0]).toBe(prompts[1].split('Original source')[0]);
  expect(prompts[0]).toContain('Original source');
  expect(prompts[1]).not.toContain('Changed Q&A');
});
