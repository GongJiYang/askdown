import { useEffect, useState } from 'react';
import type { EditorHandle } from '../editor/createEditor';

export function DocumentOutline({ editor }: { editor: EditorHandle | null }) {
  const [headings, setHeadings] = useState<ReturnType<EditorHandle['outline']>>([]);
  useEffect(() => {
    setHeadings(editor?.outline() ?? []);
    return editor?.subscribeOutline(() => setHeadings(editor.outline()));
  }, [editor]);
  return <nav className="document-outline" aria-label="文档大纲">
    <h2>文档大纲</h2>
    {headings.length ? <ol>{headings.map((heading) => <li key={heading.pos}>
      <button type="button" style={{ paddingLeft: 10 + (heading.level - 1) * 12 }}
        title={heading.text} onClick={() => editor?.jumpToHeading(heading.pos)}>{heading.text || '未命名标题'}</button>
    </li>)}</ol> : <p>添加标题后在这里跳转</p>}
  </nav>;
}
