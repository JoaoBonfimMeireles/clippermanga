// "Aplicar meu estilo" nos recortes: segue as regras aprendidas das correções do usuário (lib/learning.ts).
// - Arrumar (tidy): partes seguidas da mesma página com recortes quase iguais (o usuário repetiu a imagem à mão)
//   ganham UM recorte exato, encaixado no quadro e sem sobras de sarjeta.
// - IA: para cada página, a IA decide quais falas mostram o mesmo quadro/cena (repete a imagem), quando abrir para a
//   cena geral e quando fechar no personagem. Quando fica em dúvida, anota uma pergunta com até 3 opções de recorte,
//   que o usuário responde no modal do editor ("Seguir" aplica e renderiza só o que mudou).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractJson } from '@clipper/editing-planner';
import { jobLLM } from './ai-meter';
import { cleanRect } from './camera';
import { pageBlocks, trimBorders } from './autoedit';
import { learningPrompt } from './learning';
import { cutsPrompt } from './cut-profiles';
import { skillsPrompt } from './skills';
import { concurrency, pool } from './pool';
import { lockedSet } from './lock';
import { avoidAds, findPromo, findRepeatedEnds } from './promo';
import { enforceProject } from './crop-enforce';
import { readNotes } from './page-notes';
import { projectDir, readProject, updateProject } from './store';
import type { JobCtx } from './jobs';
import type { Doubt, Rect, Shot, StudioPage } from './types';

const SYSTEM = `Você escolhe a imagem de cada fala de um vídeo de resumo de manhwa/webtoon, seguindo o gosto do dono do canal. Você NÃO vê as imagens: decide pelas descrições.
Recebe UMA página (tira vertical) dividida em quadros numerados (Q1, Q2... de cima para baixo, com a descrição e o formato) e as
falas narradas enquanto a página aparece. Para cada fala escolha o que mostrar:
- "q": [n] um quadro, ou [n, m] do quadro n até o m juntos numa imagem só (cena geral);
- "same": true = repete exatamente a imagem da fala anterior.
COMO DECIDIR, nesta ordem:
1. A fala continua o MESMO momento da anterior (reação, comentário, pensamento, explicação, resposta da mesma conversa, algo citado que não tem quadro próprio)? "same": true. O normal é de 2 a 4 falas por imagem: não faça um recorte novo a cada fala.
2. A fala traz momento, personagem ou ação NOVA? O quadro que mostra isso: [n]. A imagem tem que mostrar o que a fala diz, nunca outro momento nem um quadro adiante na história.
3. Dois quadros vizinhos mostram o MESMO instante e se completam (encarar + reação, golpe + queda, grupo + provocação), ou a fala é uma explicação geral da cena? Junte: [n, m]. Quadro marcado "baixo" fica muito ampliado sozinho: se o vizinho é do mesmo momento, junte os dois. Nunca junte momentos diferentes, janela de sistema com cena, nem mais de 3 quadros.
4. Nunca um quadro que é só balão, caixa de texto, logo ou título. "(sem descrição)" costuma ser isso: evite se houver quadro descrito ou der para repetir. Janela de sistema só quando a fala é sobre o sistema.
5. A primeira fala da página nunca é "same".
DÚVIDA: só quando for real (nenhum quadro mostra o que a fala diz, ou dois quadros servem igualmente). Dê o seu melhor palpite e acrescente
"doubt": {"question": "pergunta curta", "options": [[n], [n, m], "same"]} com 2 a 3 opções (a primeira = seu palpite). No máximo 1 dúvida a cada 5 falas: o dono confirma o palpite em 2 de cada 3 dúvidas, então na maioria das vezes perguntar só toma o tempo dele.
Responda SOMENTE JSON: {"r":[{"part":12,"q":[2]},{"part":13,"same":true},{"part":14,"q":[3,4],"doubt":{"question":"...","options":[[3,4],[3],"same"]}}]}`;

type Pick = { part?: number; q?: number[]; same?: boolean; doubt?: { question?: string; options?: (number[] | string)[] } };
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) / Math.max(0.001, Math.min(a.y1 - a.y0, b.y1 - b.y0));

async function exact(img: string, pg: StudioPage, r: Rect): Promise<Rect> {
  return trimBorders(img, pg, r);
}

/** Partes seguidas da mesma página com recortes quase iguais viram um recorte só, exato. */
export async function tidyGroups(projectId: string, from: number, to: number, ctx: JobCtx): Promise<number> {
  const p = readProject(projectId)!;
  const pageOf = new Map(p.pages.map((pg) => [pg.id, pg]));
  const groups: number[][] = [];
  for (let i = from - 1; i < to; i++) {
    const s = p.shots[i], prev = p.shots[i - 1], g = groups[groups.length - 1];
    if (g && i > from - 1 && prev && prev.pageId === s.pageId && !s.newImage && !prev.newImage && overlap(prev.focus, s.focus) > 0.75 && Math.abs(prev.focus.x0 - s.focus.x0) < 0.05 && Math.abs(prev.focus.x1 - s.focus.x1) < 0.05) g.push(i);
    else groups.push([i]);
  }
  const fixes = new Map<number, Rect>();
  for (const g of groups.filter((x) => x.length > 1)) {
    const s0 = p.shots[g[0]], pg = pageOf.get(s0.pageId);
    if (!pg) continue;
    const fs0 = g.map((i) => p.shots[i].focus);
    const union = cleanRect({ x0: Math.min(...fs0.map((f) => f.x0)), x1: Math.max(...fs0.map((f) => f.x1)), y0: Math.min(...fs0.map((f) => f.y0)), y1: Math.max(...fs0.map((f) => f.y1)) });
    const r = await exact(path.join(projectDir(projectId), pg.file), pg, union);
    for (const i of g) fixes.set(i, r);
  }
  updateProject(projectId, (cur) => {
    for (const [i, r] of fixes) if (cur.shots[i]) cur.shots[i].focus = r;
  });
  ctx.log(`Arrumado: ${fixes.size} falas em ${groups.filter((x) => x.length > 1).length} grupos com a mesma imagem, recorte encaixado no quadro`);
  return fixes.size;
}

export async function restyleProject(projectId: string, ctx: JobCtx, opts: { tidyTo?: number; from?: number; to?: number }): Promise<string> {
  const p0 = readProject(projectId);
  if (!p0) throw new Error('Projeto não encontrado');
  // cópia de segurança antes de mexer
  const bk = path.join(projectDir(projectId), '.progress', `antes-do-estilo-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(bk), { recursive: true });
  fs.writeFileSync(bk, JSON.stringify(p0.shots));
  ctx.log(`Cópia de segurança das partes: ${path.basename(bk)}`);
  if (opts.tidyTo) await tidyGroups(projectId, 1, Math.min(opts.tidyTo, p0.shots.length), ctx);

  const from = Math.max(1, opts.from ?? 1), to = Math.min(p0.shots.length, opts.to ?? p0.shots.length);
  if (from > to) return 'Arrumado';
  const notes = readNotes(projectId);
  const pageOf = new Map(p0.pages.map((pg) => [pg.id, pg]));
  const llm = jobLLM(ctx);
  // regras fixas do job no SYSTEM (igual em todas as chamadas: o provedor guarda em cache e não cobra de novo a cada página).
  // Esta etapa decide qual imagem vai em cada fala: é o trabalho do Montador, então as habilidades dele também entram aqui.
  const system = `${SYSTEM}${skillsPrompt('montador')}\n${learningPrompt(7500)}${cutsPrompt(p0)}`;
  const locked = lockedSet(p0);
  // páginas em sequência dentro do trecho (uma chamada por página)
  const runs: { pageId: string; idx: number[] }[] = [];
  for (let i = from - 1; i < to; i++) {
    const s = p0.shots[i];
    if (locked.has(s.pageId)) continue; // capítulos prontos ficam como estão
    if (p0.narration !== 'mic' && !s.text.trim()) continue; // sem fala não entra no vídeo: sem IA e sem dúvida no modal
    const last = runs[runs.length - 1];
    if (last && last.pageId === s.pageId && last.idx[last.idx.length - 1] === i - 1) last.idx.push(i);
    else runs.push({ pageId: s.pageId, idx: [i] });
  }
  // logo e créditos de qualquer scan: bloco das pontas da página que se repete em vários capítulos
  const repeated = await findRepeatedEnds(
    await Promise.all(p0.pages.map(async (pg) => {
      const img = path.join(projectDir(projectId), pg.file);
      return { img, page: pg, blocks: await pageBlocks(img, pg) };
    })),
  );
  if (repeated.size) ctx.log(`Logos e créditos repetidos achados em ${repeated.size} página(s): ficaram fora dos recortes`);
  const doubts: Doubt[] = [];
  let changed = 0, same = 0;
  // cada página é independente (a fala "same" só olha para dentro da própria página): várias ao mesmo tempo.
  // Antes era uma chamada por vez (~580 num lote de 15 capítulos) e este passo era o maior tempo da edição.
  const CONC = concurrency('MANGA_RESTYLE_CONCURRENCY', 5);
  if (runs.length > 1) ctx.log(`Estilo: ${runs.length} página(s), ${Math.min(CONC, runs.length)} ao mesmo tempo`);
  let doneRuns = 0;
  const one = async (run: (typeof runs)[number], k: number): Promise<void> => {
    const pg = pageOf.get(run.pageId);
    const cur = readProject(projectId)!;
    const shots = run.idx.map((i) => cur.shots[i]);
    if (!pg || shots.every((s) => s.newImage)) return;
    const img = path.join(projectDir(projectId), pg.file);
    // propaganda/créditos da scan nunca viram quadro: nem como recorte, nem como opção de dúvida
    const ads = [...(await findPromo(img, pg)), ...(repeated.get(img) ?? [])];
    const panels = notes[pg.id]?.panels ?? [];
    // os quadros vêm da LEITURA (caixas que a IA viu na imagem, com a descrição); o corte por pixel só entra se a página não tem leitura
    const base: { x0: number; x1: number; y0: number; y1: number; what?: string }[] = panels.length
      ? panels.map((q) => ({ ...q.box, what: q.what })).sort((a, b) => a.y0 - b.y0)
      : (await pageBlocks(img, pg)).map((b) => ({ x0: 0, x1: 1, ...b }));
    const blocks = base.flatMap((b) => {
      const r = avoidAds({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 }, ads);
      return r ? [{ x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, what: b.what }] : [];
    });
    if (!blocks.length) return;
    const desc = (b: { y0: number; y1: number; what?: string }) =>
      b.what ||
      panels.filter((q) => Math.min(b.y1, q.box.y1) - Math.max(b.y0, q.box.y0) > (q.box.y1 - q.box.y0) * 0.4).map((q) => q.what).join('; ') ||
      '(sem descrição)';
    const qOf = (f: Rect) => blocks.map((b, j) => (Math.min(b.y1, f.y1) - Math.max(b.y0, f.y0) > 0 ? j + 1 : 0)).filter(Boolean);
    const prev = cur.shots[run.idx[0] - 1];
    // formato do quadro em palavras: "baixo" (bem mais largo que alto) fica muito ampliado sozinho, e é o que o dono mais corrige abrindo a cena
    const shapeOf = (q: { x0: number; x1: number; y0: number; y1: number }) => {
      const r = ((q.y1 - q.y0) * pg.height) / Math.max(1, (q.x1 - q.x0) * pg.width);
      return r < 0.6 ? 'baixo' : r > 1.3 ? 'alto' : 'médio';
    };
    const prompt = `PÁGINA (${blocks.length} quadros):\n${blocks.map((b, j) => `Q${j + 1} (altura ${Math.round(b.y0 * 100)}–${Math.round(b.y1 * 100)}%, ${shapeOf(b)}): ${desc(b)}`).join('\n')}\n\n${prev ? `Fala anterior (outra página): "${prev.text.slice(0, 160)}"\n` : ''}FALAS:\n${shots.map((s, j) => `Parte ${run.idx[j] + 1} (hoje mostra Q${qOf(s.focus).join('–') || '?'}): "${s.text.slice(0, 220)}"`).join('\n')}`;
    let out: { r?: Pick[] } = {};
    try {
      out = extractJson(await llm.complete({ system, prompt: prompt.slice(0, 20000), maxTokens: 1500, temperature: 0.2, tier: 'small', signal: ctx.signal })) as { r?: Pick[] };
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.log(`Página ${k + 1}: IA falhou (${(e as Error).message.slice(0, 100)}); mantida`);
      return;
    }
    const rectOf = async (q: number[] | undefined): Promise<Rect | null> => {
      const ns = (q ?? []).map(Number).filter((n) => n >= 1 && n <= blocks.length);
      if (!ns.length) return null;
      const a = blocks[Math.min(...ns) - 1], b = blocks[Math.max(...ns) - 1];
      return trimBorders(img, pg, cleanRect({ x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: a.y0, y1: b.y1 }));
    };
    const byPart = new Map((out.r ?? []).map((r) => [Number(r.part), r]));
    const result = new Map<number, Rect>();
    for (const [j, i] of run.idx.entries()) {
      const s = shots[j];
      if (s.newImage) continue;
      const r = byPart.get(i + 1);
      if (!r) continue;
      let f: Rect | null = null;
      if (r.same && j > 0) {
        f = result.get(run.idx[j - 1]) ?? shots[j - 1].focus;
        same++;
      } else f = await rectOf(r.q);
      if (f) result.set(i, f);
      if (r.doubt?.question && Array.isArray(r.doubt.options)) {
        const opts: Doubt['options'] = [];
        for (const o of r.doubt.options.slice(0, 3)) {
          const of = o === 'same' ? (j > 0 ? result.get(run.idx[j - 1]) ?? shots[j - 1].focus : null) : Array.isArray(o) ? await rectOf(o) : null;
          if (!of || opts.some((x) => JSON.stringify(x.focus) === JSON.stringify(of))) continue;
          opts.push({ label: o === 'same' ? 'Repetir a imagem da fala anterior' : Array.isArray(o) && o.length > 1 && Math.max(...o) !== Math.min(...o) ? `Cena geral (quadros ${Math.min(...o)}–${Math.max(...o)})` : `Só o quadro ${Array.isArray(o) ? o[0] : ''}`, pageId: pg.id, focus: of });
        }
        if (opts.length >= 2) doubts.push({ id: randomUUID().slice(0, 8), shotId: s.id, part: i + 1, text: s.text, question: String(r.doubt.question).trim(), options: opts });
      }
    }
    updateProject(projectId, (d) => {
      for (const [i, f] of result) {
        const s = d.shots[i];
        if (!s || s.id !== cur.shots[i].id) continue;
        if (JSON.stringify(s.focus) !== JSON.stringify(f)) changed++;
        s.focus = f;
        s.fit = s.fit ?? 'contain';
      }
    });
  };
  await pool(runs, CONC, async (run, k) => {
    await one(run, k);
    doneRuns++;
    ctx.progress(doneRuns / runs.length, `Estilo: página ${doneRuns} de ${runs.length}`);
  }, ctx.signal);
  doubts.sort((a, b) => a.part - b.part);
  updateProject(projectId, (d) => {
    const inRange = new Set(d.shots.slice(from - 1, to).filter((s) => !locked.has(s.pageId)).map((s) => s.id));
    d.doubts = [...(d.doubts ?? []).filter((x) => !inRange.has(x.shotId)), ...doubts];
  });
  ctx.log(llm.report());
  // piso de tamanho (40% da tela): vale para o que o estilo acabou de montar e para as opções das dúvidas
  await enforceProject(projectId, ctx).catch((e) => ctx.log(`Piso de tamanho falhou: ${(e as Error).message.slice(0, 160)}`));
  return `Estilo aplicado nas partes ${from}–${to}: ${changed} recortes mudados, ${same} falas repetindo a imagem anterior, ${doubts.length} dúvida(s) para você no editor`;
}
