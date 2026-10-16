import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultFs } from './index';

const root = 'test-vault';
const path = `${root}/note.md`;
const fileKey = `askdown:file:${path}`;
let fs: VaultFs;

beforeEach(async () => {
  // Import after reset to exercise credential memory across page/module lifetimes.
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  let queue: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, action: () => unknown) => {
        const result = queue.then(action);
        queue = result.catch(() => undefined);
        return result;
      },
    },
  });
  fs = (await import('./browser')).createBrowserFs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser vault safety', () => {
  it('rejects changed or deleted files without overwriting external work', async () => {
    await fs.write(path, 'old', { root, expected: null });
    localStorage.setItem(fileKey, JSON.stringify({ content: 'external', modified: 1 }));
    await expect(fs.write(path, 'new', { root, expected: 'old' })).rejects.toMatchObject({ name: 'FileConflictError', current: 'external' });
    expect(await fs.read(path)).toBe('external');
    localStorage.removeItem(fileKey);
    await expect(fs.write(path, 'new', { root, expected: 'old' })).rejects.toMatchObject({ name: 'FileConflictError', current: null });
    expect(await fs.exists(path)).toBe(false);
  });

  it('serializes competing saves and treats identical content as idempotent', async () => {
    await fs.write(path, 'old', { root, expected: null });
    const results = await Promise.allSettled([
      fs.write(path, 'first', { root, expected: 'old' }),
      fs.write(path, 'second', { root, expected: 'old' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const saved = await fs.read(path);
    await fs.write(path, saved, { root, expected: 'stale' });
    expect(await fs.history(path, root)).toHaveLength(1);
  });

  it('keeps durable prior versions and local recovery copies through restoration', async () => {
    await fs.write(path, 'original\r\n', { root, expected: null });
    await fs.write(path, 'edited', { root, expected: 'original\r\n' });
    await fs.snapshot(path, root, 'unsaved recovery');
    expect(await fs.read(path)).toBe('edited');
    const fresh = (await import('./browser')).createBrowserFs();
    const history = await fresh.history(path, root);
    const versions = await Promise.all(history.map((entry) => fresh.readHistory(path, root, entry.id)));
    expect(versions.sort()).toEqual(['original\r\n', 'unsaved recovery']);
    await fresh.write(path, 'original\r\n', { root, expected: 'edited' });
    const all = await fresh.history(path, root);
    expect(await Promise.all(all.map((entry) => fresh.readHistory(path, root, entry.id)))).toContain('edited');
    expect(await fresh.read(path)).toBe('original\r\n');
  });

  it('stops on snapshot quota errors and corrupt storage', async () => {
    await fs.write(path, 'old', { root, expected: null });
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('askdown:history:')) throw new DOMException('Full', 'QuotaExceededError');
      realSet.call(this, key, value);
    });
    await expect(fs.write(path, 'new', { root, expected: 'old' })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await fs.read(path)).toBe('old');
    realSet.call(localStorage, fileKey, '{broken');
    await expect(fs.write(path, 'new', { root, expected: null })).rejects.toThrow();
    expect(localStorage.getItem(fileKey)).toBe('{broken');
  });

  it('does not fall back to memory when persistent writes fail', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    await expect(fs.write(path, 'new', { root, expected: null })).rejects.toMatchObject({ name: 'SecurityError' });
    expect(await fs.exists(path)).toBe(false);
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    await expect(fs.write(path, 'new', { root, expected: null })).rejects.toThrow('Web Locks');
  });

  it('rejects traversal and history IDs outside the vault', async () => {
    await expect(fs.write(`${root}/../escape.md`, 'bad', { root, expected: null })).rejects.toThrow();
    await expect(fs.snapshot(`${root}/.askdown/history/fake`, root, 'bad')).rejects.toThrow();
    await expect(fs.readHistory(path, root, '../../secret')).rejects.toThrow();
    await expect(fs.write('another/note.md', 'bad', { root, expected: null })).rejects.toThrow();
  });

  it('allows editable prompts with the same CAS and history guarantees', async () => {
    const prompt = `${root}/.askdown/prompts/ask.md`;
    await fs.write(prompt, 'old prompt', { root, expected: null });
    await fs.write(prompt, 'new prompt', { root, expected: 'old prompt' });
    const versions = await fs.history(prompt, root);
    expect(await fs.readHistory(prompt, root, versions[0].id)).toBe('old prompt');
    expect(await fs.read(prompt)).toBe('new prompt');
    await expect(fs.write(prompt, 'stale prompt', { root, expected: 'old prompt' })).rejects.toMatchObject({ name: 'FileConflictError', current: 'new prompt' });
  });

  it('observes other tabs, local writes, deletions, and disposes listeners', async () => {
    const changed = vi.fn();
    const dispose = await fs.watch(path, changed);
    await fs.write(path, 'new', { root, expected: null });
    expect(changed).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: fileKey, storageArea: localStorage }));
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', storageArea: localStorage }));
    expect(changed).toHaveBeenCalledTimes(3);
    dispose();
    window.dispatchEvent(new StorageEvent('storage', { key: fileKey, storageArea: localStorage }));
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('migrates plaintext keys into memory and never persists new keys', async () => {
    localStorage.setItem('askdown:settings', JSON.stringify({ anthropic: { apiKey: 'legacy-test', model: 'model' }, compat: { apiKey: '' } }));
    const loaded = JSON.parse((await fs.loadSettings())!);
    expect(loaded.anthropic.apiKey).toBe('legacy-test');
    expect(localStorage.getItem('askdown:settings')).not.toContain('apiKey');
    loaded.compat.apiKey = 'new-test';
    await fs.saveSettings(JSON.stringify(loaded));
    expect(JSON.parse((await fs.loadSettings())!).compat.apiKey).toBe('new-test');
    expect(localStorage.getItem('askdown:settings')).not.toContain('new-test');
    vi.resetModules();
    const reloaded = (await import('./browser')).createBrowserFs();
    expect(JSON.parse((await reloaded.loadSettings())!).anthropic.apiKey).toBe('');
  });
});
