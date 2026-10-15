import type { Settings } from '../settings';
import type { AskRequest, QaPair } from '../editor/qa';
import { QUESTION_MARK } from '../editor/qa';
import { clipAround, fillTemplate, loadPrompt } from './prompts';
import { streamCompletion } from './providers';

export async function runAsk(
  settings: Settings,
  vault: string | null,
  req: AskRequest,
  onText: (t: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const template = await loadPrompt(vault, 'ask');
  const prompt = fillTemplate(template, {
    question: req.question,
    anchor: (req.anchor || '（无）').slice(0, 3000),
    document: clipAround(req.document, QUESTION_MARK),
  });
  return streamCompletion(settings, { prompt, signal, onText });
}

export interface TidyInput {
  title: string;
  head: string;
  notes: string;
  pairs: QaPair[];
}

export async function runTidy(
  settings: Settings,
  vault: string | null,
  input: TidyInput,
  onText: (t: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const template = await loadPrompt(vault, 'tidy');
  const qa = input.pairs
    .map((p, i) => `### ${i + 1}. ${p.question}\n相关段落：${p.anchor.slice(0, 500) || '（无）'}\n回答：${p.answer}`)
    .join('\n\n');
  const prompt = fillTemplate(template, {
    title: input.title,
    head: input.head.slice(0, 1200),
    notes: input.notes.trim() || '（空）',
    qa: qa.slice(0, 60000),
  });
  return streamCompletion(settings, { prompt, signal, onText });
}
