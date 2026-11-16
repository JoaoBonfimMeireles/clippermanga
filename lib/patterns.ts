// Padrões de link aprendidos com as correções do usuário durante a importação.
// Quando o usuário cola a URL certa de um capítulo, comparamos com a gerada e guardamos um novo modelo com {n};
// os capítulos seguintes tentam o modelo original e depois cada modelo aprendido, na ordem.
import { fillVar } from './ranges';

/**
 * Transforma a URL correta do capítulo `n` num modelo com {n}: troca o número do capítulo (a ocorrência mais
 * parecida com a posição do {n} no modelo original; na dúvida, a última) por {n} — mantendo zeros à esquerda.
 * null quando o número não aparece na URL.
 */
export function learnTemplate(original: string, correct: string, n: number): string | null {
  if (!Number.isInteger(n)) return null;
  const runs = [...correct.matchAll(/\d+/g)].filter((m) => Number(m[0]) === n);
  if (!runs.length) return null;
  // contexto do {n} no modelo original: o texto logo antes dele (ex.: "chapter-")
  const at = original.search(/\{n(?::\d+)?\}/);
  const before = at >= 0 ? original.slice(Math.max(0, at - 8), at) : '';
  const score = (i: number) => {
    let k = 0;
    while (k < before.length && correct[i - 1 - k] === before[before.length - 1 - k]) k++;
    return k;
  };
  const best = runs.reduce((a, b) => (score(b.index!) >= score(a.index!) ? b : a));
  const width = best[0].length;
  const v = width > String(n).length ? `{n:${width}}` : '{n}';
  return correct.slice(0, best.index!) + v + correct.slice(best.index! + width);
}

/** URLs a tentar para o capítulo n: o modelo original e os aprendidos (sem repetir). */
export function candidates(templates: string[], n: number | null, fallback: string): string[] {
  if (n === null) return [fallback];
  return [...new Set(templates.map((t) => fillVar(t, n)))];
}
