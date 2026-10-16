import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fillTemplate, listActionPrompts, loadPrompt, promptPath } from './prompts';
import { runAsk, runTidy } from './actions';
import { DEFAULT_SETTINGS } from '../settings';
import type * as FsModule from '../fs';

const { files, fs, completion } = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => {
        if (!files.has(path)) throw new Error('missing');
        return files.get(path)!;
      },
      write: async (path: string, text: string, options: { expected: string | null }) => {
        if ((files.get(path) ?? null) !== options.expected) throw new Error('conflict');
        files.set(path, text);
      },
      list: async (root: string) => [...files.keys()].filter((path) => path.startsWith(root + '/')).map((path) => ({ path: path.slice(root.length + 1), modified: 0 })),
    },
    completion: vi.fn(async (_settings: unknown, options: { prompt: string; demoText?: string }) => options.demoText ?? options.prompt),
  };
});
vi.mock('../fs', async (importOriginal) => {
  const original = await importOriginal<typeof FsModule>();
  return { ...original, getFs: async () => fs };
});
vi.mock('./providers', () => ({ streamCompletion: completion }));
beforeEach(() => { files.clear(); completion.mockClear(); });

describe('prompt template substitution', () => {
  it('substitutes only supplied variables and leaves user content literal', () => {
    expect(fillTemplate('{{ question }} / {{anchor}} / {{unknown}} / {{constructor}}', {
      question: '$& {{anchor}}', anchor: 'context',
    })).toBe('$& {{anchor}} / context / {{unknown}} / {{constructor}}');
  });
});


describe('vault action templates', () => {
  it('discovers direct action files, preserves customization, and remembers deleted defaults', async () => {
    files.set('/vault/.askdown/prompts/反驳我.md', 'my own prompt');
    files.set('/vault/.askdown/prompts/自定义.md', 'custom {{anchor}}');
    files.set('/vault/.askdown/prompts/ask.md', 'ask');
    files.set('/vault/.askdown/prompts/nested/action.md', 'nested');
    const actions = await listActionPrompts('/vault');
    expect(actions.map((action) => action.name)).toEqual(expect.arrayContaining(['反驳我', '举个例子', '往下想一步', '用大白话解释', '自定义']));
    expect(actions.some((action) => action.name === 'ask' || action.name.includes('/'))).toBe(false);
    expect(await loadPrompt('/vault', '反驳我')).toBe('my own prompt');
    files.delete('/vault/.askdown/prompts/反驳我.md');
    expect((await listActionPrompts('/vault')).some((action) => action.name === '反驳我')).toBe(false);
    await expect(loadPrompt('/vault', '反驳我')).rejects.toThrow('不存在');
  });

  it('rejects unsafe names and missing or empty actions without substituting or overwriting', async () => {
    for (const name of ['../ask', 'nested/ask', 'nested\\ask', '.private', 'ask ', '']) {
      expect(() => promptPath('/vault', name)).toThrow();
    }
    await expect(loadPrompt('/vault', 'missing')).rejects.toThrow('不存在');
    files.set('/vault/.askdown/prompts/ask.md', '');
    await expect(loadPrompt('/vault', 'ask')).rejects.toThrow('为空');
    expect(files.get('/vault/.askdown/prompts/ask.md')).toBe('');
  });

  it('includes selection, history, and rewrite instructions with old custom templates', async () => {
    files.set('/vault/.askdown/prompts/自定义.md', 'Explain {{question}}');
    const answer = await runAsk(DEFAULT_SETTINGS, '/vault', {
      question: 'Q', anchor: 'Selected context', document: 'Document', template: '自定义',
      history: [{ question: 'Earlier question', answer: 'Earlier answer' }],
      previousAnswer: 'Previous answer', style: 'alternative',
    }, () => {}, new AbortController().signal);
    expect(answer).toContain('Explain Q');
    expect(answer).toContain('Selected context');
    expect(answer).toContain('Earlier question\n答：Earlier answer');
    expect(answer).toContain('Previous answer');
    expect(answer).toContain('换个角度');
    expect(files.get('/vault/.askdown/prompts/自定义.md')).toBe('Explain {{question}}');
  });

  it('keeps custom tidy notes context and provides linked demo output independent of template wording', async () => {
    files.set('/vault/.askdown/prompts/tidy.md', 'My personal instruction');
    const id = '11111111-1111-4111-8111-111111111111';
    const text = await runTidy(DEFAULT_SETTINGS, '/vault', {
      title: 'Title', head: '', notes: 'User-edited notes',
      pairs: [{ id, answerId: '22222222-2222-4222-8222-222222222222', question: 'Question', anchor: 'Anchor', answer: 'Answer' }],
    }, () => {}, new AbortController().signal);
    expect(text).toContain('User-edited notes');
    expect(text).toContain(`[来源](#q-${id})`);
    const prompt = completion.mock.calls[0][1].prompt;
    expect(prompt).toContain('My personal instruction');
    expect(prompt).toContain('User-edited notes');
    expect(prompt).toContain('回答：Answer');
    expect(files.get('/vault/.askdown/prompts/tidy.md')).toBe('My personal instruction');
  });
});

it('does not invoke a provider when there is no incremental tidy delta', async () => {
  const text = await runTidy(DEFAULT_SETTINGS, '/vault', {
    title: 'Title', head: '', notes: 'Unchanged user notes', pairs: [],
  }, () => {}, new AbortController().signal);
  expect(text).toBe('Unchanged user notes');
  expect(completion).not.toHaveBeenCalled();
});
