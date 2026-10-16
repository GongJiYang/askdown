import { FileConflictError, type VaultFs } from './fs';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';
export interface SaveState {
  status: SaveStatus;
  detail?: string;
  external?: string | null;
}

export async function readOptional(fs: VaultFs, path: string): Promise<string | null> {
  try {
    return await fs.read(path);
  } catch (error) {
    if (!(await fs.exists(path))) return null;
    throw error;
  }
}

/** One opened file: serialize writes and checks, retaining edits until a save succeeds. */
export class DocumentSession {
  content: string;
  private baseline: string | null;
  private dirty = false;
  private conflict: string | null | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  state: SaveState = { status: 'idle' };

  constructor(
    private fs: VaultFs,
    readonly path: string,
    private root: string,
    initial: string | null,
    private changed: (state: SaveState) => void,
  ) {
    this.baseline = initial;
    this.content = initial ?? '';
  }

  get unsafeToLeave() {
    return this.dirty || this.conflict !== undefined || this.state.status === 'saving' || this.state.status === 'error';
  }

  private emit(state: SaveState) {
    this.state = state;
    this.changed(state);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private failed(error: unknown) {
    if (error instanceof FileConflictError) {
      this.conflict = error.current;
      this.emit({ status: 'conflict', external: error.current });
    } else {
      this.emit({ status: 'error', detail: String((error as Error)?.message ?? error) });
    }
  }

  // Parsing may normalize Markdown; opening/reloading alone is not an edit.
  adoptRendered(markdown: string) {
    this.content = markdown;
  }

  edit(markdown: string) {
    if (markdown === this.content) return;
    this.content = markdown;
    this.dirty = true;
    if (this.conflict === undefined) this.emit({ status: 'dirty' });
  }

  private async save(): Promise<boolean> {
    if (this.conflict !== undefined) return false;
    while (this.dirty) {
      const content = this.content;
      this.emit({ status: 'saving' });
      try {
        await this.fs.write(this.path, content, { root: this.root, expected: this.baseline });
        this.baseline = content;
        this.dirty = this.content !== content;
        this.emit({ status: this.dirty ? 'dirty' : 'saved' });
      } catch (error) {
        this.failed(error);
        return false;
      }
    }
    return this.state.status !== 'error';
  }

  flush(persistRendered = false): Promise<boolean> {
    return this.serial(() => {
      // Source links must persist newly assigned IDs before another file references them.
      if (persistRendered && this.content !== this.baseline) this.dirty = true;
      return this.save();
    });
  }

  checkExternal(): Promise<void> {
    return this.serial(async () => {
      try {
        const disk = await readOptional(this.fs, this.path);
        if (disk === this.baseline) return;
        if (disk === this.content) {
          this.baseline = disk;
          this.dirty = false;
          this.conflict = undefined;
          this.emit({ status: 'saved' });
          return;
        }
        this.conflict = disk;
        this.emit({ status: 'conflict', external: disk });
      } catch (error) {
        this.failed(error);
      }
    });
  }

  keepMine(): Promise<boolean> {
    return this.serial(async () => {
      if (this.conflict === undefined) return this.save();
      // The acknowledgement only authorizes replacing the revision displayed to the user.
      this.baseline = this.conflict;
      this.conflict = undefined;
      this.dirty = true;
      return this.save();
    });
  }

  reload(): Promise<string | null | undefined> {
    return this.serial(async () => {
      try {
        const disk = await readOptional(this.fs, this.path);
        if (this.content !== disk) await this.fs.snapshot(this.path, this.root, this.content);
        this.baseline = disk;
        this.content = disk ?? '';
        this.conflict = undefined;
        this.dirty = false;
        this.emit({ status: 'idle' });
        return disk;
      } catch (error) {
        this.failed(error);
        return undefined;
      }
    });
  }

  async preserveRecovery(): Promise<void> {
    if (this.unsafeToLeave) await this.fs.snapshot(this.path, this.root, this.content);
  }
}
