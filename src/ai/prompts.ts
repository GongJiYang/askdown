import { getFs, joinPath } from '../fs';

/**
 * 提示词模板存放在文件库的 `.askdown/prompts/` 里，是普通的 Markdown 文件，
 * 用户可以直接在 Askdown 里打开修改。`{{变量}}` 会在调用时被替换。
 */
export type PromptName = string;

export const PROMPT_DIR = '.askdown/prompts';

export const DEFAULT_PROMPTS: Record<string, string> = {
  ask: `你是用户读书和写笔记时的学习助手。用户在下面这份 Markdown 文档的某处写下了一个问题（标有「【用户在这里提问】」）。

回答要求：
- 用中文直接回答，第一句就进入正题。不要寒暄，不要夸问题，不要复述问题。
- 写成可以直接留在笔记里的文字：陈述句，像注释或词条，而不是聊天。
- 紧扣提问位置附近的内容；文档别处有相关内容时可以联系起来。
- 简短：一般 2 到 6 句；确实需要时用简短列表。可以加粗关键概念，不要用标题。

问题附近的段落：
"""
{{anchor}}
"""

问题：{{question}}

此前问答：{{history}}
上一次回答：{{previousAnswer}}
回答风格：{{style}}

完整文档：
"""
{{document}}
"""
`,
  tidy: `把用户读一份材料时零散提出的问题和得到的回答，整理成一份结构化的学习笔记。

规则：
- 用中文 Markdown，只输出笔记本身，不要开场白和结束语。
- 固定三个二级标题：
  ## 核心概念：每个概念一条，一两句话说清楚，相关概念放在一起。
  ## 要点：从问答里提炼出的结论。合并重复和相近的内容，按逻辑顺序排列，而不是按提问顺序。
  ## 还没搞懂的：回答里没说透的、问答之间有矛盾的、顺着问题自然会追问的。每条写成一个问题，以 "?? " 开头。
- "已有笔记" 是用户看过、可能改过的版本：保留其中的原话，在它的基础上合并新内容，不要推倒重写。
- 不要编造材料和问答里没有的事实。
- 每个概念、要点、待追问条目都必须附上对应问答的 Markdown 来源链接：[来源](#q-ID)，ID 必须取自问答记录，不能编造。
- 每条待追问以 "- ?? " 开头，并在同一条末尾附上来源链接。

材料：《{{title}}》，开头如下
"""
{{head}}
"""

已有笔记：
"""
{{notes}}
"""

问答记录：
{{qa}}
`,
};

export const PROMPT_LABELS: Record<string, string> = {
  ask: '提问模板',
  tidy: '整理模板',
};

export const DEFAULT_ACTION_PROMPTS: Record<string, string> = Object.fromEntries([
  ['反驳我', '找出这段观点最值得质疑的前提，给出有力的反例或反驳，同时说明反驳的适用边界。'],
  ['举个例子', '用一个具体、贴近日常的例子解释选中的内容，清楚对应其中的关键概念。'],
  ['往下想一步', '沿着选中内容继续推理一步，说明新的结论、推理依据，以及仍需验证的问题。'],
  ['用大白话解释', '用不依赖专业术语的大白话解释选中内容，保留原意，必要时使用简单类比。'],
].map(([name, instruction]) => [name, `${instruction}\n\n选中内容：\n{{anchor}}\n\n问题：{{question}}\n\n上下文：\n{{document}}\n\n此前问答：\n{{history}}\n\n上一次回答：\n{{previousAnswer}}\n\n回答风格：{{style}}\n`]));

function validateName(name: string): void {
  if (!name.trim() || name !== name.trim() || /^[.]/.test(name) || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name) || /[. ]$/.test(name)) {
    throw new Error('模板名称必须是有效的文件名，不含路径');
  }
}

export function promptPath(vault: string, name: PromptName): string {
  validateName(name);
  return joinPath(vault, `${PROMPT_DIR}/${name}.md`);
}

/** Built-in templates are created only when absent; user content is never replaced. */
export async function loadPrompt(vault: string | null, name: PromptName): Promise<string> {
  validateName(name);
  const builtin = Object.hasOwn(DEFAULT_PROMPTS, name) ? DEFAULT_PROMPTS[name] : undefined;
  if (!vault) {
    if (builtin !== undefined) return builtin;
    throw new Error(`动作模板需要文件库：${name}`);
  }
  const fs = await getFs();
  const path = promptPath(vault, name);
  if (await fs.exists(path)) {
    const text = await fs.read(path);
    if (!text.trim()) throw new Error(`模板为空，请编辑后重试：${name}.md`);
    return text;
  }
  if (builtin === undefined) throw new Error(`动作模板不存在：${name}.md，请刷新动作列表`);
  try {
    await fs.write(path, builtin, { root: vault, expected: null });
  } catch (error) {
    // Another window may have created a custom template while we were loading.
    if (!(await fs.exists(path))) throw error;
    return loadPrompt(vault, name);
  }
  return builtin;
}

export async function listActionPrompts(vault: string): Promise<{ name: string; label: string }[]> {
  const fs = await getFs();
  const root = joinPath(vault, PROMPT_DIR);
  const initialized = joinPath(root, '.actions-initialized.json');
  if (!(await fs.exists(initialized))) {
    for (const [name, text] of Object.entries(DEFAULT_ACTION_PROMPTS)) {
      const path = promptPath(vault, name);
      if (await fs.exists(path)) continue;
      try {
        await fs.write(path, text, { root: vault, expected: null });
      } catch (error) {
        if (!(await fs.exists(path))) throw error;
      }
    }
    try {
      await fs.write(initialized, '{"version":1}', { root: vault, expected: null });
    } catch (error) {
      if (!(await fs.exists(initialized))) throw error;
    }
  }
  const entries = await fs.list(root);
  return entries.flatMap(({ path }) => {
    if (!path.endsWith('.md')) return [];
    const name = path.slice(0, -3);
    if (name === 'ask' || name === 'tidy') return [];
    try { validateName(name); } catch { return []; }
    return [{ name, label: name }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function ensurePrompt(vault: string, name: PromptName): Promise<string> {
  await loadPrompt(vault, name);
  return promptPath(vault, name);
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => (Object.hasOwn(vars, key) ? vars[key] : m));
}
