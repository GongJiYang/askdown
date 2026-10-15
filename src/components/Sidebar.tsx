import { useMemo, useState } from 'react';
import type { FileEntry } from '../fs';

interface Props {
  vaultName: string;
  files: FileEntry[];
  current: string | null;
  providerText: string;
  onOpen: (path: string) => void;
  onCreate: (name: string) => Promise<void> | void;
  onSwitchVault: () => void;
  onRefresh: () => void;
  onSettings: () => void;
}

export function Sidebar({ vaultName, files, current, providerText, onOpen, onCreate, onSwitchVault, onRefresh, onSettings }: Props) {
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return files
      .filter((x) => !/\.notes\.md$/i.test(x.path))
      .filter((x) => !f || x.path.toLowerCase().includes(f));
  }, [files, filter]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    await onCreate(n);
    setName('');
    setCreating(false);
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <div className="vault-name" title={vaultName}>
          {vaultName}
        </div>
        <button type="button" className="icon-btn" onClick={onSwitchVault} title="换一个文件夹">
          切换
        </button>
      </div>

      <div className="sidebar-tools">
        <input id="file-filter" className="input" placeholder="筛选文件" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button type="button" className="btn" onClick={() => setCreating((v) => !v)}>
          新建
        </button>
      </div>

      {creating && (
        <form className="new-file" onSubmit={submit}>
          <input
            id="new-file-name"
            className="input"
            autoFocus
            placeholder="文件名，可以带子文件夹：读书/xxx"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
          />
          <button type="submit" className="btn primary">
            创建
          </button>
        </form>
      )}

      <ul className="file-list">
        {visible.map((f) => {
          const parts = f.path.replace(/\.md$/i, '').split('/');
          const base = parts.pop()!;
          return (
            <li key={f.path}>
              <button type="button" className={'file' + (f.path === current ? ' active' : '')} onClick={() => onOpen(f.path)} title={f.path}>
                <span className="file-name">{base}</span>
                {parts.length > 0 && <span className="file-dir">{parts.join(' / ')}</span>}
              </button>
            </li>
          );
        })}
        {!visible.length && <li className="file-empty">{files.length ? '没有匹配的文件' : '这个文件夹里还没有 Markdown 文件'}</li>}
      </ul>

      <div className="sidebar-foot">
        <button type="button" className="provider" onClick={onSettings} title="模型设置">
          <span className="dot" />
          {providerText}
        </button>
        <button type="button" className="icon-btn" onClick={onRefresh} title="重新扫描文件夹">
          刷新
        </button>
      </div>
    </nav>
  );
}
