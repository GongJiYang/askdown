import { useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isTauri } from '../fs';

interface Props {
  /** Flush pending writes and prevent editing until onInstallFinished. Return false to cancel. */
  beforeInstall?: () => Promise<boolean>;
  onInstallFinished?: () => void;
}

export default function UpdateButton({ beforeInstall, onInstallFinished }: Props) {
  const desktop = isTauri();
  const configured = import.meta.env.VITE_ASKDOWN_UPDATER_CONFIGURED === 'true';
  const [update, setUpdate] = useState<Update | null>(null);
  const [busy, setBusy] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const active = useRef(false);
  const mounted = useRef(true);
  const resource = useRef<Update | null>(null);
  const downloaded = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!active.current) void resource.current?.close().catch(() => {});
    };
  }, []);

  async function run() {
    if (active.current || !desktop || !configured) return;
    active.current = true;
    setBusy(true);
    setError(false);
    let guarded = false;
    try {
      if (!update) {
        setMessage('正在检查更新…');
        const found = await check({ timeout: 20_000 });
        resource.current = found;
        if (!mounted.current) return;
        setUpdate(found);
        setMessage(found ? `发现新版本 ${found.version}，安装后将重新启动。` : '当前已是最新版本。');
        return;
      }
      if (!beforeInstall) throw new Error('无法确认文档已保存，暂不能安装更新。');
      if (!installed && !downloaded.current) {
        setMessage('正在下载更新…');
        let bytes = 0;
        let total = 0;
        await update.download((event) => {
          if (!mounted.current) return;
          if (event.event === 'Started') total = event.data.contentLength ?? 0;
          if (event.event === 'Progress') {
            bytes += event.data.chunkLength;
            setMessage(total > 0 ? `正在下载更新… ${Math.min(100, Math.round(bytes / total * 100))}%` : `已下载 ${Math.round(bytes / 1024)} KB`);
          }
        }, { timeout: 120_000 });
        downloaded.current = true;
      }
      if (!mounted.current) return;
      setMessage('正在保存文档…');
      guarded = true;
      if (!await beforeInstall()) {
        setMessage('更新已暂停。请先处理未保存的文档或文件冲突，然后重试。');
        return;
      }
      if (!mounted.current) return;
      if (!installed) {
        setMessage('正在安装更新，请勿关闭应用…');
        await update.install();
        downloaded.current = false;
        setInstalled(true);
      }
      setMessage('更新已安装，正在重新启动…');
      await relaunch();
    } catch (cause) {
      if (mounted.current) {
        setError(true);
        setMessage(`更新失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    } finally {
      if (guarded) onInstallFinished?.();
      active.current = false;
      if (mounted.current) setBusy(false);
      else void resource.current?.close().catch(() => {});
    }
  }

  const status = !desktop
    ? '自动更新仅在桌面应用中可用。'
    : !configured
      ? '此构建未启用自动更新，请安装正式发布版本。'
      : message;

  return (
    <div className="update-control">
      <button type="button" className="btn" disabled={busy || !desktop || !configured} onClick={() => void run()}>
        {busy ? '正在处理…' : installed ? '重新启动' : update ? `安装 ${update.version} 并重启` : '检查更新'}
      </button>
      {status && <p className="hint" role={error ? 'alert' : 'status'}>{status}</p>}
    </div>
  );
}
