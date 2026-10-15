/**
 * 文件库抽象。桌面端走 Tauri 的 Rust 命令；
 * 在普通浏览器里（npm run dev 直接打开）用 localStorage 模拟一个演示库，方便开发界面。
 */
export interface FileEntry {
  /** 相对文件库根目录，用 `/` 分隔 */
  path: string;
  modified: number;
}

export interface VaultFs {
  kind: 'tauri' | 'browser';
  pickFolder(): Promise<string | null>;
  list(root: string): Promise<FileEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  loadSettings(): Promise<string | null>;
  saveSettings(content: string): Promise<void>;
}

export const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 把文件库根目录和相对路径拼成绝对路径。Rust 端在 Windows 上也接受 `/`。 */
export function joinPath(root: string, rel: string): string {
  return root.replace(/[\\/]+$/, '') + '/' + rel.replace(/^[\\/]+/, '');
}

export function baseName(path: string): string {
  const name = path.split(/[\\/]/).pop() || path;
  return name.replace(/\.md$/i, '');
}

let cached: VaultFs | null = null;

export async function getFs(): Promise<VaultFs> {
  if (cached) return cached;
  if (isTauri()) {
    const { createTauriFs } = await import('./tauri');
    cached = createTauriFs();
  } else {
    const { createBrowserFs } = await import('./browser');
    cached = createBrowserFs();
  }
  return cached;
}
