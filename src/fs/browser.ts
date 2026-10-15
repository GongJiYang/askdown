import type { FileEntry, VaultFs } from './index';
import { SAMPLE_DOC } from '../sample';

/** 浏览器开发模式下的演示文件库，数据存在 localStorage。 */
const ROOT = '浏览器演示库';
const FILE_PREFIX = 'askdown:file:';
const SETTINGS_KEY = 'askdown:settings';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const memory = new Map<string, { content: string; modified: number }>();

function readRaw(path: string): { content: string; modified: number } | null {
  const s = storage();
  if (s) {
    const raw = s.getItem(FILE_PREFIX + path);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return null;
  }
  return memory.get(path) ?? null;
}

function writeRaw(path: string, content: string) {
  const v = { content, modified: Date.now() };
  const s = storage();
  if (s) s.setItem(FILE_PREFIX + path, JSON.stringify(v));
  else memory.set(path, v);
}

function allPaths(): string[] {
  const s = storage();
  if (!s) return [...memory.keys()];
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k && k.startsWith(FILE_PREFIX)) out.push(k.slice(FILE_PREFIX.length));
  }
  return out;
}

export function createBrowserFs(): VaultFs {
  return {
    kind: 'browser',
    async pickFolder() {
      if (!readRaw(ROOT + '/机会成本.md')) writeRaw(ROOT + '/机会成本.md', SAMPLE_DOC);
      return ROOT;
    },
    async list(root) {
      const prefix = root + '/';
      const out: FileEntry[] = [];
      for (const p of allPaths()) {
        if (!p.startsWith(prefix)) continue;
        const rel = p.slice(prefix.length);
        if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;
        out.push({ path: rel, modified: readRaw(p)?.modified ?? 0 });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(path) {
      const v = readRaw(path);
      if (!v) throw new Error('文件不存在：' + path);
      return v.content;
    },
    async write(path, content) {
      writeRaw(path, content);
    },
    async exists(path) {
      return readRaw(path) !== null;
    },
    async loadSettings() {
      return storage()?.getItem(SETTINGS_KEY) ?? null;
    },
    async saveSettings(content) {
      storage()?.setItem(SETTINGS_KEY, content);
    },
  };
}
