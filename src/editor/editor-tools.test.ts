import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from '@milkdown/kit/prose/state';
import { undo } from '@milkdown/kit/prose/history';
import { createEditor, type CreateEditorOptions, type EditorHandle } from './createEditor';

const editors: EditorHandle[] = [];
afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function open(markdown: string, options: Partial<CreateEditorOptions> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = await createEditor(root, { markdown, ...options });
  editor.view().setProps({ handleScrollToSelection: () => true });
  editors.push(editor);
  editor.focus();
  return { editor, root };
}

function key(editor: EditorHandle, key: string, extra: KeyboardEventInit = {}) {
  editor.view().dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
}

function typeSlash(editor: EditorHandle, query = '') {
  const view = editor.view();
  view.dispatch(view.state.tr.insertText(`/${query}`));
}

function menu() { return document.querySelector<HTMLElement>('.askdown-slash-menu:not([hidden])'); }

describe('structural outline navigation', () => {
  it('tracks positions and text, ignores non-heading changes, and retains subscriptions on disk reload', async () => {
    const { editor } = await open('# Same\n\nBody\n\n## Same\n\nTail');
    const notify = vi.fn();
    const unsubscribe = editor.subscribeOutline(notify);
    const initial = editor.outline();
    expect(initial.map(({ level, text }) => ({ level, text }))).toEqual([{ level: 1, text: 'Same' }, { level: 2, text: 'Same' }]);
    const view = editor.view();
    view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1));
    expect(notify).not.toHaveBeenCalled();
    view.dispatch(view.state.tr.insertText('New ', 1));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(editor.outline()[0].text).toBe('New Same');
    expect(editor.outline()[1].pos).toBe(initial[1].pos + 4);
    editor.replaceAll(editor.getMarkdown(), false);
    expect(notify).toHaveBeenCalledTimes(1);
    view.dispatch(view.state.tr.insertText('!', 1));
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
    view.dispatch(view.state.tr.insertText('!', 1));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('jumps to the selected duplicate heading in a readonly document without modifying it', async () => {
    const { editor } = await open('# Duplicate\n\n## Duplicate', { readonly: () => true });
    const original = editor.getMarkdown();
    const second = editor.outline()[1];
    expect(editor.jumpToHeading(second.pos)).toBe(true);
    expect(editor.view().state.selection.from).toBe(second.pos + 1);
    expect(editor.getMarkdown()).toBe(original);
    expect(editor.jumpToHeading(second.pos + 1)).toBe(false);
    expect(editor.jumpToHeading(-1)).toBe(false);
  });
});

describe('slash insertion', () => {
  it('selects headings by keyboard and preserves trailing text and undo', async () => {
    const { editor } = await open('Existing text');
    const view = editor.view();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    typeSlash(editor, 'heading');
    expect(menu()).not.toBeNull();
    key(editor, 'ArrowDown');
    key(editor, 'Enter');
    expect(view.state.doc.firstChild!.type.name).toBe('heading');
    expect(view.state.doc.firstChild!.attrs.level).toBe(2);
    expect(view.state.doc.firstChild!.textContent).toBe('Existing text');
    expect(menu()).toBeNull();
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.firstChild!.textContent).toBe('/headingExisting text');
  });

  it.each([
    ['bullet', 'bullet_list'], ['ordered', 'ordered_list'], ['task', 'bullet_list'],
    ['quote', 'blockquote'], ['code', 'code_block'],
  ])('inserts %s with the mouse into the current paragraph', async (command, nodeType) => {
    const { editor } = await open('');
    typeSlash(editor, command);
    const button = menu()!.querySelector<HTMLButtonElement>(`[data-slash-command="${command}"]`)!;
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button.click();
    const node = editor.view().state.doc.firstChild!;
    expect(node.type.name).toBe(nodeType);
    if (command === 'task') expect(node.firstChild!.attrs.checked).toBe(false);
    expect(editor.view().state.selection.$from.parent.isTextblock).toBe(true);
    expect(editor.getMarkdown()).not.toContain(`/${command}`);
  });

  it('dismisses with Escape, ignores composing Enter, and offers questions only with QA', async () => {
    const { editor } = await open('');
    typeSlash(editor);
    expect(menu()!.querySelector('[data-slash-command="question"]')).toBeNull();
    key(editor, 'Escape');
    expect(menu()).toBeNull();
    editor.view().dispatch(editor.view().state.tr);
    expect(menu()).toBeNull();
    const before = editor.getMarkdown();
    editor.view().dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    key(editor, 'Enter', { isComposing: true });
    expect(editor.getMarkdown()).toBe(before);
    editor.view().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await Promise.resolve();
    typeSlash(editor, 'question');
    expect(menu()).toBeNull();

    const qa = { ask: vi.fn(async () => 'Answer'), notify: vi.fn() };
    const second = await open('', { qa });
    typeSlash(second.editor, 'question');
    key(second.editor, 'Enter');
    const question = second.editor.view().state.doc.firstChild!;
    expect(question.type.name).toBe('callout');
    expect(question.attrs.kind).toBe('question');
    expect(question.attrs.id).toEqual(expect.any(String));
    second.editor.view().dispatch(second.editor.view().state.tr.insertText('Why?'));
    key(second.editor, 'Enter');
    await vi.waitFor(() => expect(second.editor.isGenerating()).toBe(false));
    expect(qa.ask).toHaveBeenCalledOnce();
    expect(second.editor.collectPairs()[0].answer).toBe('Answer');
  });

  it('never intercepts readonly paragraphs or nonempty selections', async () => {
    const { editor } = await open('/heading', { readonly: () => true });
    const view = editor.view();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9)));
    expect(menu()).toBeNull();
    const original = editor.getMarkdown();
    key(editor, 'Enter');
    expect(editor.getMarkdown()).toBe(original);
    const second = await open('/heading');
    const other = second.editor.view();
    other.dispatch(other.state.tr.setSelection(TextSelection.create(other.state.doc, 1, 9)));
    expect(menu()).toBeNull();
  });
});

describe('stream preview frame updates', () => {
  it('coalesces tokens, retains preview DOM and focus, and never transacts until the final commit', async () => {
    let stream!: (text: string) => void;
    let finish!: (text: string) => void;
    const qa = { ask: vi.fn((_req: unknown, onText: (text: string) => void) => {
      stream = onText;
      return new Promise<string>((resolve) => { finish = resolve; });
    }), notify: vi.fn() };
    const { editor, root } = await open('> [!question]\n> Why?', { qa });
    root.querySelector<HTMLButtonElement>('[data-action="ask"]')!.click();
    let frame: FrameRequestCallback | null = null;
    const schedule = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => { frame = callback; return 42; });
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => { frame = null; });
    const paint = () => { const callback = frame!; frame = null; callback(0); };
    const preview = root.querySelector<HTMLElement>('[data-generation]')!;
    const text = preview.querySelector('.callout-body')!.firstChild as Text;
    const stop = preview.querySelector<HTMLButtonElement>('button')!;
    stop.focus();
    const state = editor.view().state;
    const original = editor.getMarkdown();
    stream('A');
    stream('A longer answer');
    expect(schedule).toHaveBeenCalledTimes(1);
    paint();
    expect(text.data).toBe('A longer answer');
    const append = vi.spyOn(text, 'appendData');
    stream('A longer answer still');
    paint();
    expect(append).toHaveBeenCalledWith(' still');
    stream('Corrected prefix');
    paint();
    expect(text.data).toBe('Corrected prefix');
    expect(preview.querySelector('.callout-body')!.firstChild).toBe(text);
    expect(root.querySelector('[data-generation]')).toBe(preview);
    expect(document.activeElement).toBe(stop);
    expect(editor.view().state).toBe(state);
    expect(editor.getMarkdown()).toBe(original);
    stream('Pending frame');
    finish('Final **Markdown**');
    await vi.waitFor(() => expect(editor.isGenerating()).toBe(false));
    expect(cancel).toHaveBeenCalledWith(42);
    expect(root.querySelector('[data-generation]')).toBeNull();
    expect(editor.collectPairs()[0].answer).toBe('Final **Markdown**');
    expect(undo(editor.view().state, editor.view().dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(original);
  });
});
