import { useRef, useState, type CSSProperties, type ReactNode } from 'react';

interface Props {
  left: ReactNode;
  right: ReactNode;
  enabled?: boolean;
  storageKey: string;
  label: string;
}

export function SplitPane({ left, right, enabled = true, storageKey, label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey) ?? 60);
      return Number.isFinite(stored) ? Math.max(25, Math.min(75, stored)) : 60;
    } catch { return 60; }
  });
  function update(value: number) {
    const next = Math.max(25, Math.min(75, value));
    setRatio(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* Layout remains usable without storage. */ }
  }
  return <div ref={host} className={'split-pane' + (enabled ? ' split-enabled' : '')}
    style={{ '--split-ratio': `${ratio}%` } as CSSProperties}>
    <div className="split-left">{left}</div>
    {enabled && <><div className="split-divider" role="separator" aria-label={label} aria-orientation="vertical"
      aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)} tabIndex={0}
      onDoubleClick={() => update(50)}
      onKeyDown={(event) => {
        const value = event.key === 'ArrowLeft' ? ratio - 5 : event.key === 'ArrowRight' ? ratio + 5
          : event.key === 'Home' ? 25 : event.key === 'End' ? 75 : null;
        if (value !== null) { event.preventDefault(); update(value); }
      }}
      onPointerDown={(event) => { if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); } }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const rect = host.current!.getBoundingClientRect();
        update((event.clientX - rect.left) / rect.width * 100);
      }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
      <div className="split-right">{right}</div></>}
  </div>;
}
