import { effectiveSettings, type Settings } from '../settings';
import type { AskRequest, QaPair } from '../editor/qa';
import { fillTemplate, loadPrompt } from './prompts';
import { streamCompletion } from './providers';
import { validateNotes } from './notes';
import { stripImageData } from './images';
import { fitContext } from './context';
import { inputBudget, tokenCounter } from './tokens';
import { citeSources, searchWeb, sourcePrompt } from './search';

export async function runAsk(
  settings: Settings,
  vault: string | null,
  req: AskRequest,
  onText: (t: string) => void,
  signal: AbortSignal,
  onNotice?: (message: string) => void,
): Promise<string> {
  const template = await loadPrompt(vault, req.template ?? 'ask');
  const model = effectiveSettings(settings, 'ask');
  if (req.webSearch && model.provider === 'demo') throw new Error('联网查证需要先连接真实模型。');
  const sources = req.webSearch ? await searchWeb(settings, req.question, signal) : [];
  const counter = await tokenCounter(model, signal);
  const budget = inputBudget(model, req.images?.length ?? 0);
  const vars = {
    question: req.question,
    anchor: req.anchor || '（无）',
    document: '文档正文见本条消息开头；提问位置见下方「选中内容 / 问题上下文」。',
    history: req.history?.map((pair, index) => `${index + 1}. 问：${pair.question}\n答：${pair.answer}`).join('\n\n') || '（无）',
    previousAnswer: req.previousAnswer || '（无）',
    style: req.style ? {
      shorter: '更简短：保留关键结论，删去重复解释。',
      detailed: '更详细：补充推理过程、前提和具体例子。',
      alternative: '换个角度：提供不同的解释思路或例子，避免重复上次回答。',
    }[req.style] : '按模板要求回答',
  };
  if (model.provider !== 'demo') {
    vars.history = await fitContext(settings, vault, vars.history, Math.floor(budget / 6), counter, signal, onNotice);
    vars.previousAnswer = await fitContext(settings, vault, vars.previousAnswer, Math.floor(budget / 6), counter, signal, onNotice);
  }
  let prompt = fillTemplate(template, vars);
  // Older user templates need these inputs too, without changing their files.
  const essential: [keyof typeof vars, string][] = [
    ['anchor', '选中内容 / 问题上下文'], ['question', '本次问题'],
    ['history', '此前问答'], ['previousAnswer', '上一次回答'], ['style', '本次回答风格'],
  ];
  for (const [key, label] of essential) {
    if (!new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`).test(template) && vars[key] !== '（无）') prompt += `\n\n${label}：\n${vars[key]}`;
  }
  if (sources.length) prompt += sourcePrompt(sources);
  prompt = stripImageData(prompt);
  const document = stripImageData(req.sourceDocument ?? req.document);
  const available = budget - await counter.count(prompt) - 64;
  const body = await fitContext(settings, vault, document, Math.min(available, Math.floor(budget * 0.6)), counter, signal, onNotice);
  const stablePrefix = `阅读材料正文：\n\n${body}\n\n`;
  const text = await streamCompletion(model, { prompt, stablePrefix, images: req.images, signal, onText, vault, task: 'ask', onNotice });
  if (!sources.length) return text;
  const cited = citeSources(text, sources);
  onText(cited);
  return cited;
}

export interface TidyInput {
  title: string;
  head: string;
  notes: string;
  pairs: QaPair[];
  /** All current pairs allow existing notes to retain their original sources. */
  sources?: QaPair[];
}

export async function runTidy(
  settings: Settings,
  vault: string | null,
  input: TidyInput,
  onText: (t: string) => void,
  signal: AbortSignal,
  onNotice?: (message: string) => void,
): Promise<string> {
  if (!input.pairs.length) return input.notes;
  const template = await loadPrompt(vault, 'tidy');
  const model = effectiveSettings(settings, 'tidy');
  const counter = await tokenCounter(model, signal);
  const budget = inputBudget(model);
  let qa = input.pairs
    .map((p, i) => `### ${i + 1}. ${p.question}\n来源：[来源](#q-${p.id})\n相关段落：${p.anchor || '（无）'}\n回答：${p.answer}`)
    .join('\n\n');
  let head = input.head;
  const buildPrompt = (qa: string, head: string) => {
  let prompt = fillTemplate(template, {
    title: input.title,
    head,
    notes: input.notes.trim() || '（空）',
    qa,
  });
  if (!/\{\{\s*notes\s*\}\}/.test(template)) prompt += `\n\n已有笔记（保留用户原话）：\n${input.notes || '（空）'}`;
  if (!/\{\{\s*qa\s*\}\}/.test(template)) prompt += `\n\n本次新增或修改的问答：\n${qa}`;
  prompt += `\n\n必须遵守的来源约定：
- 输出完整的合并后 Markdown 笔记，保留已有笔记中的用户原话。只补充或修正本次新增、修改问答涉及的内容。
- 核心概念、要点、还没搞懂的，每个新增或改写条目均用独立列表项，末尾写 [来源](#q-ID)，只能使用下面提供的真实 ID；可引用多项。
- 每组本次问答至少在一个相关条目中被引用，不得编造或凭猜测补来源。无法找到来源的内容不要新增。
- 待追问用单行 \"- ?? 问题 [来源](#q-ID)\"，问题要具体可提问。
- 只输出 Markdown 笔记，不包裹代码围栏，不输出进度记录。
可用来源：\n${(input.sources ?? input.pairs).map((pair) => `#q-${pair.id}：${pair.question}`).join('\n')}`;
  return stripImageData(prompt);
  };
  if (model.provider !== 'demo') {
    const available = budget - await counter.count(buildPrompt('', '')) - 64;
    head = await fitContext(settings, vault, head, Math.floor(available / 4), counter, signal, onNotice);
    qa = await fitContext(settings, vault, qa, available - await counter.count(head), counter, signal, onNotice);
  }
  const prompt = buildPrompt(qa, head);
  const demoText = model.provider === 'demo'
    ? `${input.notes.trim() ? `${input.notes.trim()}\n\n` : ''}## 核心概念\n\n${input.pairs.map((pair) => `- 演示整理：${pair.question.replace(/\s+/g, ' ').replace(/[\\`*_[\]<>]/g, '\\$&')} [来源](#q-${pair.id})`).join('\n')}\n\n## 要点\n\n- 演示模式展示问答到笔记的来源关联；接入模型后会根据回答提炼内容。 [来源](#q-${input.pairs[0].id})\n\n## 还没搞懂的\n\n- ?? 这个结论在什么条件下不成立？ [来源](#q-${input.pairs[0].id})`
    : undefined;
  const text = await streamCompletion(model, { prompt, signal, onText, demoText, vault, task: 'tidy', onNotice });
  validateNotes(text, input.sources ?? input.pairs, input.pairs, input.notes);
  return text;
}
