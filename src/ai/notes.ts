import type { QaPair } from '../editor/qa';

const CHECKPOINT = /^(`{3,}|~{3,})askdown-checkpoint[^\S\n]*\n([\s\S]*?)^\1[^\S\n]*(?:\n|$)/gm;
const SOURCE = /(?<!\\)\[[^\]\n]+\]\(#q-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\)/gi;
export interface NotesCheckpoint { version: 1; revisions: Record<string, string> }
export interface NotesFollowUp { id: string; question: string }

export function readNotes(markdown: string, reset = false): { notes: string; checkpoint: NotesCheckpoint } {
  let checkpoint: NotesCheckpoint = { version: 1, revisions: {} };
  let count = 0;
  const notes = markdown.replace(CHECKPOINT, (_block, _fence: string, json: string) => {
    count++;
    if (reset) return '';
    try {
      const value = JSON.parse(json);
      if (count > 1 || value?.version !== 1 || !value.revisions || typeof value.revisions !== 'object' || Array.isArray(value.revisions)
        || Object.entries(value.revisions).some(([id, revision]) => !/^[0-9a-f-]{36}$/i.test(id) || typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision))) throw new Error();
      checkpoint = value;
    } catch {
      throw new Error('整理进度记录损坏，请使用「重新整理全部」重建；原笔记会保留在上下文中');
    }
    return '';
  }).trim();
  if (/^(`{3,}|~{3,})askdown-checkpoint/m.test(notes)) throw new Error('整理进度代码块不完整，请先修复 Markdown 中的代码块');
  return { notes, checkpoint };
}

export async function checkpointFor(pairs: QaPair[]): Promise<NotesCheckpoint> {
  const revisions: Record<string, string> = {};
  await Promise.all(pairs.map(async (pair) => {
    const bytes = new TextEncoder().encode(JSON.stringify([pair.id, pair.answerId, pair.question, pair.anchor, pair.answer]));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    revisions[pair.id] = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  }));
  return { version: 1, revisions };
}

export function writeNotes(notes: string, checkpoint: NotesCheckpoint): string {
  return `${notes.trim()}\n\n\`\`\`askdown-checkpoint\n${JSON.stringify(checkpoint)}\n\`\`\`\n`;
}

/** Validate source IDs supplied by the model, never infer a citation from text similarity. */
export function validateNotes(markdown: string, sources: QaPair[], delta: QaPair[], previous: string): void {
  if (!markdown.trim()) throw new Error('整理结果为空，原笔记和进度保持不变');
  if (/askdown-checkpoint/.test(markdown)) throw new Error('整理结果包含内部进度记录，已保留原笔记');
  const allowed = new Set(sources.map((pair) => pair.id));
  const cited = new Set<string>();
  const visible = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\S\n]*(?:\n|$)/gm, '')
    .replace(/(`+)[^\n]*?\1/g, '');
  for (const match of visible.matchAll(SOURCE)) {
    if (!allowed.has(match[1])) throw new Error('整理结果引用了不存在的问答，原笔记和进度保持不变');
  }
  // A malformed target must not be mistaken for an uncited old paragraph.
  const withoutSources = visible.replace(SOURCE, '');
  if (/#q-/.test(withoutSources)) throw new Error('整理结果的来源链接格式有误，原笔记和进度保持不变');
  const blocks = markdown.split(/\n\s*\n|\n(?=\s*(?:[-*+] |\d+[.)] ))/).map((part) => part.trim()).filter(Boolean);
  const previousBlocks = new Set(previous.split(/\n\s*\n|\n(?=\s*(?:[-*+] |\d+[.)] ))/).map((part) => part.trim()));
  for (const block of blocks) {
    const content = block.replace(/^#{1,6} .*(?:\n|$)/gm, '').trim();
    if (!content) continue;
    const links = [...content.replace(/(`+)[^\n]*?\1/g, '').matchAll(SOURCE)];
    const codeBlock = /^(`{3,}|~{3,})/.test(content);
    if (!codeBlock) for (const link of links) cited.add(link[1]);
    if (previousBlocks.has(block)) continue;
    if (!links.length || codeBlock) throw new Error('整理结果有条目缺少来源链接，原笔记和进度保持不变；请重试');
  }
  if (delta.some((pair) => !cited.has(pair.id))) throw new Error('整理结果遗漏了本次问答的来源，未更新笔记或进度；请重试');
}

export function followUps(markdown: string): NotesFollowUp[] {
  const result: NotesFollowUp[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\s*(?:[-*+] |\d+[.)] )?(?:\?\?|？？)\s*(.+)$/.exec(line);
    if (!match) continue;
    const sources = [...match[1].matchAll(SOURCE)];
    if (!sources.length) continue;
    const question = match[1].replace(SOURCE, '').trim();
    if (question) result.push({ id: sources[0][1], question });
  }
  return result;
}
