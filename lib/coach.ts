// O Opus ensina o Haiku DURANTE o trabalho: o que ele corrige em 10% vira regra no prompt do Haiku para os 90% seguintes.
// Se o mesmo tipo de erro aparece de novo no marco seguinte, a regra vira OBRIGATÓRIA (mais forte e com a contagem de vezes).
// As regras ficam guardadas (projetos/_coach.json) e já entram valendo nos jobs seguintes: o tipo de erro vale para tudo, as
// observações livres do Opus só para a mesma obra. Um tipo de erro que não aparece há 90 dias deixa de valer.
import path from 'node:path';
import { readJsonRetry, writeJsonAtomic } from './json-file';
import { studioDir } from './store';

export interface Coach {
  /** Registra os tipos de erro achados num marco (cada tipo conta 1 por marco) e as regras livres que o Opus escreveu. */
  record(kinds: string[], lessons: unknown[]): void;
  /** Texto para colocar no prompt do Haiku ('' enquanto não houve nada a corrigir). */
  prompt(): string;
  /** Resumo curto para o log. */
  summary(): string;
}

const EXPIRE_MS = 90 * 24 * 3600 * 1000;
type Saved = Record<string, { kinds?: Record<string, { hits: number; at: number }>; works?: Record<string, { lessons: string[]; at: number }>; global?: { lessons: string[]; at: number } }>;
const file = () => path.join(studioDir(), '_coach.json');
const readSaved = (): Saved => {
  try {
    return readJsonRetry<Saved>(file());
  } catch {
    return {};
  }
};

/** `store`: etapa ('roteiro' | 'edicao') e obra; com ele as regras passam de um job para o outro. */
export function makeCoach(rules: Record<string, string>, store?: { stage: string; work: string }): Coach {
  const hits = new Map<string, number>();
  let extra: string[] = []; // observações só desta obra (nomes, enredo)
  let extraGlobal: string[] = []; // observações que valem para qualquer obra
  const persist = () => {
    if (!store) return;
    try {
      const all = readSaved();
      const st = (all[store.stage] ??= {});
      st.kinds = Object.fromEntries([...hits].map(([k, n]) => [k, { hits: n, at: Date.now() }]));
      (st.works ??= {})[store.work] = { lessons: extra, at: Date.now() };
      st.global = { lessons: extraGlobal, at: Date.now() };
      writeJsonAtomic(file(), all);
    } catch {
      /* guardar a regra nunca derruba o job */
    }
  };
  if (store) {
    const st = readSaved()[store.stage];
    for (const [k, v] of Object.entries(st?.kinds ?? {})) if (rules[k] && Date.now() - v.at < EXPIRE_MS) hits.set(k, v.hits);
    const w = st?.works?.[store.work];
    if (w && Date.now() - w.at < EXPIRE_MS) extra = w.lessons.slice(-5);
    if (st?.global && Date.now() - st.global.at < EXPIRE_MS) extraGlobal = st.global.lessons.slice(-8);
  }
  return {
    record(kinds, lessons) {
      for (const k of new Set(kinds)) if (rules[k]) hits.set(k, (hits.get(k) ?? 0) + 1);
      for (const raw of lessons) {
        // {"rule","global"}: regra geral vale em qualquer obra; texto solto ou global:false fica só nesta obra
        const o = typeof raw === 'object' && raw ? (raw as { rule?: unknown; text?: unknown; global?: unknown }) : null;
        const l = String(o ? o.rule ?? o.text ?? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 220);
        if (!l) continue;
        if (o?.global === true) {
          if (!extraGlobal.includes(l)) extraGlobal = [...extraGlobal, l].slice(-8);
        } else if (!extra.includes(l)) extra = [...extra, l].slice(-5);
      }
      persist();
    },
    prompt() {
      if (!hits.size && !extra.length && !extraGlobal.length) return '';
      const lines = [...hits].map(([k, n]) => `- ${n >= 2 ? `REGRA OBRIGATÓRIA (o gestor já corrigiu isso ${n} vezes neste trabalho; não repita de jeito nenhum)` : 'ATENÇÃO (o gestor corrigiu isso no começo do trabalho)'}: ${rules[k]}`);
      for (const l of [...extraGlobal, ...extra]) lines.push(`- Observação do gestor: ${l}`);
      return `CORREÇÕES DO GESTOR NESTE TRABALHO (aplique daqui para frente):\n${lines.join('\n')}\n`;
    },
    summary() {
      return [...hits].map(([k, n]) => `${k}×${n}`).join(', ');
    },
  };
}
