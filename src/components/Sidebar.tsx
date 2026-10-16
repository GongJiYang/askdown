import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry } from '../fs';
import './Sidebar.css';

interface Props {
  vaultName: string;
  files: FileEntry[];
  current: string | null;
  providerText: string;
  onOpen: (path: string) => void;
  onCreate: (name: string) => Promise<void> | void;
  onMove: (path: string, destination: string) => Promise<boolean>;
  onDelete: (path: string) => Promise<boolean>;
  onSwitchVault: () => void;
  onRefresh: () => void;
  onSettings: () => void;
  onImport: () => void;
}

type Operation = { kind: 'rename' | 'move' | 'delete'; path: string };
interface TreeNode { path: string; name: string; folder: boolean; children: Map<string, TreeNode> }
interface TreeRow { node: TreeNode; depth: number; parent: string | null }

function FileOperationDialog({ operation, onMove, onDelete, onClose }: Pick<Props, 'onMove' | 'onDelete'> & { operation: Operation; onClose: () => void }) {
  const [value, setValue] = useState(operation.kind === 'rename' ? operation.path.split('/').pop()! : operation.path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  const title = operation.kind === 'rename' ? '重命名文件' : operation.kind === 'move' ? '移动文件' : '删除文件';
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => previous?.focus();
  }, []);

  async function submit() {
    if (pending.current) return;
    setError('');
    let destination = value.trim();
    if (operation.kind !== 'delete') {
      if (!destination || /[\\:\x00-\x1f]/.test(destination) || destination.split('/').some((part) => !part || part.startsWith('.') || /[. ]$/.test(part) || part === 'node_modules')) {
        setError('请输入文件库内的相对路径，不能使用隐藏目录、路径跳转或保留名称。'); return;
      }
      if (operation.kind === 'rename' && destination.includes('/')) {
        setError('重命名只修改当前文件夹内的文件名；更换文件夹请使用移动。'); return;
      }
      if (!/\.md$/i.test(destination)) destination += '.md';
      if (/\.(notes|annotations)\.md$/i.test(destination)) {
        setError('此名称保留给关联笔记或批注，请选择其他名称。'); return;
      }
      if (operation.kind === 'rename') destination = operation.path.slice(0, operation.path.lastIndexOf('/') + 1) + destination;
    }
    pending.current = true;
    setBusy(true);
    try {
      const completed = operation.kind === 'delete' ? await onDelete(operation.path) : await onMove(operation.path, destination);
      if (completed) onClose();
      else setError('操作未完成。请处理保存冲突或查看错误提示，然后重试。');
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <div className="modal-backdrop">
    <form ref={dialog} className="modal file-operation-dialog" role="dialog" aria-modal="true" aria-labelledby="file-operation-title" aria-busy={busy}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending.current) { event.preventDefault(); onClose(); }
        if (event.key === 'Tab') {
          const nodes = Array.from(dialog.current!.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'));
          const first = nodes[0]; const last = nodes.at(-1);
          if (!first) event.preventDefault();
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <h2 id="file-operation-title">{title}</h2>
      <p className="file-operation-path">{operation.path}</p>
      {operation.kind === 'delete' ? <p>确认删除此正文及同名笔记、批注和阅读信息？文件及恢复历史会保留在文件库的 <code>.askdown/trash</code> 中，可手动恢复；文件将从列表移除。</p> : <>
        <label>{operation.kind === 'rename' ? '新文件名' : '目标相对路径（包含文件名）'}
          <input className="input" value={value} disabled={busy} required onChange={(event) => setValue(event.target.value)} placeholder={operation.kind === 'move' ? '读书/新文件夹/文件名.md' : '文件名.md'} />
        </label>
        <p className="hint">{operation.kind === 'move' ? '不存在的文件夹会自动创建。' : ''}同名笔记、批注、阅读信息及恢复历史会一起移动；已有文件不会被覆盖。</p>
      </>}
      {error && <p className="file-alert" role="alert">{error}</p>}
      {busy && <p role="status">正在保存并{operation.kind === 'delete' ? '移入回收目录' : '移动文件'}…</p>}
      <div className="modal-foot">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className={'btn ' + (operation.kind === 'delete' ? 'file-delete' : 'primary')} disabled={busy}>{operation.kind === 'delete' ? '确认删除并保留恢复副本' : '确认'}</button>
      </div>
    </form>
  </div>;
}

export function Sidebar({ vaultName, files, current, providerText, onOpen, onCreate, onMove, onDelete, onSwitchVault, onRefresh, onSettings, onImport }: Props) {
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const tree = useRef<HTMLUListElement>(null);
  const query = filter.trim().toLowerCase();

  const roots = useMemo(() => {
    const roots = new Map<string, TreeNode>();
    for (const file of files) {
      if (/\.(notes|annotations)\.md$/i.test(file.path) || (query && !file.path.toLowerCase().includes(query))) continue;
      const parts = file.path.split('/');
      let children = roots;
      let path = '';
      parts.forEach((part, index) => {
        path += (index ? '/' : '') + part;
        let node = children.get(part);
        if (!node) {
          node = { path, name: part, folder: index < parts.length - 1, children: new Map() };
          children.set(part, node);
        }
        children = node.children;
      });
    }
    return roots;
  }, [files, query]);

  // Selecting a file from outside the tree reveals its whole ancestry.
  useEffect(() => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      for (const path of previous) if (current?.startsWith(path + '/')) next.delete(path);
      return next.size === previous.size ? previous : next;
    });
    setFocused(current);
  }, [current]);

  const rows = useMemo(() => {
    const rows: TreeRow[] = [];
    function visit(children: Map<string, TreeNode>, depth: number, parent: string | null) {
      const sorted = [...children.values()].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
      for (const node of sorted) {
        rows.push({ node, depth, parent });
        if (node.folder && (query || !collapsed.has(node.path))) visit(node.children, depth + 1, node.path);
      }
    }
    visit(roots, 1, null);
    return rows;
  }, [roots, collapsed, query]);
  const tabPath = rows.some(({ node }) => node.path === focused) ? focused : rows[0]?.node.path;

  function toggle(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function focusRow(path: string | undefined) {
    if (!path) return;
    setFocused(path);
    const button = Array.from(tree.current?.querySelectorAll<HTMLButtonElement>('[data-tree-path]') ?? []).find((element) => element.dataset.treePath === path);
    button?.focus();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setCreateError('');
    try {
      await onCreate(name.trim());
      setName(''); setCreating(false);
    } catch (cause) { setCreateError(String((cause as Error)?.message ?? cause)); }
  }

  return <nav className="sidebar" aria-label="文件库">
    <div className="sidebar-head">
      <div className="vault-name" title={vaultName}>{vaultName}</div>
      <button type="button" className="icon-btn" onClick={onSwitchVault} title="换一个文件夹">切换</button>
    </div>
    <div className="sidebar-tools">
      <input id="file-filter" className="input" aria-label="筛选文件" placeholder="筛选文件" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <button type="button" className="btn" onClick={() => setCreating((value) => !value)}>新建</button>
      <button type="button" className="btn" onClick={onImport}>导入</button>
    </div>
    {creating && <form className="new-file" onSubmit={submit}>
      <input id="new-file-name" className="input" aria-label="新文件名" autoFocus placeholder="读书/文件名" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Escape' && setCreating(false)} />
      <button type="submit" className="btn primary">创建</button>
    </form>}
    {createError && <p className="file-tree-error" role="alert">{createError}</p>}
    <div className="file-tree-tools">
      <button type="button" className="icon-btn" onClick={() => setCollapsed(new Set())}>展开全部</button>
      <button type="button" className="icon-btn" disabled={!!query} onClick={() => {
        const folders = new Set<string>();
        function visit(children: Map<string, TreeNode>) {
          for (const node of children.values()) if (node.folder) { folders.add(node.path); visit(node.children); }
        }
        visit(roots); setCollapsed(folders);
      }}>收起全部</button>
    </div>
    <ul ref={tree} className="file-list file-tree" role="tree" aria-label="Markdown 文件">
      {rows.map(({ node, depth, parent }, index) => {
        const expanded = !!query || !collapsed.has(node.path);
        return <li key={node.path} role="none" className="file-tree-item" style={{ paddingLeft: (depth - 1) * 12 }}>
          <div className="file-tree-row">
            <button type="button" role="treeitem" aria-level={depth} aria-expanded={node.folder ? expanded : undefined} aria-selected={node.folder ? undefined : node.path === current}
              data-tree-path={node.path} tabIndex={node.path === tabPath ? 0 : -1} onFocus={() => setFocused(node.path)}
              className={'file' + (node.folder ? ' file-folder' : '') + (node.path === current ? ' active' : '')} title={node.path}
              onClick={() => node.folder ? toggle(node.path) : onOpen(node.path)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); focusRow(rows[index + 1]?.node.path); }
                else if (event.key === 'ArrowUp') { event.preventDefault(); focusRow(rows[index - 1]?.node.path); }
                else if (event.key === 'Home') { event.preventDefault(); focusRow(rows[0]?.node.path); }
                else if (event.key === 'End') { event.preventDefault(); focusRow(rows.at(-1)?.node.path); }
                else if (event.key === 'ArrowRight' && node.folder) { event.preventDefault(); if (!expanded) toggle(node.path); else focusRow(rows[index + 1]?.node.path); }
                else if (event.key === 'ArrowLeft') { event.preventDefault(); if (node.folder && expanded && !query) toggle(node.path); else focusRow(parent ?? undefined); }
                else if (event.key === 'F2' && !node.folder) { event.preventDefault(); setOperation({ kind: 'rename', path: node.path }); }
                else if (event.key === 'Delete' && !node.folder) { event.preventDefault(); setOperation({ kind: 'delete', path: node.path }); }
              }}>
              {node.folder && <span className="file-tree-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>}
              <span className="file-name">{node.folder ? node.name : node.name.replace(/\.md$/i, '')}</span>
            </button>
            {!node.folder && <button type="button" className="icon-btn file-actions-toggle" aria-label={`${node.name} 的文件操作`} aria-expanded={menu === node.path}
              onClick={() => setMenu(menu === node.path ? null : node.path)}>···</button>}
          </div>
          {menu === node.path && !node.folder && <div className="file-actions" role="group" aria-label={`${node.name} 的文件操作`} onKeyDown={(event) => {
            if (event.key === 'Escape') { setMenu(null); focusRow(node.path); }
          }}>
            <button type="button" className="btn" onClick={() => { setMenu(null); setOperation({ kind: 'rename', path: node.path }); }}>重命名</button>
            <button type="button" className="btn" onClick={() => { setMenu(null); setOperation({ kind: 'move', path: node.path }); }}>移动</button>
            <button type="button" className="btn file-delete" onClick={() => { setMenu(null); setOperation({ kind: 'delete', path: node.path }); }}>删除</button>
          </div>}
        </li>;
      })}
      {!rows.length && <li role="none" className="file-empty">{files.length ? '没有匹配的文件' : '这个文件夹里还没有 Markdown 文件'}</li>}
    </ul>
    <div className="sidebar-foot">
      <button type="button" className="provider" onClick={onSettings} title="模型设置"><span className="dot" />{providerText}</button>
      <button type="button" className="icon-btn" onClick={onRefresh} title="重新扫描文件夹">刷新</button>
    </div>
    {operation && <FileOperationDialog operation={operation} onMove={onMove} onDelete={onDelete} onClose={() => {
      setOperation(null); focusRow(operation.path);
    }} />}
  </nav>;
}
