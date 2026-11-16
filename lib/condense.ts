// Encurta o roteiro já escrito até caber na duração-alvo do vídeo (só texto, sem reler páginas).
// Trabalha em trechos seguidos do mesmo capítulo: a IA reescreve as falas do trecho com um teto de palavras,
// mantendo a ordem, a continuidade e uma fala por parte (parte sem importância pode ficar vazia).
// O texto original fica salvo em .progress/script-before-condense.json; o progresso por trecho é salvo (retoma).
import fs from 'node:fs';
import path from 'node:path';
import { extractJson } from '@clipper/editing-planner';
import { jobLLM } from './ai-meter';
import { videoBudget } from './autoedit';
import { loadCheckpoint, saveCheckpoint } from './checkpoint';
import { readProject, updateProject, projectDir } from './store';
import { readNotes } from './page-notes';
import { dropSilentShots } from './speech-only';
import { lockedSet } from './lock';
import type { JobCtx } from './jobs';

const WPS = 2.5; // o mesmo ritmo da narração (voice-blocks.ts)
const CHUNK = 30;
const CK = 'condense-v3';
/** Teto da duração: pedida × 1,2. */
export const MAX_OVER = 1.2;
export const scriptWords = (shots: { text: string }[]) => shots.reduce((a, s) => a + (s.text.trim() ? s.text.trim().split(/\s+/).length : 0), 0);
export const SCRIPT_WPS = WPS;

const SYSTEM = `Você encurta a narração de um vídeo de resumo de mangá/manhwa, em português do Brasil.
Recebe um trecho com as falas das partes, em ordem, e um TETO de palavras para o trecho inteiro.
Cada parte traz o que a imagem dela mostra (impacto 1-10 e se é ação). A narração de cada parte tem que combinar com a imagem dela.
Reescreva para caber no teto, pensando no contexto da história toda:
- PRIORIDADE: os momentos mais importantes e impactantes da trama (viradas, revelações, mortes, vitórias) e as melhores cenas de ação ficam com narração; o corte cai sobre o que é secundário.
- ESTRUTURA: cada arco, desafio, fase ou luta precisa ter começo (o que está em jogo), meio (o conflito) e fim (o resultado). Nunca corte o desfecho de algo que foi apresentado, nem apresente algo que não fecha.
- CONTINUIDADE: texto corrido e natural, como um narrador contando a história; cada fala liga com a anterior. Nada de frases soltas ou desconexas.
- Mantenha quem faz o quê, os nomes como estão e o tom empolgado de narrador. Não invente nada.
Corte: repetições, detalhes secundários, descrições longas, falas reproduzidas palavra por palavra (resuma). Partes de impacto baixo podem ficar vazias (""), desde que a seguinte costure o que aconteceu.
Mantenha os nomes como estão. Não invente nada.
Responda SOMENTE JSON: {"texts":["...","..."]} com exatamente um texto por parte, na mesma ordem.`;

const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

export async function condenseScript(projectId: string, ctx: JobCtx): Promise<string> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  const locked = lockedSet(p); // capítulos prontos não são encurtados; só contam no tempo total
  const lockedWords = p.shots.filter((s) => locked.has(s.pageId)).reduce((a, s) => a + words(s.text), 0);
  const total = p.shots.reduce((a, s) => a + words(s.text), 0) - lockedWords;
  // regra do usuário: a duração pedida é a referência; pode passar no MÁXIMO 20% (menos não tem limite).
  // Mira na duração pedida +10% para sobrar folga até o teto.
  const base = Math.max(1, videoBudget(p) * WPS - lockedWords);
  const target = Math.round(base * 1.1);
  if (total <= base * MAX_OVER) return `O roteiro já cabe: ${total} palavras (~${Math.round(total / WPS / 60)} min, teto ${Math.round((base * MAX_OVER) / WPS / 60)} min)`;
  const ratio = target / total;
  ctx.log(`Roteiro com ${total} palavras (~${Math.round(total / WPS / 60)} min); meta ${target} palavras (~${Math.round(target / WPS / 60)} min): cortar para ${Math.round(ratio * 100)}%`);
  const backup = path.join(projectDir(projectId), '.progress', 'script-before-condense.json');
  if (!fs.existsSync(backup)) {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, JSON.stringify(Object.fromEntries(p.shots.map((s) => [s.id, s.text]))));
    ctx.log('Texto original guardado em .progress/script-before-condense.json');
  }
  const llm = jobLLM(ctx);
  const done = loadCheckpoint<string>(projectId, 'condense', CK);
  const notes = readNotes(projectId);
  const chapterOf = new Map(p.pages.map((x) => [x.id, x.chapter]));
  // trechos: até CHUNK partes seguidas do mesmo capítulo
  const chunks: (typeof p.shots)[] = [];
  for (const s of p.shots.filter((x) => !locked.has(x.pageId))) {
    const last = chunks.at(-1);
    if (last && last.length < CHUNK && chapterOf.get(last[0].pageId) === chapterOf.get(s.pageId)) last.push(s);
    else chunks.push([s]);
  }
  const out = new Map<string, string>();
  let prevTail = '';
  for (const [i, chunk] of chunks.entries()) {
    if (ctx.signal?.aborted) throw new Error('Cancelado');
    ctx.progress(i / chunks.length, `Encurtando roteiro (trecho ${i + 1}/${chunks.length})`);
    const spoken = chunk.filter((s) => s.text.trim());
    if (!spoken.length || spoken.every((s) => done.has(s.id))) {
      chunk.forEach((s) => done.has(s.id) && out.set(s.id, done.get(s.id)!));
      prevTail = chunk.map((s) => out.get(s.id) ?? s.text).filter(Boolean).slice(-2).join(' ');
      continue;
    }
    const have = spoken.reduce((a, s) => a + words(s.text), 0);
    const cap = Math.max(8, Math.round(have * ratio));
    const list = spoken
      .map((s, k) => {
        const n = notes[s.pageId];
        const imp = n?.panels.length ? Math.max(...n.panels.map((q) => q.impact)) : 0;
        const act = n?.panels.some((q) => q.kind === 'action');
        const max = Math.max(imp >= 7 || act ? 6 : 0, Math.round(words(s.text) * ratio * (imp >= 7 || act ? 1.3 : 0.8)));
        return `${k + 1}. [imagem: ${n?.events?.slice(0, 120) || '?'}${imp ? ` · impacto ${imp}` : ''}${act ? ' · AÇÃO' : ''} · máx ${max} palavras] ${s.text}`;
      })
      .join('\n');
    // teto obrigatório: passou de 15% acima, pede de novo dizendo quanto veio; fica com a versão mais curta
    let got: string[] | null = null;
    let best: string[] | null = null;
    let feedback = '';
    for (let attempt = 1; attempt <= 3 && !got; attempt++) {
      try {
        const raw = await llm.complete({
          system: SYSTEM,
          prompt: `${p.context ? `Obra: ${p.context.slice(0, 1500)}\n` : ''}${p.chapterContexts?.[chapterOf.get(chunk[0].pageId) ?? ''] ? `Resumo do capítulo: ${p.chapterContexts[chapterOf.get(chunk[0].pageId)!].slice(0, 400)}
` : ''}${prevTail ? `Narração logo antes deste trecho (contexto, não reescreva): "${prevTail.slice(-300)}"\n` : ''}TETO OBRIGATÓRIO: ${cap} palavras no total (hoje são ${have}, corte para ~${Math.round(ratio * 100)}%). Respeite o "máx" de cada parte.${feedback} ${spoken.length} partes:\n${list}`,
          maxTokens: 400 + cap * 3,
          temperature: 0.3,
          signal: ctx.signal,
        });
        const t = ((extractJson(raw) as { texts?: unknown[] }).texts ?? []).map((x) => String(x ?? '').trim());
        if (t.length !== spoken.length) throw new Error(`veio ${t.length} de ${spoken.length} textos`);
        const n = t.reduce((a, x) => a + words(x), 0);
        if (!best || n < best.reduce((a, x) => a + words(x), 0)) best = t;
        if (n <= cap * 1.15) got = t;
        else feedback = ` ATENÇÃO: a versão anterior teve ${n} palavras, muito acima do teto de ${cap}. Corte bem mais: resuma falas, junte ideias, deixe vazias as partes de impacto baixo.`;
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        if (attempt === 3 && !best) ctx.log(`Trecho ${i + 1} não encurtado: ${(e as Error).message.slice(0, 160)}`);
      }
    }
    if (!got && best) {
      got = best;
      ctx.log(`Trecho ${i + 1}: ficou com ${best.reduce((a, x) => a + words(x), 0)} palavras (teto ${cap})`);
    }
    if (got) spoken.forEach((s, k) => (out.set(s.id, got![k]), saveCheckpoint(projectId, 'condense', CK, s.id, got![k])));
    prevTail = chunk.map((s) => out.get(s.id) ?? s.text).filter(Boolean).slice(-2).join(' ');
    // grava a cada trecho: o progresso aparece no projeto e não se perde
    if (got) updateProject(projectId, (cur) => cur.shots.forEach((s) => out.has(s.id) && (s.text = out.get(s.id)!)));
  }
  // regra fixa: nenhuma imagem sem fala. As partes que ficaram vazias saem da linha do tempo
  const dropped = dropSilentShots(projectId);
  if (dropped) ctx.log(`${dropped} parte(s) sem fala removidas: toda imagem precisa de narração`);
  const after = readProject(projectId)!.shots.reduce((a, s) => a + words(s.text), 0);
  return `Roteiro encurtado: ${total} → ${after} palavras (~${Math.round(after / WPS / 60)} min de narração)`;
}
