import { describe, expect, it } from 'vitest';
import { FileConflictError } from './fs';
import type { VaultFs } from './fs';
import { DocumentSession } from './document';

function fixture(initial: string | null = 'old') {
  let disk = initial;
  const history: string[] = [];
  let fail = false;
  let beforeWrite: (() => Promise<void>) | undefined;
  const fs: VaultFs = {
    kind: 'browser',
    pickFolder: async () => 'vault',
    list: async () => [],
    read: async () => { if (disk === null) throw new Error('missing'); return disk; },
    exists: async () => disk !== null,
    move: async () => { throw new Error('unused'); },
    remove: async () => { throw new Error('unused'); },
    write: async (_path, content, { expected }) => {
      await beforeWrite?.();
      if (fail) throw new Error('disk full');
      if (disk !== expected) throw new FileConflictError(disk);
      if (disk !== null) history.push(disk);
      disk = content;
    },
    snapshot: async (_path, _root, content) => { if (fail) throw new Error('disk full'); history.push(content); },
    history: async () => [],
    readHistory: async () => { throw new Error('unused'); },
    watch: async () => () => undefined,
    loadSettings: async () => null,
    saveSettings: async () => undefined,
  };
  const document = new DocumentSession(fs, 'vault/note.md', 'vault', initial, () => undefined);
  return {
    document, history,
    disk: () => disk,
    external: (content: string | null) => { disk = content; },
    fail: (value: boolean) => { fail = value; },
    beforeWrite: (callback: () => Promise<void>) => { beforeWrite = callback; },
  };
}

describe('document save lifecycle', () => {
  it('keeps edits made during an asynchronous write and serializes saves', async () => {
    const f = fixture();
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    f.beforeWrite(async () => { started(); await blocked; });
    f.document.edit('first');
    const saving = f.document.flush();
    await entered;
    f.document.edit('second');
    release();
    expect(await saving).toBe(true);
    expect(f.disk()).toBe('second');
    expect(f.history).toEqual(['old', 'first']);
    expect(f.document.unsafeToLeave).toBe(false);
  });

  it('retains dirty content after failure and retries against the original revision', async () => {
    const f = fixture();
    f.document.edit('mine');
    f.fail(true);
    expect(await f.document.flush()).toBe(false);
    expect(f.document.content).toBe('mine');
    expect(f.document.unsafeToLeave).toBe(true);
    expect(f.disk()).toBe('old');
    f.fail(false);
    expect(await f.document.flush()).toBe(true);
    expect(f.disk()).toBe('mine');
  });

  it('does not overwrite an external change or a second change after acknowledgement', async () => {
    const f = fixture();
    f.document.edit('mine');
    f.external('external one');
    expect(await f.document.flush()).toBe(false);
    expect(f.document.state).toEqual({ status: 'conflict', external: 'external one' });
    f.external('external two');
    expect(await f.document.keepMine()).toBe(false);
    expect(f.disk()).toBe('external two');
    expect(await f.document.keepMine()).toBe(true);
    expect(f.disk()).toBe('mine');
    expect(f.history).toEqual(['external two']);
  });

  it('preserves local unsaved edits before reloading and refuses reload if backup fails', async () => {
    const f = fixture();
    f.document.edit('unsaved');
    f.external('external');
    await f.document.checkExternal();
    f.fail(true);
    expect(await f.document.reload()).toBeUndefined();
    expect(f.document.content).toBe('unsaved');
    expect(f.document.unsafeToLeave).toBe(true);
    f.fail(false);
    expect(await f.document.reload()).toBe('external');
    expect(f.history).toEqual(['unsaved']);
    expect(f.document.unsafeToLeave).toBe(false);
  });

  it('distinguishes deletion from an empty file and never recreates it silently', async () => {
    const f = fixture('');
    f.external(null);
    await f.document.checkExternal();
    expect(f.document.state).toEqual({ status: 'conflict', external: null });
    expect(await f.document.flush()).toBe(false);
    expect(f.disk()).toBeNull();
    expect(await f.document.reload()).toBeNull();
    expect(f.history).toEqual(['']);
    expect(await f.document.flush()).toBe(true);
    expect(f.disk()).toBeNull();
  });

  it('does not save Markdown normalization until the user changes content', async () => {
    const f = fixture('text\r\n');
    f.document.adoptRendered('text\n');
    expect(await f.document.flush()).toBe(true);
    expect(f.disk()).toBe('text\r\n');
    f.document.edit('edited\n');
    expect(await f.document.flush()).toBe(true);
    expect(f.history).toEqual(['text\r\n']);
  });

  it('persists generated source IDs on request without overwriting external changes', async () => {
    const f = fixture('> [!question]\n> Why?\n');
    const rendered = '> [!question] ^q-stable-id\n> Why?\n';
    f.document.adoptRendered(rendered);
    await f.document.flush();
    expect(f.disk()).toBe('> [!question]\n> Why?\n');
    f.external('external content');
    expect(await f.document.flush(true)).toBe(false);
    expect(f.disk()).toBe('external content');
    expect(f.document.unsafeToLeave).toBe(true);
    expect(await f.document.keepMine()).toBe(true);
    expect(f.disk()).toBe(rendered);
    expect(f.history).toEqual(['external content']);
  });
});
