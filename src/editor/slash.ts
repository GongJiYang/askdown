import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model';
import { closeHistory } from '@milkdown/kit/prose/history';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { QUESTION, newCalloutId } from './callout';
import './slash.css';

interface Item { id: string; label: string; search: string; level?: number }
const items: Item[] = [
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ id: `heading-${level}`, label: `${level} 级标题`, search: `heading h${level} 标题`, level })),
  { id: 'bullet', label: '无序列表', search: 'bullet list 无序列表' },
  { id: 'ordered', label: '有序列表', search: 'ordered numbered list 有序列表' },
  { id: 'task', label: '任务列表', search: 'task todo checkbox 任务待办列表' },
  { id: 'quote', label: '引用', search: 'quote blockquote 引用' },
  { id: 'code', label: '代码块', search: 'code 代码块' },
  { id: 'question', label: '问题', search: 'question ask ai 问题提问' },
];
interface Trigger { pos: number; query: string; end: number; node: PMNode }

export function createSlashMenu(hasQa: boolean, readonly: () => boolean) {
  let menu: HTMLDivElement | null = null;
  let active: Trigger | null = null;
  let matches: Item[] = [];
  let selected = 0;
  let dismissed = '';
  let composing = false;
  const menuId = `slash-${newCalloutId()}`;
  const signature = (trigger: Trigger) => `${trigger.pos}:${trigger.query}`;

  function trigger(view: EditorView): Trigger | null {
    const { empty, $from } = view.state.selection;
    if (!view.editable || readonly() || composing || view.composing || !empty || $from.parent.type.name !== 'paragraph') return null;
    const prefix = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
    const match = /^\/([^\s/]*)$/.exec(prefix);
    return match ? { pos: $from.before(), query: match[1].toLowerCase(), end: $from.pos, node: $from.parent } : null;
  }

  function replacement(view: EditorView, target: Trigger, item: Item): PMNode {
    const { nodes } = view.state.schema;
    const content = target.node.content.cut(target.end - target.pos - 1);
    const paragraph = nodes.paragraph.create(null, content);
    if (item.level) return nodes.heading.create({ level: item.level }, content);
    if (item.id === 'code') return nodes.code_block.create(null, paragraph.textContent ? view.state.schema.text(paragraph.textContent) : null);
    if (item.id === 'quote') return nodes.blockquote.create(null, paragraph);
    if (item.id === 'question') return nodes.callout.create({ kind: QUESTION }, paragraph);
    const ordered = item.id === 'ordered';
    const child = nodes.list_item.create({ listType: ordered ? 'ordered' : 'bullet', label: ordered ? '1.' : '•', spread: false, checked: item.id === 'task' ? false : null }, paragraph);
    return nodes[ordered ? 'ordered_list' : 'bullet_list'].create({ spread: false }, child);
  }

  function hide(view: EditorView) {
    if (menu) menu.hidden = true;
    view.dom.removeAttribute('aria-controls');
    view.dom.removeAttribute('aria-activedescendant');
  }

  function apply(view: EditorView, item: Item) {
    const current = trigger(view);
    if (!current || !active || signature(current) !== signature(active)) return;
    let node = replacement(view, current, item);
    const $pos = view.state.doc.resolve(current.pos);
    if (!$pos.parent.canReplace($pos.index(), $pos.index() + 1, Fragment.from(node))) return;
    if (item.id === 'question') node = node.type.create({ ...node.attrs, id: newCalloutId() }, node.content);
    const tr = closeHistory(view.state.tr).replaceWith(current.pos, current.pos + current.node.nodeSize, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(current.pos + 1))).scrollIntoView();
    dismissed = signature(current);
    view.dispatch(tr);
    view.dispatch(closeHistory(view.state.tr).setMeta('addToHistory', false));
    view.focus();
  }

  function update(view: EditorView) {
    const current = trigger(view);
    if (!current) {
      active = null;
      dismissed = '';
      hide(view);
      return;
    }
    if (!active || signature(active) !== signature(current)) selected = 0;
    active = current;
    if (dismissed === signature(current)) { hide(view); return; }
    const $pos = view.state.doc.resolve(current.pos);
    matches = items.filter((item) => (item.id !== 'question' || hasQa)
      && (!current.query || `${item.label} ${item.search}`.includes(current.query))
      && $pos.parent.canReplace($pos.index(), $pos.index() + 1, Fragment.from(replacement(view, current, item))));
    if (!matches.length || !menu) { hide(view); return; }
    selected = Math.min(selected, matches.length - 1);
    menu.replaceChildren(...matches.map((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `${menuId}-${item.id}`;
      button.dataset.slashCommand = item.id;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === selected));
      button.tabIndex = -1;
      button.textContent = item.label;
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => apply(view, item));
      return button;
    }));
    menu.hidden = false;
    view.dom.setAttribute('aria-controls', menuId);
    view.dom.setAttribute('aria-activedescendant', `${menuId}-${matches[selected].id}`);
    const dom = view.nodeDOM(current.pos);
    const rect = (dom instanceof Element ? dom : view.dom).getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
  }

  const plugin = new Plugin({
    props: {
      handleDOMEvents: {
        compositionstart(view) { composing = true; hide(view); return false; },
        compositionend(view) { composing = false; queueMicrotask(() => { if (!view.isDestroyed) update(view); }); return false; },
        blur(view) { hide(view); return false; },
        focus(view) { update(view); return false; },
      },
    },
    view(view) {
      menu = document.createElement('div');
      menu.id = menuId;
      menu.className = 'askdown-slash-menu';
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-label', '插入内容');
      document.body.append(menu);
      const reposition = () => { if (menu && !menu.hidden) update(view); };
      window.addEventListener('resize', reposition);
      document.addEventListener('scroll', reposition, true);
      update(view);
      return {
        update,
        destroy() {
          window.removeEventListener('resize', reposition);
          document.removeEventListener('scroll', reposition, true);
          hide(view);
          menu?.remove();
          menu = null;
        },
      };
    },
  });

  return {
    plugin,
    handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
      if (event.isComposing || event.keyCode === 229 || composing || view.composing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
      const current = trigger(view);
      if (!current || !active || signature(current) !== signature(active) || !menu || menu.hidden) return false;
      if (event.key === 'Escape') { dismissed = signature(current); hide(view); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        update(view);
        menu.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
      } else if (event.key === 'Enter') apply(view, matches[selected]);
      else return false;
      event.preventDefault();
      return true;
    },
  };
}
