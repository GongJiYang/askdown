import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undo, redo } from '@milkdown/kit/prose/history';
import { createEditor, type EditorHandle } from '../editor/createEditor';
import type { QaPair } from '../editor/qa';
import { checkpointFor, followUps, readNotes, validateNotes, writeNotes } from './notes';

const first: QaPair = {
  id: '11111111-1111-4111-8111-111111111111', answerId: '22222222-2222-4222-8222-222222222222',
  question: 'Why?', anchor: 'Context', answer: 'Original answer',
};
const second: QaPair = { ...first, id: '33333333-3333-4333-8333-333333333333', answerId: '44444444-4444-4444-8444-444444444444', question: 'How?' };
const editors: EditorHandle[] = [];
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });
afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function open(markdown: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = await createEditor(root, { markdown });
  editors.push(editor);
  return editor;
}

describe('incremental notes checkpoint', () => {
  it('roundtrips through the actual editor and restores text and processed revisions together on undo', async () => {
    const initial = await checkpointFor([first]);
    const original = writeNotes(`## 要点\n\n- Original [来源](#q-${first.id})`, initial);
    const editor = await open(original);
    const reloaded = await open(editor.getMarkdown());
    expect(readNotes(reloaded.getMarkdown()).checkpoint).toEqual(initial);
    const next = await checkpointFor([{ ...first, answer: 'Changed answer' }, second]);
    editor.replaceAll(writeNotes(`## 要点\n\n- Changed [来源](#q-${first.id})\n- New [来源](#q-${second.id})`, next), true);
    expect(readNotes(editor.getMarkdown()).checkpoint).toEqual(next);
    undo(editor.view().state, editor.view().dispatch);
    expect(readNotes(editor.getMarkdown()).checkpoint).toEqual(initial);
    expect(readNotes(editor.getMarkdown()).notes).toContain('Original');
    redo(editor.view().state, editor.view().dispatch);
    expect(readNotes(editor.getMarkdown()).checkpoint).toEqual(next);
    expect(readNotes(editor.getMarkdown()).notes).toContain('Changed');
  });

  it('processes new and changed pairs but skips unchanged content independent of ordering', async () => {
    const old = await checkpointFor([first, second]);
    const reordered = await checkpointFor([second, first]);
    expect(reordered).toEqual(old);
    for (const changed of [
      { ...first, answer: 'Revised answer' }, { ...first, question: 'Revised question' },
      { ...first, anchor: 'Revised context' }, { ...first, answerId: second.answerId },
    ]) {
      const next = await checkpointFor([changed, second]);
      const delta = [changed, second].filter((pair) => next.revisions[pair.id] !== old.revisions[pair.id]);
      expect(delta).toEqual([changed]);
    }
    const one = await checkpointFor([first]);
    expect([first, second].filter((pair) => old.revisions[pair.id] !== one.revisions[pair.id])).toEqual([second]);
  });

  it('fails on damaged or duplicated checkpoints and permits explicit reset without losing notes', async () => {
    const bad = 'User-edited notes\n\n```askdown-checkpoint\n{"version":5}\n```\n';
    expect(() => readNotes(bad)).toThrow('损坏');
    expect(readNotes(bad, true)).toEqual({ notes: 'User-edited notes', checkpoint: { version: 1, revisions: {} } });
    const checkpoint = await checkpointFor([first]);
    expect(() => readNotes(writeNotes('Notes', checkpoint) + writeNotes('', checkpoint))).toThrow('损坏');
  });
});

describe('notes source provenance', () => {
  it('rejects invented, missing, malformed, or incomplete sources instead of inventing mappings', () => {
    expect(() => validateNotes(`- Claim [来源](#q-${second.id})`, [first], [first], '')).toThrow('不存在');
    expect(() => validateNotes('- Claim with no source', [first], [first], '')).toThrow('缺少来源');
    expect(() => validateNotes('- Claim [来源](#q-wrong)', [first], [first], '')).toThrow('格式');
    expect(() => validateNotes(`- Claim \`[来源](#q-${first.id})\``, [first], [first], '')).toThrow('缺少来源');
    expect(() => validateNotes(`## Heading [来源](#q-${first.id})`, [first], [first], '')).toThrow('遗漏');
    expect(() => validateNotes(`- One claim [来源](#q-${first.id})`, [first, second], [first, second], '')).toThrow('遗漏');
    expect(() => validateNotes(`- Claim [来源](#q-${first.id})\n- Uncited second claim`, [first], [first], '')).toThrow('缺少来源');
  });

  it('accepts untouched user paragraphs while requiring citations for new content', () => {
    const previous = 'My own observation, kept verbatim.';
    const result = `${previous}\n\n## 要点\n\n- Supported [来源](#q-${first.id})`;
    validateNotes(result, [first], [first], previous);
    expect(() => validateNotes(result.replace('My own', 'A newly fabricated'), [first], [first], previous)).toThrow('缺少来源');
  });

  it('retains clickable source IDs and follow-up questions after actual Markdown serialization', async () => {
    const editor = await open(`## 还没搞懂的\n\n- ?? What changes **in practice**? [来源](#q-${first.id})`);
    expect(followUps(editor.getMarkdown())).toEqual([{ id: first.id, question: 'What changes **in practice**?' }]);
    expect(editor.view().dom.querySelector('a')?.getAttribute('href')).toBe(`#q-${first.id}`);
    expect(followUps('- ?? Unlinked question')).toEqual([]);
  });
});
