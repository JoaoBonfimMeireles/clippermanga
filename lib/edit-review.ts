// Opus confere os recortes da edição enquanto ela anda (marcos de 10%, 25% e 100% das páginas) e corrige na hora.
// Ele VÊ uma folha com o recorte real de até 8 partes por vez e devolve, para cada recorte ruim, uma AÇÃO simples
// (abrir em cima/embaixo até a faixa lisa, mostrar a página inteira, tirar). As coordenadas são do app, medidas nos pixels.
import path from 'node:path';
import { extractJson } from '@clipper/editing-planner';
import type { jobLLM } from './ai-meter';
import { projectDir } from './store';
import { widenFocus } from './snap-panels';
import { cropSheet } from './visual-review';
import { FULL, type Shot, type StudioPage } from './types';

const SYSTEM = `Você é o GESTOR (Opus) de uma empresa de edição de vídeos de resumo de mangá/manhwa. Recebe UMA imagem com os recortes reais de várias partes (numerados na ordem da lista, esquerda→direita e cima→baixo) e a narração de cada uma. Julgue só o que vê:
- cortado_cima / cortado_baixo / cortado_lados: cabeça, cabelo, corpo, arma ou balão partido ao meio na borda do recorte;
- vazio: só branco, preto, sarjeta ou fundo sem desenho com informação;
- ok: recorte bom.
Reprove SÓ com problema visível e claro. Para cada recorte ruim escolha UMA ação: "expand_top" (abre em cima), "expand_bottom" (abre embaixo), "expand_both", "whole" (mostra a página inteira, só quando a página é curta) ou "drop" (tira o recorte; só para vazio).
Em "lessons" escreva até 2 regras curtas para o editor (Haiku) escolher melhor os quadros nas páginas que ainda faltam, no formato {"rule":"texto","global":true|false}: global=true quando serve para QUALQUER obra (tipo de quadro a evitar, formato); global=false só se for específica desta obra.
Responda SOMENTE JSON: {"summary":"1 frase","fixes":[{"n":número,"problem":"cortado_cima|cortado_baixo|cortado_lados|vazio","action":"expand_top|expand_bottom|expand_both|whole|drop"}],"lessons":[{"rule":"regra curta","global":true}]}. Tudo certo: "fixes": [], "lessons": [].`;

type Row = { pg: StudioPage; list: Shot[]; shot: Shot; pageNo: number };

const evenly = <T>(a: T[], n: number): T[] => (a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor((i * a.length) / n)]));

/** Confere as páginas [from, to) e aplica as correções em `result`. Devolve as páginas que mudaram e uma frase para o log. */
export async function reviewEditWindow(o: {
  projectId: string;
  llm: ReturnType<typeof jobLLM>;
  pages: StudioPage[];
  result: Map<string, Shot[]>;
  from: number;
  to: number;
  max: number; // quantos recortes olhar no total (8 por folha)
  refit: (s: Shot, pg: StudioPage) => Promise<Shot>; // trava de qualidade + faixa de fundo do app, depois de mexer no foco
  signal?: AbortSignal;
}): Promise<{ changed: Set<string>; note: string; kinds: string[]; lessons: unknown[] }> {
  const rows: Row[] = [];
  for (let i = o.from; i < o.to; i++) {
    const pg = o.pages[i];
    const list = o.result.get(pg.id);
    if (list) for (const shot of list) rows.push({ pg, list, shot, pageNo: i + 1 });
  }
  const changed = new Set<string>();
  const sample = evenly(rows, o.max);
  let fixedN = 0;
  let dropped = 0;
  let summary = '';
  const kinds: string[] = [];
  const lessons: unknown[] = [];
  for (let c = 0; c < sample.length; c += 8) {
    const chunk = sample.slice(c, c + 8);
    const sheet = await cropSheet(o.projectId, chunk.map((r) => ({ page: r.pg, focus: r.shot.focus })));
    if (!sheet) continue;
    const raw = await o.llm.complete({
      system: SYSTEM,
      images: [sheet],
      prompt: `Recortes da folha, na ordem:\n${chunk.map((r, k) => `[${k + 1}] página ${r.pageNo} (página ${r.pg.height > r.pg.width * 2.3 ? 'alta' : 'curta'}): "${r.shot.text.slice(0, 140)}"`).join('\n')}`,
      maxTokens: 900,
      temperature: 0.1,
      tier: 'manager',
      signal: o.signal,
    });
    const v = extractJson(raw) as { summary?: unknown; fixes?: { n?: unknown; action?: unknown; problem?: unknown }[]; lessons?: unknown };
    lessons.push(...(Array.isArray(v.lessons) ? v.lessons : []));
    summary = String(v.summary ?? summary).slice(0, 160);
    for (const f of Array.isArray(v.fixes) ? v.fixes : []) {
      const r = chunk[Number(f?.n) - 1];
      if (!r) continue;
      if (typeof f?.problem === 'string') kinds.push(f.problem.startsWith('cortado') ? 'cortado' : f.problem);
      const idx = r.list.indexOf(r.shot);
      if (idx < 0) continue;
      const img = path.join(projectDir(o.projectId), r.pg.file);
      const act = String(f?.action);
      if (act === 'drop') {
        if (r.list.length < 2) continue; // única imagem da página: fica
        const nb = r.list[idx - 1] ?? r.list[idx + 1];
        nb.duration = Math.round((nb.duration + r.shot.duration) * 10) / 10;
        nb.text = idx > 0 ? `${nb.text} ${r.shot.text}`.trim() : `${r.shot.text} ${nb.text}`.trim();
        r.list.splice(idx, 1);
        dropped++;
        changed.add(r.pg.id);
        continue;
      }
      let focus = null;
      if (act === 'whole') focus = r.pg.height <= r.pg.width * 2.3 ? { ...FULL } : await widenFocus(img, r.pg, r.shot.focus, 'both');
      else if (act === 'expand_top' || act === 'expand_bottom' || act === 'expand_both') focus = await widenFocus(img, r.pg, r.shot.focus, act === 'expand_top' ? 'top' : act === 'expand_bottom' ? 'bottom' : 'both');
      if (!focus) continue;
      r.list[idx] = await o.refit({ ...r.shot, focus }, r.pg);
      fixedN++;
      changed.add(r.pg.id);
    }
  }
  return { changed, kinds, lessons, note: `${sample.length ? `${sample.length} recorte(s) vistos` : 'nada para ver'}; ${fixedN + dropped ? `${fixedN} aberto(s), ${dropped} tirado(s)` : 'tudo certo'}${summary ? ` — ${summary}` : ''}` };
}
