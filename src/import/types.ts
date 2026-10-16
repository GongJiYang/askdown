export interface ImportedMaterial {
  title: string;
  markdown: string;
  kind: 'web' | 'pdf' | 'epub';
  source: string;
  warnings: string[];
}
