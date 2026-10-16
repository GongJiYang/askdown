import { FileConflictError, type FileEntry, type HistoryEntry, type VaultFs } from './index';
import { SAMPLE_DOC } from '../sample';

const ROOT = '浏览器演示库';
const FILE_PREFIX = 'askdown:file:';
const SETTINGS_KEY = 'askdown:settings';
const CHANGE_EVENT = 'askdown:file-change';
const secrets = new Map<string, string>();
const providers = ['anthropic', 'compat', 'search'] as const;

// Web Locks serialize read/compare/snapshot/write across tabs, not just this module.
function locked<T>(action: () => T): Promise<T> {
  if (!navigator.locks) return Promise.reject(new Error('安全保存需要浏览器 Web Locks，请使用最新版浏览器或桌面应用。'));
  return navigator.locks.request('askdown:storage', action);
}

function readRaw(path: string): { content: string; modified: number } | null {
  const raw = window.localStorage.getItem(FILE_PREFIX + path);
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (typeof value.content !== 'string' || typeof value.modified !== 'number') throw new Error('文件存储数据损坏');
  return value;
}

function writeRaw(path: string, content: string) {
  window.localStorage.setItem(FILE_PREFIX + path, JSON.stringify({ content, modified: Date.now() }));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: path }));
}

function relativePath(path: string, root: string): string {
  if (!root || !path.startsWith(root + '/') || [root, path].some((v) => /[\\\0]/.test(v) || v.split('/').some((p) => !p || p === '.' || p === '..'))) {
    throw new Error('文件路径必须位于文件库内');
  }
  const relative = path.slice(root.length + 1);
  if (relative.split('/').some((part, index) => part.toLowerCase() === '.askdown'
    && !(index === 0 && (relative.startsWith('.askdown/prompts/') || relative === '.askdown/usage.json')))) {
    throw new Error('不能修改内部历史目录');
  }
  return relative;
}

async function historyPrefix(path: string, root: string): Promise<string> {
  const relative = relativePath(path, root);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(relative));
  const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  return `askdown:history:${root}/.askdown/history/${hex}/`;
}

function historyId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('无效的历史版本');
}

function snapshotRaw(prefix: string, content: string) {
  let id: string;
  do { id = crypto.randomUUID(); } while (window.localStorage.getItem(prefix + id) !== null);
  window.localStorage.setItem(prefix + id, JSON.stringify({ id, created: Date.now(), content }));
}

function parseHistory(raw: string): HistoryEntry & { content: string } {
  const value = JSON.parse(raw);
  historyId(value.id);
  if (typeof value.created !== 'number' || typeof value.content !== 'string') throw new Error('历史数据损坏');
  return value;
}

function documentPaths(path: string, root: string): string[] {
  const relative = relativePath(path, root);
  if (!/\.md$/i.test(relative) || /\.(notes|annotations)\.md$/i.test(relative)
    || relative.split('/').some((part) => part.startsWith('.') || part === 'node_modules' || /[:\x00-\x1f]/.test(part) || /[. ]$/.test(part))) {
    throw new Error('请选择文件库内的 Markdown 正文，路径不能包含隐藏目录或保留名称');
  }
  const stem = path.slice(0, -3);
  return [path, stem + '.notes.md', stem + '.annotations.md', stem + '.reading.json'];
}

async function changeDocument(path: string, destination: string | null, root: string): Promise<void> {
  const sources = documentPaths(path, root);
  const targets = destination === null ? [] : documentPaths(destination, root);
  if (destination === path) return;
  const sourceHistory = await Promise.all(sources.map((source) => historyPrefix(source, root)));
  const targetHistory = await Promise.all(targets.map((target) => historyPrefix(target, root)));
  await locked(() => {
    const storage = window.localStorage;
    if (readRaw(path) === null) throw new Error('文件不存在：' + path);
    const entries = new Map<string, string>();
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) entries.set(key, storage.getItem(key)!);
    }
    const keys = [...entries.keys()];
    for (const target of targets) {
      const targetKey = FILE_PREFIX + target;
      if (entries.has(targetKey) || keys.some((key) => key.startsWith(targetKey + '/'))) {
        throw new Error('目标文件或关联文件已存在：' + target);
      }
      const parts = target.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (entries.has(FILE_PREFIX + parts.slice(0, i).join('/'))) throw new Error('目标父路径不是文件夹');
      }
    }
    if (targetHistory.some((prefix) => keys.some((key) => key.startsWith(prefix)))) {
      throw new Error('目标已有恢复历史，请选择其他文件名');
    }
    const originals = new Map<string, string>();
    const replacements = new Map<string, string>();
    sources.forEach((source, index) => {
      const key = FILE_PREFIX + source;
      const raw = entries.get(key);
      if (raw !== undefined) {
        readRaw(source); // Fail closed on damaged companion storage.
        originals.set(key, raw);
        if (destination !== null) replacements.set(FILE_PREFIX + targets[index], raw);
      }
      for (const [historyKey, value] of entries) {
        if (!historyKey.startsWith(sourceHistory[index])) continue;
        const record = parseHistory(value);
        if (historyKey !== sourceHistory[index] + record.id) throw new Error('历史索引损坏');
        originals.set(historyKey, value);
        if (destination !== null) replacements.set(targetHistory[index] + record.id, value);
      }
    });
    // Persist a complete recovery record before any removal. A tab crash at any
    // subsequent point leaves the original document set and history in trash.
    const archivePath = `${root}/.askdown/trash/${crypto.randomUUID()}.json`;
    storage.setItem(FILE_PREFIX + archivePath, JSON.stringify({
      modified: Date.now(),
      content: JSON.stringify({ operation: destination === null ? 'delete' : 'move', path, destination, entries: Object.fromEntries(originals) }),
    }));
    const published: string[] = [];
    try {
      // Metadata is published before the primary so imported material stays readonly.
      for (const [key, raw] of [...replacements].reverse()) {
        if (storage.getItem(key) !== null) throw new Error('目标已被其他窗口修改，请刷新后重试');
        storage.setItem(key, raw);
        published.push(key);
      }
      for (const [key, raw] of originals) {
        if (storage.getItem(key) !== raw) throw new Error('源文件已被其他窗口修改，请刷新后重试');
      }
      for (const [key, raw] of originals) {
        if (storage.getItem(key) !== raw) throw new Error('源文件已被其他窗口修改，请刷新后重试');
        storage.removeItem(key);
      }
    } catch (error) {
      try {
        const failures: string[] = [];
        for (const key of published.reverse()) {
          try {
            if (storage.getItem(key) === replacements.get(key)) storage.removeItem(key);
            else if (storage.getItem(key) !== null) failures.push('目标已被外部修改：' + key);
          } catch (cause) { failures.push(String(cause)); }
        }
        for (const [key, raw] of [...originals].reverse()) {
          try {
            const current = storage.getItem(key);
            if (current === null) storage.setItem(key, raw);
            else if (current !== raw) failures.push('源文件已被外部修改：' + key);
          } catch (cause) { failures.push(String(cause)); }
        }
        if (failures.length) throw new Error(failures.join('；'));
      } catch (rollbackError) {
        throw new Error(`操作失败：${String(error)}；回滚失败：${String(rollbackError)}。完整恢复副本：${archivePath}`);
      }
      throw error;
    }
    for (const changed of [...sources, ...targets]) {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: changed }));
    }
  });
}

function settingsDocument(content: string): Record<string, unknown> {
  const value = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式错误');
  return value;
}

// Remove every apiKey property, including legacy/unknown provider objects.
function stripKeys(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (key === 'apiKey') delete (value as Record<string, unknown>)[key];
    else stripKeys((value as Record<string, unknown>)[key]);
  }
}

function extractKeys(value: Record<string, unknown>): Map<string, string> {
  const keys = new Map<string, string>();
  for (const provider of providers) {
    const entry = value[provider];
    if (entry && typeof entry === 'object' && 'apiKey' in entry) {
      if (typeof entry.apiKey !== 'string') throw new Error('API Key 必须是字符串');
      keys.set(provider, entry.apiKey);
    }
  }
  return keys;
}

export function createBrowserFs(): VaultFs {
  return {
    kind: 'browser',
    async pickFolder() {
      await locked(() => {
        if (readRaw(ROOT + '/机会成本.md') === null) writeRaw(ROOT + '/机会成本.md', SAMPLE_DOC);
      });
      return ROOT;
    },
    async list(root) {
      const prefix = root + '/';
      const out: FileEntry[] = [];
      const storage = window.localStorage;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(FILE_PREFIX + prefix)) continue;
        const path = key.slice(FILE_PREFIX.length);
        const relative = path.slice(prefix.length);
        if (relative.split('/').some((seg) => seg.startsWith('.')) || !relative.toLowerCase().endsWith('.md')) continue;
        const value = readRaw(path);
        if (value) out.push({ path: relative, modified: value.modified });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(path) {
      const value = readRaw(path);
      if (value === null) throw new Error('文件不存在：' + path);
      return value.content;
    },
    async write(path, content, { root, expected }) {
      const prefix = await historyPrefix(path, root);
      await locked(() => {
        const current = readRaw(path)?.content ?? null;
        if (current === content) return;
        if (current !== expected) throw new FileConflictError(current);
        if (current !== null) snapshotRaw(prefix, current);
        // No await between comparison and replacement. Failed snapshots stop the save.
        const latest = readRaw(path)?.content ?? null;
        if (latest === content) return;
        if (latest !== expected) throw new FileConflictError(latest);
        writeRaw(path, content);
      });
    },
    move: (path, destination, root) => changeDocument(path, destination, root),
    remove: (path, root) => changeDocument(path, null, root),
    async watch(path, onChange, onError) {
      const changed = () => {
        try { onChange(); } catch (error) { onError?.(String(error)); }
      };
      const external = (event: StorageEvent) => {
        if ((event.storageArea === null || event.storageArea === window.localStorage) && (event.key === null || event.key === FILE_PREFIX + path)) changed();
      };
      const local = (event: Event) => { if ((event as CustomEvent<string>).detail === path) changed(); };
      window.addEventListener('storage', external);
      window.addEventListener(CHANGE_EVENT, local);
      return () => {
        window.removeEventListener('storage', external);
        window.removeEventListener(CHANGE_EVENT, local);
      };
    },
    async history(path, root) {
      const prefix = await historyPrefix(path, root);
      const entries: HistoryEntry[] = [];
      const storage = window.localStorage;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const raw = storage.getItem(key);
        if (raw === null) continue;
        const { id, created } = parseHistory(raw);
        if (key !== prefix + id) throw new Error('历史索引损坏');
        entries.push({ id, created });
      }
      return entries.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
    },
    async readHistory(path, root, id) {
      historyId(id);
      const prefix = await historyPrefix(path, root);
      const raw = window.localStorage.getItem(prefix + id);
      if (raw === null) throw new Error('历史版本不存在');
      const entry = parseHistory(raw);
      if (entry.id !== id) throw new Error('历史索引损坏');
      return entry.content;
    },
    async snapshot(path, root, content) {
      const prefix = await historyPrefix(path, root);
      await locked(() => snapshotRaw(prefix, content));
    },
    async exists(path) { return readRaw(path) !== null; },
    async loadSettings() {
      return locked(() => {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        if (raw === null) return null;
        const value = settingsDocument(raw);
        const legacy = extractKeys(value);
        stripKeys(value);
        // Persist redaction before accepting migrated credentials into memory.
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
        for (const [provider, key] of legacy) secrets.set(provider, key);
        for (const provider of providers) {
          const entry = value[provider];
          if (entry && typeof entry === 'object') (entry as Record<string, unknown>).apiKey = secrets.get(provider) ?? '';
        }
        return JSON.stringify(value);
      });
    },
    async saveSettings(content) {
      await locked(() => {
        const value = settingsDocument(content);
        const nextKeys = extractKeys(value);
        stripKeys(value);
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
        for (const [provider, key] of nextKeys) secrets.set(provider, key);
      });
    },
  };
}
