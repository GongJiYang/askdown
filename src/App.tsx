import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { baseName, getFs, isTauri, joinPath, type FileEntry } from './fs';
import { loadSettings, providerLabel, saveSettings, type Settings } from './settings';
import { ensurePrompt, listActionPrompts, loadPrompt, PROMPT_DIR, type PromptName } from './ai/prompts';
import type { EditorHandle } from './editor/createEditor';
import type { QaHooks } from './editor/qa';
import { SAMPLE_DOC } from './sample';
import type { LeaveGuard, SaveStatus } from './components/EditorPane';
import { NotesPanel } from './components/NotesPanel';
import { Sidebar } from './components/Sidebar';
import UpdateButton from './components/UpdateButton';
import { ReadingDocument, type SelectionAction } from './components/ReadingDocument';
import { saveMaterial } from './import/storage';
import type { ImportedMaterial } from './import/types';
import { DocumentOutline } from './components/DocumentOutline';
import { SplitPane } from './components/SplitPane';

const SettingsDialog = lazy(() => import('./components/SettingsDialog').then((module) => ({ default: module.SettingsDialog })));
const ImportDialog = lazy(() => import('./components/ImportDialog').then((module) => ({ default: module.ImportDialog })));
const UsagePanel = lazy(() => import('./components/UsagePanel').then((module) => ({ default: module.UsagePanel })));
const ExportMenu = lazy(() => import('./components/ExportMenu').then((module) => ({ default: module.ExportMenu })));

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: '',
  dirty: '未保存',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
  conflict: '外部修改待处理',
};

const notesPathOf = (file: string) => file.replace(/\.md$/i, '') + '.notes.md';

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [vault, setVault] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [status, setStatus] = useState<{ s: SaveStatus; detail?: string }>({ s: 'idle' });
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [fsKind, setFsKind] = useState<'tauri' | 'browser'>('browser');

  const [startupError, setStartupError] = useState('');
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [actions, setActions] = useState<Array<{ name: string; label: string }>>([]);
  const [actionName, setActionName] = useState('');
  const [creatingAction, setCreatingAction] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [showOutline, setShowOutline] = useState(false);
  const [sourceHandle, setSourceHandle] = useState<EditorHandle | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const mutatingFile = useRef(false);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const listing = useRef(new Map<string, Promise<FileEntry[]>>());
  const selectionAction = useRef<SelectionAction | null>(null);
  const mainGuard = useRef<LeaveGuard | null>(null);
  const notesGuard = useRef<LeaveGuard | null>(null);
  const settingsQueue = useRef<Promise<void>>(Promise.resolve());
  const settingsRef = useRef<Settings | null>(null);
  settingsRef.current = settings;
  const mainHandle = useRef<EditorHandle | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const notify = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const persist = useCallback(async (next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
    const saving = settingsQueue.current.then(() => saveSettings(next));
    settingsQueue.current = saving.catch(() => undefined);
    try {
      await saving;
      return true;
    } catch (error) {
      notify('设置保存失败：' + String((error as Error)?.message ?? error));
      return false;
    }
  }, [notify]);

  const prepareToLeave = useCallback(async () => {
    if (mainGuard.current && !(await mainGuard.current())) return false;
    if (notesGuard.current && !(await notesGuard.current())) return false;
    await settingsQueue.current;
    return true;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let closing = false;
    let approved = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(async (event) => {
        if (approved) return;
        event.preventDefault();
        if (closing) return;
        closing = true;
        try {
          if (await prepareToLeave()) {
            approved = true;
            await win.close();
          }
        } catch (error) {
          approved = false;
          notify('关闭前保存失败：' + String(error));
        } finally {
          closing = false;
        }
      });
      if (disposed) unlisten();
    }).catch((error) => notify('关闭保护初始化失败：' + String(error)));
    return () => { disposed = true; unlisten?.(); };
  }, [prepareToLeave, notify]);

  const refresh = useCallback(async (root: string) => {
    let pending = listing.current.get(root);
    if (!pending) {
      pending = getFs().then((fs) => fs.list(root));
      listing.current.set(root, pending);
    }
    try {
      const list = await pending;
      if (vaultRef.current === root || vaultRef.current === null) {
        setFiles((previous) => previous.length === list.length && previous.every((entry, index) =>
          entry.path === list[index].path && entry.modified === list[index].modified) ? previous : list);
      }
      return list;
    } catch (error) {
      notify('读取文件夹失败：' + String((error as Error)?.message ?? error));
      throw error;
    } finally {
      if (listing.current.get(root) === pending) listing.current.delete(root);
    }
  }, [notify]);

  useEffect(() => {
    if (!vault) return;
    let active = true;
    const reload = () => {
      void listActionPrompts(vault).then((items) => {
        if (active) setActions(items);
      }).catch((error) => { if (active) notify('读取快捷动作失败：' + String(error)); });
    };
    reload();
    const focus = () => { reload(); void refresh(vault).catch(() => undefined); };
    window.addEventListener('focus', focus);
    return () => { active = false; window.removeEventListener('focus', focus); };
  }, [vault, refresh, notify]);

  const openVault = useCallback(
    async (root: string, s: Settings, preferFile?: string) => {
      const fs = await getFs();
      let list = await refresh(root);
      // 空文件夹：放一篇示例文档，演示问答块的用法
      if (!list.some((f) => !/\.(notes|annotations)\.md$/i.test(f.path))) {
        await fs.write(joinPath(root, '欢迎使用 Askdown.md'), SAMPLE_DOC, { root, expected: null });
        list = await refresh(root);
      }
      void loadPrompt(root, 'ask');
      void loadPrompt(root, 'tidy');
      setVault(root);
      setFiles(list);
      const pick = preferFile && (preferFile.startsWith(PROMPT_DIR) || list.some((f) => f.path === preferFile)) ? preferFile : list.find((f) => !/\.(notes|annotations)\.md$/i.test(f.path))?.path ?? null;
      setCurrent(pick);
      await persist({ ...s, lastVault: root, lastFile: pick ?? undefined });
    },
    [persist, refresh],
  );

  // 启动：读设置，自动打开上次的文件库
  useEffect(() => {
    let disposed = false;
    setStartupError('');
    void (async () => {
      const fs = await getFs();
      const s = await loadSettings();
      if (disposed) return;
      setFsKind(fs.kind);
      setSettings(s);
      if (s.lastVault) {
        const ok = fs.kind === 'browser' || (await fs.exists(s.lastVault));
        if (ok && !disposed) await openVault(s.lastVault, s, s.lastFile);
      }
    })().catch((error) => { if (!disposed) setStartupError(String((error as Error)?.message ?? error)); });
    return () => { disposed = true; };
  }, [openVault, startupAttempt]);

  async function chooseVault() {
    try {
      if (mutatingFile.current || !(await prepareToLeave())) return;
      const fs = await getFs();
      const root = await fs.pickFolder();
      if (root && settingsRef.current) await openVault(root, settingsRef.current);
    } catch (error) {
      notify('打开文件库失败：' + String(error));
    }
  }

  async function openFile(path: string) {
    if (mutatingFile.current || path === current || !(await prepareToLeave())) return;
    setCurrent(path);
    const s = settingsRef.current;
    if (s) await persist({ ...s, lastFile: path });
  }

  async function createFile(name: string) {
    if (!vault || mutatingFile.current) return;
    const clean = name.replace(/\.md$/i, '').replace(/[\\:*?"<>|]/g, '-').replace(/^\/+|\/+$/g, '');
    if (!clean) return;
    if (clean.split('/').some((part) => part === '..' || part === '.' || part.startsWith('.'))) {
      notify('文件名不能包含隐藏目录或上级目录');
      return;
    }
    const rel = clean + '.md';
    const fs = await getFs();
    const abs = joinPath(vault, rel);
    try {
      if (!(await fs.exists(abs))) await fs.write(abs, `# ${baseName(rel)}\n\n`, { root: vault, expected: null });
      await refresh(vault);
      await openFile(rel);
    } catch (error) {
      notify('新建文件失败：' + String(error));
    }
  }

  async function changeFile(path: string, destination?: string): Promise<boolean> {
    if (!vault || mutatingFile.current) return false;
    mutatingFile.current = true;
    setFileBusy(true);
    const previous = current;
    let detached = false;
    try {
      if (!(await prepareToLeave())) return false;
      // Stop document watches before changing paths, so our own move cannot look like an external deletion.
      flushSync(() => setCurrent(null));
      detached = true;
      const fs = await getFs();
      if (destination) await fs.move(joinPath(vault, path), joinPath(vault, destination), vault);
      else await fs.remove(joinPath(vault, path), vault);
      const next = previous === path ? destination ?? null : previous;
      setCurrent(next);
      detached = false;
      if (settingsRef.current) await persist({ ...settingsRef.current, lastFile: next ?? undefined });
      await refresh(vault);
      notify(destination ? '文件及关联笔记已移动' : '文件及关联笔记已移入 .askdown/trash');
      return true;
    } catch (error) {
      if (detached) setCurrent(previous);
      notify('文件操作失败：' + String((error as Error)?.message ?? error));
      return false;
    } finally {
      mutatingFile.current = false;
      setFileBusy(false);
    }
  }

  async function importMaterial(material: ImportedMaterial) {
    if (!vault || !(await prepareToLeave())) throw new Error('请先处理当前文件的保存或冲突，再导入材料。');
    const path = await saveMaterial(vault, material);
    await refresh(vault);
    setCurrent(path);
    if (settingsRef.current) await persist({ ...settingsRef.current, lastFile: path });
    notify('材料已导入，原文默认只读');
  }

  async function editPrompt(name: PromptName) {
    if (!vault || !(await prepareToLeave())) return;
    await ensurePrompt(vault, name);
    setShowSettings(false);
    await openFile(`${PROMPT_DIR}/${name}.md`);
  }

  async function createAction() {
    if (!vault || !(await prepareToLeave())) return;
    const name = actionName.trim().replace(/\.md$/i, '');
    if (!name || /[\\/:*?"<>|]/.test(name) || name.startsWith('.') || ['ask', 'tidy'].includes(name)) {
      notify('请填写有效的动作名称，不要使用 ask、tidy 或路径字符');
      return;
    }
    try {
      const fs = await getFs();
      const path = joinPath(vault, `${PROMPT_DIR}/${name}.md`);
      if (await fs.exists(path)) { notify('这个动作已存在'); return; }
      await fs.write(path, `请针对下面选中的文字执行「${name}」。用中文直接回答。\n\n选中的文字：\n{{anchor}}\n\n问题：{{question}}\n\n对话历史：\n{{history}}\n\n文档：\n{{document}}\n`, { root: vault, expected: null });
      setActions(await listActionPrompts(vault));
      setCreatingAction(false);
      setActionName('');
      await openFile(`${PROMPT_DIR}/${name}.md`);
    } catch (error) { notify('创建快捷动作失败：' + String(error)); }
  }

  const qa: QaHooks = useMemo(
    () => ({
      ask: async (req, onText, signal) => {
        const { runAsk } = await import('./ai/actions');
        signal?.throwIfAborted();
        return runAsk(settingsRef.current!, vault, { ...req, webSearch }, onText, signal, notify);
      },
      notify,
    }),
    [vault, notify, webSearch],
  );

  const isPromptFile = !!current && current.startsWith(PROMPT_DIR);
  const showNotes = !!settings?.showNotes && !!current && !isPromptFile;

  if (startupError) return <div className="welcome"><div className="welcome-card" role="alert">
    <h1>无法读取设置</h1><p>{startupError}</p>
    <p>原设置保持不变。请检查系统钥匙串权限或文件访问权限。</p>
    <button className="btn primary" onClick={() => setStartupAttempt((n) => n + 1)}>重试</button>
  </div></div>;
  if (!settings) return <div className="boot" />;

  if (!vault) {
    return (
      <div className="welcome">
        <div className="welcome-card">
          <div className="welcome-mark">??</div>
          <h1>Askdown · 边读边问</h1>
          <p>文档是主体，AI 是文档里的一种能力。在哪儿困惑就在哪儿用 <code>??</code> 提问，回答长在原地，最后一键把零散问答整理成笔记。</p>
          <p className="muted">选一个文件夹作为文件库。所有内容都是普通的 Markdown 文件，用 Obsidian、Typora 打开也能正常显示。</p>
          <button type="button" className="btn primary big" onClick={() => void chooseVault()}>
            {fsKind === 'tauri' ? '打开文件夹' : '打开浏览器演示库'}
          </button>
        </div>
        {toast && <div className="toast">{toast}</div>}
      </div>
    );
  }

  const absCurrent = current ? joinPath(vault, current) : null;

  return (
    <div className="app" aria-busy={installing || fileBusy} ref={(node) => { if (node) node.inert = installing || fileBusy; }}>
      <Sidebar
        vaultName={baseName(vault)}
        files={files}
        current={current}
        providerText={providerLabel(settings)}
        onOpen={openFile}
        onCreate={createFile}
        onMove={changeFile}
        onDelete={(path) => changeFile(path)}
        onImport={() => { void prepareToLeave().then((ready) => { if (ready) setShowImport(true); }); }}
        onSwitchVault={() => void chooseVault()}
        onRefresh={() => {
          void refresh(vault).catch(() => undefined);
          void listActionPrompts(vault).then(setActions).catch((error) => notify(String(error)));
        }}
        onSettings={() => setShowSettings(true)}
      />

      <SplitPane enabled={showNotes} storageKey="askdown:notes-split" label="调整原文与整理笔记宽度" left={
      <main className="main">
        <header className="topbar">
          <div className="doc-title">
            {current ? baseName(current) : '没有打开的文件'}
            {isPromptFile && <span className="tag">提示词模板</span>}
          </div>
          <span className={'save-status s-' + status.s} title={status.detail}>
            {STATUS_TEXT[status.s]}
          </span>
          <div className="topbar-actions">
            {current && <button type="button" className={'btn' + (showOutline ? ' on' : '')} aria-pressed={showOutline} onClick={() => setShowOutline(!showOutline)}>大纲</button>}
            {current && <Suspense fallback={null}><ExportMenu title={baseName(current)} getEditor={() => sourceHandle} notify={notify} /></Suspense>}
            {!isPromptFile && current && (
              <button type="button" aria-pressed={settings.showNotes} title="并排阅读原文、编辑整理笔记，可拖动分隔线调整宽度" className={'btn' + (settings.showNotes ? ' on' : '')} onClick={async () => {
                if (settings.showNotes && notesGuard.current && !(await notesGuard.current())) return;
                await persist({ ...settings, showNotes: !settings.showNotes });
              }}>
                整理面板
              </button>
            )}
            <button type="button" className="btn" onClick={() => setShowUsage(true)}>用量</button>
            <button type="button" className="btn" onClick={() => setShowSettings(true)}>
              设置
            </button>
            <details className="update-menu">
              <summary className="btn">更新</summary>
              <UpdateButton beforeInstall={async () => {
                if (!(await prepareToLeave())) return false;
                setInstalling(true);
                return true;
              }} onInstallFinished={() => setInstalling(false)} />
            </details>
          </div>
        </header>

        {!isPromptFile && current && <div className="reading-tools" role="region" aria-label="阅读与提问">
          <div className="segmented" aria-label="问答显示模式">
            <button type="button" aria-pressed={settings.qaMode !== 'margin'} className={settings.qaMode !== 'margin' ? 'on' : ''} onClick={() => void persist({ ...settings, qaMode: 'inline' })}>原地回答</button>
            <button type="button" aria-pressed={settings.qaMode === 'margin'} className={settings.qaMode === 'margin' ? 'on' : ''} onClick={() => void persist({ ...settings, qaMode: 'margin' })}>页边批注</button>
          </div>
          <button className="btn" onMouseDown={(event) => event.preventDefault()} onClick={() => selectionAction.current?.()}>选中提问</button>
          <button className="btn" title="点击正文中的图片后提问，需要支持视觉输入的模型" onMouseDown={(event) => event.preventDefault()} onClick={() => selectionAction.current?.(undefined, undefined, true)}>图片提问</button>
          <label className="search-toggle"><input type="checkbox" checked={webSearch} onChange={(event) => setWebSearch(event.target.checked)} /> 联网查证</label>
          <details className="action-menu">
            <summary className="btn">快捷动作</summary>
            <div className="action-list">
              {actions.map((action) => <div key={action.name}>
                <button type="button" className="btn" onMouseDown={(event) => event.preventDefault()} onClick={(event) => {
                  if (selectionAction.current?.(action.name, action.label)) event.currentTarget.closest('details')?.removeAttribute('open');
                }}>{action.label}</button>
                <button type="button" className="icon-btn" aria-label={`编辑${action.label}模板`} onClick={() => void openFile(`${PROMPT_DIR}/${action.name}.md`)}>编辑</button>
              </div>)}
              <button type="button" className="btn" onClick={(event) => { setCreatingAction(true); event.currentTarget.closest('details')?.removeAttribute('open'); }}>添加动作</button>
            </div>
          </details>
          <span className="reading-mode-hint">{settings.qaMode === 'margin' ? '正文写你的想法，问答留在页边' : '选中文字，按 ⌘/Ctrl + Enter 提问'}</span>
        </div>}

        <div className="reader-workspace">
        {showOutline && <DocumentOutline editor={sourceHandle} />}
        <div className="doc-scroll">
          {absCurrent ? (
            <ReadingDocument
              key={absCurrent}
              path={absCurrent}
              vault={vault}
              editable={() => !installing && !mutatingFile.current}
              onGuard={(guard) => { mainGuard.current = guard; }}
              onSelectionAction={(action) => { selectionAction.current = action; }}
              className={'doc' + (!isPromptFile && settings.qaMode === 'margin' ? ' margin-mode' : '')}
              qa={isPromptFile ? undefined : qa}
              onHandle={(h) => {
                mainHandle.current = h;
              }}
              onSourceHandle={setSourceHandle}
              onStatus={(s, detail, path) => {
                setStatus({ s, detail });
                if (s === 'error') notify('保存失败：' + (detail ?? ''));
                if (s === 'saved' && path) {
                  const relative = path.slice(vault.length + 1);
                  setFiles((previous) => previous.map((entry) => entry.path === relative ? { ...entry, modified: Date.now() } : entry));
                }
              }}
              notify={notify}
            />
          ) : (
            <div className="doc doc-empty">在左侧选择或新建一个文件</div>
          )}
        </div>
        </div>

        {!isPromptFile && current && (
          <footer className="hintbar">
            <span>
              <kbd>??</kbd> 开头的段落按 <kbd>Enter</kbd> 提问
            </span>
            <span>
              <kbd>Ctrl/⌘</kbd>+<kbd>Enter</kbd> 引用选中文字提问
            </span>
            <span>
              <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
            </span>
          </footer>
        )}
      </main>} right={showNotes && current && (
        <NotesPanel
          key={current}
          vault={vault}
          notesPath={joinPath(vault, notesPathOf(current))}
          title={baseName(current)}
          settings={settings}
          getMain={() => mainHandle.current}
          prepareSources={async () => await mainGuard.current?.(true) ?? false}
          notify={notify}
          onGuard={(guard) => { notesGuard.current = guard; }}
          installing={installing || fileBusy}
        />
      )} />

      <Suspense fallback={<div className="modal-backdrop"><div className="modal" role="status">正在加载…</div></div>}>
      {showSettings && (
        <SettingsDialog
          initial={settings}
          hasVault={!!vault}
          onClose={() => setShowSettings(false)}
          onSave={async (s) => {
            if (await persist({ ...s, lastVault: settings.lastVault, lastFile: settings.lastFile, showNotes: settings.showNotes })) {
              setShowSettings(false);
              notify('设置已保存');
            }
          }}
          onEditPrompt={async (n, draft) => {
            if (await persist({ ...draft, lastVault: settings.lastVault, lastFile: settings.lastFile, showNotes: settings.showNotes })) {
              await editPrompt(n);
            }
          }}
        />
      )}

      {showImport && <ImportDialog onImport={importMaterial} onClose={() => setShowImport(false)} />}
      {showUsage && <UsagePanel vault={vault} onClose={() => setShowUsage(false)} />}
      </Suspense>

      {creatingAction && <div className="modal-backdrop">
        <form className="modal" role="dialog" aria-modal="true" aria-labelledby="action-title" onSubmit={(event) => { event.preventDefault(); void createAction(); }}>
          <h2 id="action-title">添加快捷动作</h2>
          <label>动作名称<input autoFocus className="input" value={actionName} onChange={(event) => setActionName(event.target.value)} placeholder="例如：检查论证" /></label>
          <p className="hint">创建后会打开提示词文件。修改并保存即可使用，也可以在文件库的 .askdown/prompts/ 中自行添加 Markdown 文件。</p>
          <div className="modal-foot"><button type="button" className="btn" onClick={() => setCreatingAction(false)}>取消</button><button className="btn primary" type="submit">创建并编辑</button></div>
        </form>
      </div>}
      {toast && <div className="toast" role="status">{toast}</div>}
      {installing && <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-label="安装更新">
        <div className="modal"><p>内容已保存，正在安装更新。完成后将重新启动。</p></div>
      </div>}
    </div>
  );
}
