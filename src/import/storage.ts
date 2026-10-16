import { getFs, joinPath } from '../fs';
import type { ImportedMaterial } from './types';

export interface MaterialInfo {
  version: 1;
  kind: ImportedMaterial['kind'];
  title: string;
  source: string;
  importedAt: string;
  readOnly: boolean;
  warnings: string[];
}

export const materialPath = (path: string) => path.replace(/\.md$/i, '') + '.reading.json';
export const annotationPath = (path: string) => path.replace(/\.md$/i, '') + '.annotations.md';

export function parseMaterial(raw: string): MaterialInfo {
  const value = JSON.parse(raw) as MaterialInfo;
  if (value?.version !== 1 || !['web', 'pdf', 'epub'].includes(value.kind)
    || typeof value.title !== 'string' || typeof value.source !== 'string'
    || typeof value.importedAt !== 'string' || typeof value.readOnly !== 'boolean'
    || !Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')) {
    throw new Error('阅读材料信息损坏，请检查同名 .reading.json 文件。');
  }
  return value;
}

export async function saveMaterial(root: string, material: ImportedMaterial): Promise<string> {
  if (!material.markdown.trim()) throw new Error('没有可以保存的正文。');
  const fs = await getFs();
  const clean = material.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100) || '导入材料';
  const stem = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? '_' + clean : clean;
  let index = 1;
  let rel: string;
  while (true) {
    rel = `${stem}${index === 1 ? '' : ` (${index})`}.md`;
    const path = joinPath(root, rel);
    const occupied = await Promise.all([path, materialPath(path), annotationPath(path), path.replace(/\.md$/i, '.notes.md')].map((candidate) => fs.exists(candidate)));
    if (!occupied.some(Boolean)) break;
    index++;
  }
  const path = joinPath(root, rel);
  const info: MaterialInfo = { version: 1, kind: material.kind, title: material.title, source: material.source, importedAt: new Date().toISOString(), readOnly: true, warnings: material.warnings };
  // Write protection first: a failed source save cannot expose an imported original as editable.
  await fs.write(materialPath(path), JSON.stringify(info, null, 2), { root, expected: null });
  await fs.write(path, material.markdown, { root, expected: null });
  return rel;
}
