import { fetch as desktopFetch } from '@tauri-apps/plugin-http';
import { isTauri } from '../fs';

/** Use the desktop transport for native calls and the page transport in browser mode. */
export async function getFetch(): Promise<typeof fetch> {
  return isTauri() ? desktopFetch as typeof fetch : globalThis.fetch.bind(globalThis);
}
