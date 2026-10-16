import { useEffect, useRef, useState } from 'react';
import type { EditorHandle } from '../editor/createEditor';
import type { QaHooks } from '../editor/qa';
import { getFs } from '../fs';
import { readOptional } from '../document';
import { annotationPath, materialPath, parseMaterial, type MaterialInfo } from '../import/storage';
import { EditorPane, type LeaveGuard, type SaveStatus } from './EditorPane';
import { SplitPane } from './SplitPane';

export type SelectionAction = (template?: string, label?: string, imagesOnly?: boolean) => boolean;
interface Props {
  path: string;
  vault: string;
  qa?: QaHooks;
  className: string;
  editable: () => boolean;
  onHandle: (handle: EditorHandle | null) => void;
  onSourceHandle: (handle: EditorHandle | null) => void;
  onGuard: (guard: LeaveGuard | null) => void;
  onSelectionAction: (action: SelectionAction | null) => void;
  onStatus: (status: SaveStatus, detail?: string, path?: string) => void;
  notify: (message: string) => void;
}

export function ReadingDocument(props: Props) {
  const [material, setMaterial] = useState<MaterialInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [changingLock, setChangingLock] = useState(false);
  const rawInfo = useRef<string | null>(null);
  const source = useRef<EditorHandle | null>(null);
  const annotations = useRef<EditorHandle | null>(null);
  const sourceGuard = useRef<LeaveGuard | null>(null);
  const annotationGuard = useRef<LeaveGuard | null>(null);
  const cbs = useRef(props);
  cbs.current = props;
  const materialRef = useRef(material);
  materialRef.current = material;
  const readyRef = useRef(false);
  readyRef.current = loaded && !error && !changingLock;

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setError('');
    void getFs().then((fs) => readOptional(fs, materialPath(props.path))).then((raw) => {
      if (!active) return;
      const info = raw === null ? null : parseMaterial(raw);
      rawInfo.current = raw;
      setMaterial(info);
      setLoaded(true);
    }).catch((cause) => { if (active) setError(String((cause as Error)?.message ?? cause)); });
    cbs.current.onGuard(async (persistRendered) => {
      if (!readyRef.current) return false;
      if (!sourceGuard.current || !(await sourceGuard.current(materialRef.current ? false : persistRendered))) return false;
      return materialRef.current ? !!annotationGuard.current && await annotationGuard.current(persistRendered) : true;
    });
    cbs.current.onSelectionAction((template, label, imagesOnly) => {
      if (!readyRef.current) return false;
      const sourceView = source.current?.view();
      const selectedInSource = !!sourceView && (sourceView.dom.contains(window.getSelection()?.anchorNode ?? null)
        || sourceView.dom.contains(document.activeElement));
      const handle = materialRef.current && !selectedInSource ? annotations.current : source.current;
      const selection = handle?.getSelectionContext();
      if (imagesOnly && !selection?.images.length) {
        cbs.current.notify('请先点击正文中的图片，再选择「图片提问」。模型需要支持视觉输入。');
        return false;
      }
      if (materialRef.current && handle === source.current && selection) return quote(selection, template, label);
      return handle?.askSelection(template, label) ?? false;
    });
    return () => {
      active = false;
      cbs.current.onSelectionAction(null);
      cbs.current.onGuard(null);
    };
  }, [props.path, attempt]);

  function quote(selection: { text: string; images: string[] }, template?: string, label?: string): boolean {
    if (!cbs.current.editable() || !annotations.current) return false;
    return annotations.current.insertQuestion(selection.text, { template, label, images: selection.images });
  }

  async function toggleLock() {
    if (!material || changingLock) return;
    setChangingLock(true);
    try {
      if (!sourceGuard.current || !(await sourceGuard.current())) return;
      const next = { ...material, readOnly: !material.readOnly };
      const raw = JSON.stringify(next, null, 2);
      await (await getFs()).write(materialPath(props.path), raw, { root: props.vault, expected: rawInfo.current });
      rawInfo.current = raw;
      setMaterial(next);
    } catch (cause) {
      props.notify('更改原文保护失败：' + String((cause as Error)?.message ?? cause));
    } finally { setChangingLock(false); }
  }

  if (error) return <div className="file-alert" role="alert">{error} <button className="btn" onClick={() => setAttempt((value) => value + 1)}>重新读取材料信息</button></div>;
  if (!loaded) return <div className="doc doc-empty" role="status">正在读取材料…</div>;
  const sourceEditor = <EditorPane path={props.path} vault={props.vault}
    className={material ? 'doc source-document' : props.className}
    editable={() => cbs.current.editable() && !changingLock}
    readonly={() => materialRef.current?.readOnly ?? false}
    qa={material ? undefined : props.qa}
    onAskSelection={material ? quote : undefined}
    onHandle={(handle) => { source.current = handle; props.onSourceHandle(handle); if (!material) props.onHandle(handle); }}
    onGuard={(guard) => { sourceGuard.current = guard; }}
    onStatus={(status, detail) => props.onStatus(status, detail, props.path)} onError={props.notify} />;
  if (!material) return sourceEditor;

  const qa: QaHooks | undefined = props.qa && {
    notify: props.qa.notify,
    ask: (request, onText, signal) => props.qa!.ask({
      ...request,
      document: `${source.current?.getMarkdown() ?? ''}\n\n## 阅读批注\n\n${request.document}`,
      sourceDocument: `${source.current?.getMarkdown() ?? ''}\n\n## 阅读批注\n\n${request.sourceDocument ?? request.document}`,
    }, onText, signal),
  };
  return <div className="reading-document">
    <div className="material-banner">
      <div><strong>原文 · {material.readOnly ? '只读' : '可编辑'}</strong><span className="tag">{material.kind.toUpperCase()}</span>
        <span className="material-origin" title={material.source}>{material.source}</span></div>
      <button type="button" className="btn" disabled={changingLock} onClick={() => void toggleLock()}>{material.readOnly ? '允许编辑原文' : '锁定原文'}</button>
    </div>
    {!!material.warnings.length && <details className="material-warnings"><summary>导入说明（{material.warnings.length}）</summary><ul>{material.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    <SplitPane storageKey="askdown:source-split" label="调整原文与批注宽度"
      left={<section className="source-layer" aria-label="导入原文">{sourceEditor}</section>}
      right={
    <section className="annotation-layer" aria-label="问答与个人笔记">
      <header className="annotation-header"><strong>问答与个人笔记</strong><span>选中原文或图片提问；在这里自由记录</span></header>
      <EditorPane path={annotationPath(props.path)} vault={props.vault} fallback={'# 阅读批注\n\n'}
        className={props.className + ' annotation-document'} qa={qa} editable={props.editable}
        onHandle={(handle) => { annotations.current = handle; props.onHandle(handle); }}
        onGuard={(guard) => { annotationGuard.current = guard; }}
        onStatus={(status, detail) => props.onStatus(status, detail, annotationPath(props.path))} onError={props.notify} />
    </section>} />
  </div>;
}
