// Sequências de números ("1-5, 8, 10-12") e links com variável de capítulo ({n}, {n:3} = com zeros à esquerda).
// Seguro para o navegador: o formulário usa para mostrar a prévia e a API usa para montar a lista.

/** "1-5, 8, 12-10" → [1,2,3,4,5,8,12,11,10]. Aceita decimais soltos (capítulo 10.5). Vazio → []. */
export function parseRange(s: string, max = 2000): number[] {
  const out: number[] = [];
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(part);
    if (!m) throw new Error(`Sequência inválida: "${part}" (use algo como 1-5, 8, 10)`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (m[2] !== undefined && (!Number.isInteger(a) || !Number.isInteger(b))) throw new Error(`Intervalo só com inteiros: "${part}"`);
    const step = a <= b ? 1 : -1;
    for (let n = a; step > 0 ? n <= b : n >= b; n += step) {
      if (!out.includes(n)) out.push(n);
      if (out.length > max) throw new Error(`Sequência grande demais (máx. ${max})`);
    }
  }
  return out;
}

const VAR = /\{n(?::(\d+))?\}/g;
export const hasVar = (s: string) => /\{n(?::\d+)?\}/.test(s);
export const fillVar = (s: string, n: number) => s.replace(VAR, (_, pad?: string) => (pad ? String(n).padStart(Number(pad), '0') : String(n)));

export interface ChapterJob {
  url: string;
  chapter: string; // nome final
  n: number | null;
}

/**
 * Monta a lista de capítulos a baixar.
 * - `links`: um link por linha; linhas com {n} são repetidas para cada número de `chapters`.
 * - `chapterName`: nome opcional; pode ter {n}. Sem {n} e com vários capítulos, vira "<nome> <n>".
 */
export function expandChapters(links: string, chapters: string, chapterName: string, fallbackName: (i: number) => string): ChapterJob[] {
  const lines = links.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const nums = chapters.trim() ? parseRange(chapters) : [];
  const out: ChapterJob[] = [];
  for (const line of lines) {
    if (hasVar(line)) {
      if (!nums.length) throw new Error('O link tem {n}: preencha quais capítulos baixar (ex.: 1-10)');
      for (const n of nums) out.push({ url: fillVar(line, n), chapter: '', n });
    } else out.push({ url: line, chapter: '', n: null });
  }
  const name = chapterName.trim();
  out.forEach((c, i) => {
    if (name && hasVar(name)) c.chapter = fillVar(name, c.n ?? i + 1);
    else if (name) c.chapter = out.length > 1 ? `${name} ${c.n ?? i + 1}` : name;
    else c.chapter = c.n !== null ? `Capítulo ${c.n}` : fallbackName(i);
  });
  for (const c of out) if (!/^https?:\/\//.test(c.url)) throw new Error(`Link inválido: ${c.url}`);
  return out;
}

/** Troca o número escolhido do link por {n} — usado pelo botão "usar este número como variável". */
export function numbersIn(url: string): { start: number; end: number; value: string }[] {
  return [...url.matchAll(/\d+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, value: m[0] }));
}
