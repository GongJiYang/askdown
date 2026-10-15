import { getFs, joinPath } from '../fs';

/**
 * 提示词模板存放在文件库的 `.askdown/prompts/` 里，是普通的 Markdown 文件，
 * 用户可以直接在 Askdown 里打开修改。`{{变量}}` 会在调用时被替换。
 */
export type PromptName = 'ask' | 'tidy';

export const PROMPT_DIR = '.askdown/prompts';

export const DEFAULT_PROMPTS: Record<PromptName, string> = {
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

export const PROMPT_LABELS: Record<PromptName, string> = {
  ask: '提问模板',
  tidy: '整理模板',
};

export function promptPath(vault: string, name: PromptName): string {
  return joinPath(vault, `${PROMPT_DIR}/${name}.md`);
}

/** 读取模板；文件不存在时写入默认模板（这样用户第一次就能看到并修改它）。 */
export async function loadPrompt(vault: string | null, name: PromptName): Promise<string> {
  if (!vault) return DEFAULT_PROMPTS[name];
  const fs = await getFs();
  const path = promptPath(vault, name);
  try {
    if (await fs.exists(path)) {
      const text = await fs.read(path);
      if (text.trim()) return text;
    }
    await fs.write(path, DEFAULT_PROMPTS[name]);
  } catch {
    // 读写失败时退回默认模板，不影响提问
  }
  return DEFAULT_PROMPTS[name];
}

export async function ensurePrompt(vault: string, name: PromptName): Promise<string> {
  await loadPrompt(vault, name);
  return promptPath(vault, name);
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => (key in vars ? vars[key] : m));
}

/** 文档太长时，截取问题位置附近的一段，避免超出模型上下文。 */
export function clipAround(text: string, marker: string, max = 24000): string {
  if (text.length <= max) return text;
  const at = Math.max(0, text.indexOf(marker));
  const start = Math.max(0, Math.min(at - Math.floor(max * 0.7), text.length - max));
  return (start > 0 ? '……\n' : '') + text.slice(start, start + max) + (start + max < text.length ? '\n……' : '');
}
