import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { loadUsage, subscribeUsage, type UsageRecord } from '../ai/usage';
import type { AiTask } from '../settings';
import './UsagePanel.css';

interface Props {
  vault: string | null;
  onClose: () => void;
}

interface LedgerState {
  vault: string | null;
  records: UsageRecord[] | null;
  loading: boolean;
  error: string;
}

const tasks: Record<AiTask, string> = { ask: '提问', tidy: '整理', summary: '自动摘要', test: '连接测试' };
const statuses: Record<UsageRecord['status'], string> = { complete: '完成', aborted: '已中止', error: '失败' };
const metrics = [
  { key: 'inputTokens', label: '输入 Token' },
  { key: 'outputTokens', label: '输出 Token' },
  { key: 'cacheReadTokens', label: '缓存读取 Token' },
  { key: 'cacheWriteTokens', label: '缓存写入 Token' },
  { key: 'costUsd', label: '已知费用（USD）' },
] as const;
const numbers = new Intl.NumberFormat('zh-CN');
const dollars = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 8 });

function cost(value: number | null): string {
  if (value === null) return '未知';
  if (value > 0 && value < 0.00000001) return '< US$0.00000001';
  return dollars.format(value);
}

export function UsagePanel({ vault, onClose }: Props) {
  const titleId = useId();
  const tableId = useId();
  const [state, setState] = useState<LedgerState>({ vault, records: null, loading: vault !== null, error: '' });
  const [refresh, setRefresh] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => { previous?.focus(); };
  }, []);

  useEffect(() => {
    if (vault === null) return;
    let disposed = false;
    let generation = 0;
    async function reload() {
      const request = ++generation;
      setState((previous) => ({ vault, records: previous.vault === vault ? previous.records : null, loading: true, error: '' }));
      try {
        const records = await loadUsage(vault!);
        if (!disposed && request === generation) setState({ vault, records, loading: false, error: '' });
      } catch (error) {
        if (!disposed && request === generation) setState((previous) => ({ ...previous, loading: false, error: String((error as Error)?.message ?? error) }));
      }
    }
    const unsubscribe = subscribeUsage(vault, () => { void reload(); });
    void reload();
    return () => { disposed = true; unsubscribe(); };
  }, [vault, refresh]);

  // Do not display the previous vault's data while the new vault's effect starts.
  const records = state.vault === vault ? state.records : null;
  const error = state.vault === vault ? state.error : '';
  const loading = vault !== null && (state.vault !== vault || state.loading);
  const ordered = useMemo(() => records ? [...records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)) : [], [records]);
  const totals = useMemo(() => metrics.map((metric) => {
    let known = 0;
    let unknown = 0;
    for (const record of records ?? []) {
      const value = record[metric.key];
      if (value === null) unknown++;
      else known += value;
    }
    return { ...metric, known, unknown };
  }), [records]);

  return <div className="modal-backdrop">
    <div ref={dialog} className="modal usage-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        if (event.key === 'Tab') {
          const nodes = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
          const first = nodes[0]; const last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="usage-heading">
        <h2 id={titleId}>AI 用量与费用</h2>
        <button ref={close} type="button" className="btn" onClick={onClose}>关闭</button>
      </div>
      {vault === null ? <p className="hint">请先打开文件库以查看用量记录。</p> : <>
        <p className="usage-vault">当前文件库：{vault}</p>
        <p className="hint">统计此文件库已保存的全部调用，包括失败和中止的调用。费用按调用时的单价估算，未知用量或未定价的费用不按零计算。</p>
        {loading && <p role="status">正在读取用量记录…</p>}
        {error && <p className="file-alert" role="alert">{error}{records !== null && ' 以下为上次成功读取的数据。'}</p>}
        {records !== null && <>
          <div className="usage-totals" aria-label="文件库累计用量">
            <div className="usage-total"><span>调用次数</span><strong>{numbers.format(records.length)}</strong></div>
            {totals.map((metric) => <div className="usage-total" key={metric.key}>
              <span>{metric.label}</span>
              <strong>{records.length > 0 && metric.unknown === records.length ? '未知' : metric.key === 'costUsd' ? cost(metric.known) : numbers.format(metric.known)}</strong>
              {metric.unknown > 0 && <small>{metric.unknown === records.length ? '全部未知' : '仅已知部分'} · {numbers.format(metric.unknown)} 次{metric.key === 'costUsd' ? '未计价' : '未知'}</small>}
            </div>)}
          </div>
          <h3 id={tableId}>逐次调用记录</h3>
          {ordered.length === 0 ? <p className="hint">此文件库还没有保存的 AI 调用记录。</p> : <div className="usage-table-scroll" tabIndex={0} role="region" aria-labelledby={tableId}>
            <table className="usage-table">
              <caption>全部调用，按时间从新到旧排列。未知值表示服务未返回数据或费用无法计算。</caption>
              <thead><tr>
                <th scope="col">时间</th><th scope="col">任务 / 模型</th><th scope="col">状态</th>
                <th scope="col">输入</th><th scope="col">输出</th><th scope="col">缓存读取</th><th scope="col">缓存写入</th><th scope="col">费用（USD）</th>
              </tr></thead>
              <tbody>{ordered.map((record) => <tr key={record.id}>
                <td><time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString('zh-CN')}</time></td>
                <td className="usage-model"><span>{tasks[record.task]}</span><strong>{record.model}</strong><small>{record.provider}</small>{record.note && <small>{record.note}</small>}</td>
                <td>{statuses[record.status]}</td>
                <td>{record.inputTokens === null ? '未知' : numbers.format(record.inputTokens)}</td>
                <td>{record.outputTokens === null ? '未知' : numbers.format(record.outputTokens)}</td>
                <td>{record.cacheReadTokens === null ? '未知' : numbers.format(record.cacheReadTokens)}</td>
                <td>{record.cacheWriteTokens === null ? '未知' : numbers.format(record.cacheWriteTokens)}</td>
                <td>{cost(record.costUsd)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </>}
        <div className="modal-foot usage-foot">
          <span className="hint">刷新可读取其他窗口保存的记录。</span>
          <button type="button" className="btn" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>刷新</button>
        </div>
      </>}
    </div>
  </div>;
}
