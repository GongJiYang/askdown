import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { baseName, getFs, joinPath, type FileEntry } from './fs';
import { loadSettings, providerLabel, saveSettings, type Settings } from './settings';
import { ensurePrompt, loadPrompt, PROMPT_DIR, type PromptName } from './ai/prompts';
import { runAsk } from './ai/actions';
import type { EditorHandle } from './editor/createEditor';
import type { QaHooks } from './editor/qa';
import { SAMPLE_DOC } from './sample';
import { EditorPane, type SaveStatus } from './components/EditorPane';
import { NotesPanel } from './components/NotesPanel';
import { Sidebar } from './components/Sidebar';
import { SettingsDialog } from './components/SettingsDialog';

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: '',
  dirty: '未保存',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
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

  const settingsRef = useRef<Settings | null>(null);
  settingsRef.current = settings;
  const mainHandle = useRef<EditorHandle | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const notify = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const persist = useCallback((next: Settings) => {
    settingsRef.current = next; // 立即更新，后续同一轮里的调用能读到最新设置
    setSettings(next);
    void saveSettings(next).catch(() => notify('设置保存失败'));
  }, [notify]);

  const refresh = useCallback(async (root: string) => {
    const fs = await getFs();
    try {
      const list = await fs.list(root);
      setFiles(list);
      return list;
    } catch (e) {
      notify('读取文件夹失败：' + String((e as Error)?.message ?? e));
      return [];
    }
  }, [notify]);

  const openVault = useCallback(
    async (root: string, s: Settings, preferFile?: string) => {
      const fs = await getFs();
      let list = await refresh(root);
      // 空文件夹：放一篇示例文档，演示问答块的用法
      if (!list.some((f) => !/\.notes\.md$/i.test(f.path))) {
        await fs.write(joinPath(root, '欢迎使用 Askdown.md'), SAMPLE_DOC);
        list = await refresh(root);
      }
      void loadPrompt(root, 'ask');
      void loadPrompt(root, 'tidy');
      setVault(root);
      const pick = preferFile && (preferFile.startsWith(PROMPT_DIR) || list.some((f) => f.path === preferFile)) ? preferFile : list.find((f) => !/\.notes\.md$/i.test(f.path))?.path ?? null;
      setCurrent(pick);
      persist({ ...s, lastVault: root, lastFile: pick ?? undefined });
    },
    [persist, refresh],
  );

  // 启动：读设置，自动打开上次的文件库
  useEffect(() => {
    (async () => {
      const fs = await getFs();
      setFsKind(fs.kind);
      const s = await loadSettings();
      setSettings(s);
      if (s.lastVault) {
        const ok = fs.kind === 'browser' || (await fs.exists(s.lastVault).catch(() => false));
        if (ok) await openVault(s.lastVault, s, s.lastFile);
      }
    })();
  }, [openVault]);

  async function chooseVault() {
    const fs = await getFs();
    const root = await fs.pickFolder();
    if (root && settings) await openVault(root, settings);
  }

  function openFile(path: string) {
    setCurrent(path);
    const s = settingsRef.current;
    if (s) persist({ ...s, lastFile: path });
  }

  async function createFile(name: string) {
    if (!vault) return;
    const clean = name.replace(/\.md$/i, '').replace(/[\\:*?"<>|]/g, '-').replace(/^\/+|\/+$/g, '');
    if (!clean) return;
    const rel = clean + '.md';
    const fs = await getFs();
    const abs = joinPath(vault, rel);
    if (!(await fs.exists(abs))) await fs.write(abs, `# ${baseName(rel)}\n\n`);
    await refresh(vault);
    openFile(rel);
  }

  async function editPrompt(name: PromptName) {
    if (!vault) return;
    await ensurePrompt(vault, name);
    setShowSettings(false);
    openFile(`${PROMPT_DIR}/${name}.md`);
  }

  const qa: QaHooks = useMemo(
    () => ({
      ask: (req, onText, signal) => runAsk(settingsRef.current!, vault, req, onText, signal),
      notify,
    }),
    [vault, notify],
  );

  const isPromptFile = !!current && current.startsWith(PROMPT_DIR);
  const showNotes = !!settings?.showNotes && !!current && !isPromptFile;

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
    <div className={'app' + (showNotes ? ' with-notes' : '')}>
      <Sidebar
        vaultName={baseName(vault)}
        files={files}
        current={current}
        providerText={providerLabel(settings)}
        onOpen={openFile}
        onCreate={createFile}
        onSwitchVault={() => void chooseVault()}
        onRefresh={() => void refresh(vault)}
        onSettings={() => setShowSettings(true)}
      />

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
            {!isPromptFile && current && (
              <button type="button" className={'btn' + (settings.showNotes ? ' on' : '')} onClick={() => persist({ ...settings, showNotes: !settings.showNotes })}>
                整理面板
              </button>
            )}
            <button type="button" className="btn" onClick={() => setShowSettings(true)}>
              设置
            </button>
          </div>
        </header>

        <div className="doc-scroll">
          {absCurrent ? (
            <EditorPane
              key={absCurrent}
              path={absCurrent}
              className="doc"
              qa={isPromptFile ? undefined : qa}
              onHandle={(h) => {
                mainHandle.current = h;
              }}
              onStatus={(s, detail) => {
                setStatus({ s, detail });
                if (s === 'error') notify('保存失败：' + (detail ?? ''));
                if (s === 'saved' && vault) void refresh(vault);
              }}
              onError={notify}
            />
          ) : (
            <div className="doc doc-empty">在左侧选择或新建一个文件</div>
          )}
        </div>

        {!isPromptFile && current && (
          <footer className="hintbar">
            <span>
              <kbd>??</kbd> 开头的段落按 <kbd>Enter</kbd> 提问
            </span>
            <span>
              <kbd>Ctrl/⌘</kbd>+<kbd>Enter</kbd> 在下方开一个问题
            </span>
            <span>
              <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
            </span>
          </footer>
        )}
      </main>

      {showNotes && current && (
        <NotesPanel
          key={current}
          vault={vault}
          notesPath={joinPath(vault, notesPathOf(current))}
          title={baseName(current)}
          settings={settings}
          getMain={() => mainHandle.current}
          notify={notify}
        />
      )}

      {showSettings && (
        <SettingsDialog
          initial={settings}
          hasVault={!!vault}
          onClose={() => setShowSettings(false)}
          onSave={(s) => {
            persist({ ...s, lastVault: settings.lastVault, lastFile: settings.lastFile, showNotes: settings.showNotes });
            setShowSettings(false);
            notify('设置已保存');
          }}
          onEditPrompt={(n, draft) => {
            persist({ ...draft, lastVault: settings.lastVault, lastFile: settings.lastFile, showNotes: settings.showNotes });
            void editPrompt(n);
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
