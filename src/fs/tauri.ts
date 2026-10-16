import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { FileConflictError, type FileEntry, type HistoryEntry, type VaultFs } from './index';

export function createTauriFs(): VaultFs {
  return {
    kind: 'tauri',
    async pickFolder() {
      const picked = await open({ directory: true, multiple: false, title: '选择一个文件夹作为文件库' });
      return typeof picked === 'string' ? picked : null;
    },
    list: (root) => invoke<FileEntry[]>('list_markdown', { root }),
    read: (path) => invoke<string>('read_text', { path }),
    async write(path, content, { root, expected }) {
      try {
        await invoke<void>('write_text', { path, content, root, expected });
      } catch (error) {
        if (error && typeof error === 'object' && 'kind' in error && error.kind === 'conflict' && 'current' in error) {
          throw new FileConflictError(error.current as string | null);
        }
        throw new Error(typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error));
      }
    },
    move: (path, destination, root) => invoke<void>('move_document', { path, destination, root }),
    remove: (path, root) => invoke<void>('remove_document', { path, root }),
    async watch(path, onChange, onError) {
      const id = crypto.randomUUID();
      const event = `askdown-watch-${id}`;
      let disposed = false;
      // Subscribe before invoking the backend: even the initial watch window is covered.
      const unlisten = await listen<{ error?: string }>(event, ({ payload }) => {
        if (disposed) return;
        if (payload.error) onError?.(payload.error);
        else onChange();
      });
      try {
        await invoke<void>('watch_file', { path, id });
      } catch (error) {
        unlisten();
        throw error;
      }
      return () => {
        if (disposed) return;
        disposed = true;
        unlisten();
        void invoke<void>('unwatch_file', { id }).catch((error) => onError?.(String(error)));
      };
    },
    history: (path, root) => invoke<HistoryEntry[]>('file_history', { path, root }),
    readHistory: (path, root, id) => invoke<string>('read_history', { path, root, id }),
    snapshot: (path, root, content) => invoke<void>('snapshot_file', { path, root, content }),
    exists: (path) => invoke<boolean>('path_exists', { path }),
    loadSettings: () => invoke<string | null>('settings_load'),
    saveSettings: (content) => invoke<void>('settings_save', { content }),
  };
}
