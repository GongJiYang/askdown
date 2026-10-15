import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { FileEntry, VaultFs } from './index';

export function createTauriFs(): VaultFs {
  return {
    kind: 'tauri',
    async pickFolder() {
      const picked = await open({ directory: true, multiple: false, title: '选择一个文件夹作为文件库' });
      return typeof picked === 'string' ? picked : null;
    },
    list: (root) => invoke<FileEntry[]>('list_markdown', { root }),
    read: (path) => invoke<string>('read_text', { path }),
    write: (path, content) => invoke<void>('write_text', { path, content }),
    exists: (path) => invoke<boolean>('path_exists', { path }),
    loadSettings: () => invoke<string | null>('settings_load'),
    saveSettings: (content) => invoke<void>('settings_save', { content }),
  };
}
