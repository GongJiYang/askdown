import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMParser as PMDOMParser, DOMSerializer, Fragment, type Node as PMNode } from '@milkdown/kit/prose/model';
import { redo, undo } from '@milkdown/kit/prose/history';
import { TextSelection } from '@milkdown/kit/prose/state';
import { createEditor, type CreateEditorOptions, type EditorHandle } from './createEditor';
import type { AskRequest } from './qa';

const editors: EditorHandle[] = [];
afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
});

async function open(markdown: string, options: Partial<CreateEditorOptions> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = await createEditor(root, { markdown, ...options });
  // jsdom has no text layout; real selection scrolling is exercised in the browser.
  editor.view().setProps({ handleScrollToSelection: () => true });
  editors.push(editor);
  return { editor, root };
}

function deferredAsk() {
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  let stream!: (text: string) => void;
  let signal!: AbortSignal;
  const ask = vi.fn((_request: AskRequest, onText: (text: string) => void, abort: AbortSignal) => {
    stream = onText;
    signal = abort;
    return new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  });
  return { ask, notify: vi.fn(), stream: (text: string) => stream(text), resolve: (text: string) => resolve(text), reject: (error: Error) => reject(error), signal: () => signal };
}

function callouts(editor: EditorHandle, kind: string) {
  const nodes: { node: PMNode; pos: number }[] = [];
  editor.view().state.doc.descendants((node, pos) => {
    if (node.type.name === 'callout' && node.attrs.kind === kind) nodes.push({ node, pos });
  });
  return nodes;
}

function click(root: HTMLElement, action: string) {
  const button = root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  expect(button).not.toBeNull();
  button!.click();
}

const legacy = 'Context\n\n> [!question]\n> Why?\n\n> [!ai]\n> Original **answer**.\n\nTail';

describe('persistent question and answer identities', () => {
  it('migrates legacy pairs once and roundtrips IDs, rich content, generic titles, and folds', async () => {
    const source = legacy + '\n\n> [!note]- **Rich** title\n> Nested text with [link](https://example.com)\n>\n> - first\n> - second\n>\n> > [!tip] Inner\n> > `code`';
    const { editor } = await open(source);
    const before = editor.getMarkdown();
    const question = callouts(editor, 'question')[0].node;
    const answer = callouts(editor, 'ai')[0].node;
    expect(question.attrs.id).toBeTruthy();
    expect(answer.attrs.answerTo).toBe(question.attrs.id);
    expect(before).toContain(`^q-${question.attrs.id}`);
    expect(before).toContain(`^a-${answer.attrs.id}`);
    expect(before).toContain(`<!-- askdown:answer-to q-${question.attrs.id} -->`);
    expect(before).toContain('[!note]- **Rich** title');
    editor.replaceAll(before, false);
    expect(editor.getMarkdown()).toBe(before);
    expect(editor.collectPairs()).toEqual([{ id: question.attrs.id, answerId: answer.attrs.id, question: 'Why?', anchor: 'Context', answer: 'Original **answer**.' }]);
    expect(callouts(editor, 'tip')[0].node.textContent).toBe('code');
  });

  it('reasks and collects a moved answer by ID after save/reload', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    const view = editor.view();
    const answer = callouts(editor, 'ai')[0];
    const tr = view.state.tr.delete(answer.pos, answer.pos + answer.node.nodeSize);
    view.dispatch(tr.insert(tr.doc.content.size, answer.node));
    editor.replaceAll(editor.getMarkdown(), false);
    expect(editor.collectPairs()[0]).toEqual({ id: callouts(editor, 'question')[0].node.attrs.id, answerId: answer.node.attrs.id, question: 'Why?', anchor: 'Context', answer: 'Original **answer**.' });
    click(root, 'reask');
    expect(request.ask).toHaveBeenCalledWith(expect.objectContaining({ question: 'Why?' }), expect.any(Function), expect.any(AbortSignal));
    request.resolve('Moved complete answer');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    expect(editor.collectPairs()[0].answer).toBe('Moved complete answer');
  });

  it('preserves identities through HTML clipboard and rejects duplicate copied pairs explicitly', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    const view = editor.view();
    const pair = Fragment.fromArray([callouts(editor, 'question')[0].node, callouts(editor, 'ai')[0].node]);
    const container = document.createElement('div');
    container.append(DOMSerializer.fromSchema(view.state.schema).serializeFragment(pair));
    const copy = PMDOMParser.fromSchema(view.state.schema).parseSlice(container).content;
    expect(copy.firstChild!.attrs.id).toBe(pair.firstChild!.attrs.id);
    expect(copy.lastChild!.attrs.answerTo).toBe(pair.lastChild!.attrs.answerTo);
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, copy));
    expect(editor.collectPairs()).toEqual([]);
    click(root, 'reask');
    expect(request.ask).not.toHaveBeenCalled();
    expect(request.notify).toHaveBeenCalledWith(expect.stringContaining('标识重复'));
  });

  it('does not reattach an orphan answer to a new adjacent question on reload', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    const view = editor.view();
    const question = callouts(editor, 'question')[0];
    view.dispatch(view.state.tr.setNodeMarkup(question.pos, undefined, { ...question.node.attrs, id: 'different-question' }));
    editor.replaceAll(editor.getMarkdown(), false);
    expect(editor.collectPairs()).toEqual([]);
    click(root, 'reask');
    expect(request.ask).not.toHaveBeenCalled();
    expect(request.notify).toHaveBeenCalled();
  });
});

describe('generation isolation and action history', () => {
  it('streams only into a decoration, preserves the existing answer, and stops without partial Markdown', async () => {
    const request = deferredAsk();
    const onChange = vi.fn();
    const busy = vi.fn();
    const { editor, root } = await open(legacy, { qa: request, onChange, onGenerationChange: busy });
    const original = editor.getMarkdown();
    click(root, 'reask');
    root.querySelector<HTMLButtonElement>('[data-stop-generation]')!.focus();
    request.stream('UNFINISHED PREVIEW');
    await vi.waitFor(() => expect(root.textContent).toContain('UNFINISHED PREVIEW'));
    expect(document.activeElement).toBe(root.querySelector('[data-stop-generation]'));
    expect(root.textContent).toContain('Original answer.');
    expect(editor.getMarkdown()).toBe(original);
    root.querySelector<HTMLButtonElement>('[data-stop-generation]')!.click();
    expect(request.signal().aborted).toBe(true);
    expect(editor.isGenerating()).toBe(false);
    expect(root.textContent).not.toContain('UNFINISHED PREVIEW');
    request.stream('LATE CHUNK');
    request.resolve('LATE RESULT');
    await Promise.resolve();
    expect(editor.getMarkdown()).toBe(original);
    expect(undo(editor.view().state, editor.view().dispatch)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });

  it('retains the original answer on request error', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    const original = editor.getMarkdown();
    click(root, 'reask');
    request.stream('Half');
    request.reject(new Error('Provider disconnected'));
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    expect(editor.getMarkdown()).toBe(original);
    expect(request.notify).toHaveBeenCalledWith('Provider disconnected');
    expect(request.signal().aborted).toBe(true);
  });

  it('locks pending answer edits, paste, drop, and deleting selections while adjacent text stays editable', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    const view = editor.view();
    click(root, 'reask');
    const answer = callouts(editor, 'ai')[0];
    const originalAnswer = answer.node;
    view.dispatch(view.state.tr.insertText('keyboard', answer.pos + 2));
    view.dispatch(view.state.tr.insertText('paste', answer.pos + 2).setMeta('uiEvent', 'paste'));
    view.dispatch(view.state.tr.insertText('drop', answer.pos + 2).setMeta('uiEvent', 'drop'));
    view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
    expect(callouts(editor, 'ai')[0].node.eq(originalAnswer)).toBe(true);
    view.dispatch(view.state.tr.insertText('Edited ', 1));
    request.stream('Preview after mapped edit');
    request.resolve('Final after mapped edit');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    expect(editor.getMarkdown()).toContain('Edited Context');
    expect(editor.collectPairs()[0].answer).toBe('Final after mapped edit');
    expect(request.notify).toHaveBeenCalledWith(expect.stringContaining('已锁定'));
  });

  it('commits reask in one undo unit without absorbing typing during or after generation', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    const view = editor.view();
    click(root, 'reask');
    view.dispatch(view.state.tr.insertText('During ', 1));
    request.stream('First part');
    request.stream('Second part');
    request.resolve('Complete **replacement**');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    const complete = editor.getMarkdown();
    const answer = callouts(editor, 'ai')[0];
    view.dispatch(view.state.tr.insertText('!', answer.pos + answer.node.nodeSize - 2));
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(complete);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.collectPairs()[0].answer).toBe('Original **answer**.');
    expect(editor.getMarkdown()).toContain('During Context');
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(complete);
  });

  it('converts ?? and inserts a complete new answer as one action, preserving intervening typing', async () => {
    const request = deferredAsk();
    const { editor } = await open('?? Why?\n\nTail', { qa: request });
    const view = editor.view();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.firstChild!.nodeSize - 1)));
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(request.ask).toHaveBeenCalledOnce();
    request.stream('Partial new answer');
    expect(editor.getMarkdown()).not.toContain('[!ai]');
    view.dispatch(view.state.tr.insertText(' typed', view.state.doc.content.size - 1));
    request.resolve('Complete new answer');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    expect(editor.collectPairs()).toEqual([{ id: callouts(editor, 'question')[0].node.attrs.id, answerId: callouts(editor, 'ai')[0].node.attrs.id, question: 'Why?', anchor: '', answer: 'Complete new answer' }]);
    const completed = editor.getMarkdown();
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toContain('?? Why?');
    expect(editor.getMarkdown()).toContain('Tail typed');
    expect(editor.getMarkdown()).not.toContain('[!ai]');
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(completed);
  });

  it('blocks undo that would damage a pending answer, but permits undo of adjacent typing', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    const view = editor.view();
    const answer = callouts(editor, 'ai')[0];
    view.dispatch(view.state.tr.insertText('saved ', answer.pos + 2));
    click(root, 'reask');
    const protectedDoc = editor.getMarkdown();
    undo(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe(protectedDoc);
    view.dispatch(view.state.tr.insertText('typing ', 1));
    undo(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe(protectedDoc);
    editor.cancelGeneration();
    request.resolve('ignored');
  });

  it('merges and deletes complete answers with reversible whole actions', async () => {
    const { editor, root } = await open(legacy);
    const view = editor.view();
    const original = editor.getMarkdown();
    click(root, 'merge');
    expect(callouts(editor, 'ai')).toEqual([]);
    expect(editor.getMarkdown()).toContain('Original **answer**.');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(original);
    click(root, 'delete');
    expect(editor.getMarkdown()).not.toContain('Original **answer**.');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(original);
  });

  it('replaces the whole document in one undo unit and clears old undo/redo on reload', async () => {
    const { editor } = await open('Original');
    const view = editor.view();
    view.dispatch(view.state.tr.insertText(' typing', 9));
    editor.replaceAll('Whole replacement');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown().trim()).toBe('Original typing');
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown().trim()).toBe('Whole replacement');
    editor.replaceAll('External disk version', false);
    expect(undo(view.state, view.dispatch)).toBe(false);
    expect(redo(view.state, view.dispatch)).toBe(false);
    expect(editor.getMarkdown().trim()).toBe('External disk version');
  });

  it('aborts on replacement and ignores detached or destroyed editor callbacks', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    click(root, 'reask');
    editor.replaceAll('External', false);
    expect(request.signal().aborted).toBe(true);
    request.stream('stale replacement');
    request.resolve('stale result');
    await Promise.resolve();
    expect(editor.getMarkdown().trim()).toBe('External');

    editor.replaceAll(legacy, false);
    click(root, 'reask');
    const beforeDetach = editor.getMarkdown();
    root.remove();
    request.stream('detached chunk');
    expect(request.signal().aborted).toBe(true);
    request.resolve('detached result');
    await Promise.resolve();
    expect(editor.getMarkdown()).toBe(beforeDetach);

    document.body.append(root);
    click(root, 'reask');
    editors.splice(editors.indexOf(editor), 1);
    await editor.destroy();
    expect(request.signal().aborted).toBe(true);
    expect(() => request.stream('destroyed chunk')).not.toThrow();
    request.resolve('destroyed result');
    await Promise.resolve();
  });
});

describe('selection context and follow-up ancestry', () => {
  it('captures selection with the shortcut and keeps it after nearby edits and Markdown reload', async () => {
    const request = deferredAsk();
    const { editor } = await open('Selected words and the rest.\n\nTail', { qa: request });
    const view = editor.view();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 15)));
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    const question = callouts(editor, 'question')[0];
    expect(question.node.attrs.context).toBe('Selected words');
    expect(question.node.textContent).toBe('');
    expect(request.ask).not.toHaveBeenCalled();
    view.dispatch(view.state.tr.insertText('What does this mean?', question.pos + 2));
    view.dispatch(view.state.tr.insertText('Changed ', 1));
    editor.replaceAll(editor.getMarkdown(), false);
    expect(editor.focusQuestion(question.node.attrs.id)).toBe(true);
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    expect(request.ask.mock.calls[0][0]).toMatchObject({ question: 'What does this mean?', anchor: 'Selected words' });
    expect(request.ask.mock.calls[0][0].document).not.toMatch(/askdown:|\^q-/);
    request.resolve('Meaning');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    expect(editor.collectPairs()[0].anchor).toBe('Selected words');
  });

  it('uses the current paragraph for an immediate named action', async () => {
    const request = deferredAsk();
    const { editor } = await open('A **strong** claim.', { qa: request });
    expect(editor.askSelection('反驳我', '反驳我')).toBe(true);
    expect(request.ask.mock.calls[0][0]).toMatchObject({ question: '反驳我', template: '反驳我', anchor: 'A **strong** claim.' });
    request.resolve('Counterargument');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    expect(editor.collectPairs()[0].question).toBe('反驳我');
  });

  it('inserts follow-ups in one undo step and assembles a moved, reloaded chain by IDs', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    const view = editor.view();
    const parentId = callouts(editor, 'question')[0].node.attrs.id;
    const original = editor.getMarkdown();
    expect(editor.insertFollowUp(parentId, 'How?')).toBe(true);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(original);
    expect(redo(view.state, view.dispatch)).toBe(true);
    let child = callouts(editor, 'question')[1];
    expect(child.node.attrs.parentId).toBe(parentId);
    expect(child.node.attrs.context).toBe('Context');
    editor.focusQuestion(child.node.attrs.id);
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(request.ask.mock.calls[0][0].history).toEqual([{ question: 'Why?', answer: 'Original **answer**.' }]);
    request.resolve('Because of this.');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    child = callouts(editor, 'question')[1];
    const childId = child.node.attrs.id;
    const move = view.state.tr.delete(child.pos, child.pos + child.node.nodeSize);
    view.dispatch(move.insert(0, child.node));
    editor.replaceAll(editor.getMarkdown(), false);
    expect(editor.insertFollowUp(childId, 'What next?')).toBe(true);
    const grandchild = callouts(editor, 'question').find(({ node }) => node.attrs.parentId === childId)!;
    editor.focusQuestion(grandchild.node.attrs.id);
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    expect(request.ask.mock.calls[1][0]).toMatchObject({
      anchor: 'Context',
      history: [{ question: 'Why?', answer: 'Original **answer**.' }, { question: 'How?', answer: 'Because of this.' }],
    });
    request.resolve('Next step.');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    click(root, 'followup');
    expect(callouts(editor, 'question').some(({ node }) => node.attrs.parentId === parentId && node.textContent === '')).toBe(true);
  });

  it('rejects cyclic and ambiguous ancestors without starting generation', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    const view = editor.view();
    const parent = callouts(editor, 'question')[0];
    expect(editor.insertFollowUp(parent.node.attrs.id, 'Child')).toBe(true);
    const child = callouts(editor, 'question')[1];
    view.dispatch(view.state.tr.setNodeMarkup(parent.pos, undefined, { ...parent.node.attrs, parentId: child.node.attrs.id }));
    editor.focusQuestion(child.node.attrs.id);
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(request.ask).not.toHaveBeenCalled();
    expect(request.notify).toHaveBeenCalled();
    view.dispatch(view.state.tr.setNodeMarkup(parent.pos, undefined, parent.node.attrs));
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, parent.node));
    editor.focusQuestion(child.node.attrs.id);
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(request.ask).not.toHaveBeenCalled();
    click(root, 'followup');
    expect(callouts(editor, 'question')).toHaveLength(3);
  });
});

describe('accessible answer actions and persistent collapse', () => {
  it('lets native controls receive Enter and activates only on click', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    editor.focusQuestion(callouts(editor, 'question')[0].node.attrs.id);
    const button = root.querySelector<HTMLButtonElement>('[data-action="shorter"]')!;
    expect(button.tabIndex).toBe(0);
    button.focus();
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    button.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(request.ask).not.toHaveBeenCalled();
    button.click();
    expect(request.ask).toHaveBeenCalledOnce();
    expect(request.ask.mock.calls[0][0]).toMatchObject({ question: 'Why?', style: 'shorter', previousAnswer: 'Original **answer**.' });
    request.resolve('Short.');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    expect(document.activeElement).toBe(root.querySelector('[data-action="shorter"]'));
    expect(undo(editor.view().state, editor.view().dispatch)).toBe(true);
    expect(editor.collectPairs()[0].answer).toBe('Original **answer**.');
  });

  it.each(['detailed', 'alternative'] as const)('passes %s with the original complete answer', async (style) => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    click(root, style);
    expect(request.ask.mock.calls[0][0]).toMatchObject({ style, previousAnswer: 'Original **answer**.' });
    request.resolve('Replacement.');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    expect(editor.collectPairs()[0].answer).toBe('Replacement.');
  });

  it('roundtrips collapse and restores it with one undo/redo operation', async () => {
    const { editor, root } = await open(legacy);
    const view = editor.view();
    click(root, 'toggle');
    const toggle = root.querySelector<HTMLButtonElement>('[data-action="toggle"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)!.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    const collapsed = editor.getMarkdown();
    expect(collapsed).toContain('[!ai]-');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(root.querySelector('[data-action="toggle"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(collapsed);
    editor.replaceAll(collapsed, false);
    expect(root.querySelector('[data-action="toggle"]')!.getAttribute('aria-expanded')).toBe('false');
    click(root, 'toggle');
    expect(editor.getMarkdown()).toContain('[!ai]+');
  });
});

describe('merged answer provenance', () => {
  it('retains editable rich Markdown on reload, clears only when its content changes, and restores on undo', async () => {
    const { editor, root } = await open(legacy.replace('Original **answer**.', 'Original **answer**.\n>\n> - one\n> - two'));
    const view = editor.view();
    click(root, 'merge');
    const merged = editor.getMarkdown();
    expect(merged).toContain('<!-- askdown:origin ');
    expect(merged).toContain('- one');
    expect(root.querySelector('.ai-origin strong')!.textContent).toBe('answer');
    expect(root.querySelectorAll('.ai-origin li')).toHaveLength(2);
    editor.replaceAll(merged, false);
    expect(editor.getMarkdown()).toBe(merged);
    view.dispatch(view.state.tr.insertText('Elsewhere ', 1));
    expect(root.querySelector('.ai-origin')).not.toBeNull();
    let origin: { node: PMNode; pos: number } | undefined;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'ai_origin') origin = { node, pos };
    });
    view.dispatch(view.state.tr.insertText('Human ', origin!.pos + 2));
    expect(root.querySelector('.ai-origin')).toBeNull();
    expect(editor.getMarkdown()).not.toContain('askdown:origin');
    expect(editor.getMarkdown()).toContain('Human Original **answer**.');
    expect(editor.getMarkdown()).toContain('- two');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(root.querySelector('.ai-origin')).not.toBeNull();
    expect(editor.getMarkdown()).toContain('Elsewhere Context');
    expect(editor.getMarkdown()).not.toContain('Human Original');
  });

  it('keeps provenance out of model context and restores editor focus after deleting an answer', async () => {
    const request = deferredAsk();
    const { editor, root } = await open(legacy, { qa: request });
    click(root, 'merge');
    expect(editor.askSelection('举个例子')).toBe(true);
    expect(request.ask.mock.calls[0][0].document).not.toMatch(/askdown:|\^q-/);
    request.resolve('Example.');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    root.querySelector<HTMLButtonElement>('[data-action="delete"]')!.focus();
    click(root, 'delete');
    expect(editor.view().hasFocus()).toBe(true);
    expect(editor.getMarkdown()).not.toContain('Example.');
    expect(root.querySelector('.ai-origin')).not.toBeNull();
  });
});
