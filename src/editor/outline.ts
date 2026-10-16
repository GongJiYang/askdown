import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

export interface OutlineHeading { pos: number; level: number; text: string }

function headings(doc: PMNode): OutlineHeading[] {
  const result: OutlineHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') result.push({ pos, level: node.attrs.level, text: node.textContent });
  });
  return result;
}

export function createOutline() {
  const key = new PluginKey<OutlineHeading[]>('askdown-outline');
  const listeners = new Set<() => void>();
  const plugin = new Plugin<OutlineHeading[]>({
    key,
    state: {
      init: (_, state) => headings(state.doc),
      apply(tr, previous) {
        if (!tr.docChanged) return previous;
        const next = headings(tr.doc);
        return next.length === previous.length && next.every((heading, index) => {
          const old = previous[index];
          return heading.pos === old.pos && heading.level === old.level && heading.text === old.text;
        }) ? previous : next;
      },
    },
    view: () => ({
      update(view, previous) {
        const next = key.getState(view.state)!;
        const old = key.getState(previous)!;
        // A history reset recreates plugin state even when headings have not changed.
        if (next !== old && (next.length !== old.length || next.some((heading, index) => {
          const before = old[index];
          return heading.pos !== before.pos || heading.level !== before.level || heading.text !== before.text;
        }))) for (const listener of listeners) listener();
      },
    }),
  });
  return {
    destroy: () => listeners.clear(),
    plugin,
    outline: (view: EditorView) => key.getState(view.state)!.map((heading) => ({ ...heading })),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    jump(view: EditorView, pos: number) {
      if (!Number.isInteger(pos) || pos < 0 || pos >= view.state.doc.content.size || view.state.doc.nodeAt(pos)?.type.name !== 'heading') return false;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)).scrollIntoView());
      view.focus();
      return true;
    },
  };
}
