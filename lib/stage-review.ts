// Revisão do gestor (Opus) NO FIM de cada etapa, em vez de a cada chamada: 1 chamada só, texto puro, com uma amostra
// espalhada pelo projeto inteiro (início, meio e fim de vários capítulos). Funciona igual para 10 ou 500 capítulos.
// Leitura das páginas e roteiro passam por aqui; edição e validação já têm a auditoria do lote (lib/manager.ts).
import { extractJson } from '@clipper/editing-planner';
import { jobLLM } from './ai-meter';
import type { JobCtx } from './jobs';
import { readNotes } from './page-notes';
import { noteReview } from './review';
import { readProject } from './store';

export type StageName = 'leitura' | 'roteiro';
const LABEL: Record<StageName, string> = { leitura: 'leitura das páginas', roteiro: 'roteiro' };
const MAX_ITEMS = 24;

const SYSTEM = `Você é o GESTOR (Opus) de uma empresa de edição de vídeos de resumo de mangá/manhwa para YouTube (canal brasileiro). Recebe uma AMOSTRA espalhada pelo trabalho inteiro de uma etapa (só texto) e dá o parecer do conjunto.
Procure padrões, não detalhes isolados: nomes de personagem inconsistentes ou genéricos ("um homem") quando deveria ser o nome, fatos inventados ou que contradizem outras partes, frases cortadas no meio, repetição, final que parece encerrar a história no meio do vídeo, quebra de continuidade entre trechos vizinhos, português ruim.
Responda SOMENTE JSON: {"ok":true|false,"summary":"parecer geral em 1-2 frases","issues":["problema concreto, com o trecho"],"lesson":"regra curta e geral para a próxima rodada (ou vazio)"}`;

function evenly<T>(a: T[], n: number): T[] {
  if (a.length <= n) return a;
  return Array.from({ length: n }, (_, i) => a[Math.floor((i * a.length) / n)]);
}

export async function reviewStage(projectId: string, stage: StageName, ctx: JobCtx): Promise<string> {
  if (process.env.MANGA_REVIEW === '0') return 'Revisão do gestor desligada';
  const p = readProject(projectId);
  if (!p) return '';
  let items: string[] = [];
  if (stage === 'leitura') {
    const notes = readNotes(projectId);
    const rows = p.pages.map((pg, i) => ({ pg, i, n: notes[pg.id] })).filter((r) => r.n && !r.n.empty && (r.n.events || r.n.dialogue));
    items = evenly(rows, MAX_ITEMS).map((r) => `[${r.pg.chapter}, pág. ${r.i + 1}] acontece: ${r.n!.events.slice(0, 220)} | falas: ${r.n!.dialogue.replace(/\n/g, ' / ').slice(0, 220)} | quadros: ${r.n!.panels.length}`);
  } else {
    const rows = p.pages.map((pg, i) => ({ pg, i, t: p.pageScript?.[pg.id] })).filter((r) => r.t);
    // pares de trechos vizinhos, para o Opus julgar a continuidade
    const picks = evenly(rows, MAX_ITEMS / 2);
    items = picks.flatMap((r) => {
      const next = rows[rows.indexOf(r) + 1];
      return [`[${r.pg.chapter}, pág. ${r.i + 1}] ${r.t!.slice(0, 260)}`, ...(next ? [`   ↳ continua [pág. ${next.i + 1}] ${next.t!.slice(0, 260)}`] : [])];
    });
  }
  if (!items.length) return `Gestor: sem material de ${LABEL[stage]} para revisar`;
  ctx.progress(0.99, `Gestor (Opus): revisando ${LABEL[stage]} (${items.length} trechos de amostra)`);
  const raw = await jobLLM(ctx).complete({
    system: SYSTEM,
    prompt: `Obra: ${p.title} · ${p.pages.length} páginas · etapa: ${LABEL[stage]}\n\nAMOSTRA (${items.length} trechos espalhados pelo projeto):\n${items.join('\n')}`.slice(0, 30000),
    maxTokens: 700,
    temperature: 0.1,
    tier: 'manager',
    signal: ctx.signal,
  });
  const v = extractJson(raw) as { ok?: unknown; summary?: unknown; issues?: unknown; lesson?: unknown };
  const ok = v.ok !== false;
  const issues = (Array.isArray(v.issues) ? v.issues : []).map((x) => String(x).replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 5);
  noteReview(`stage-${stage}`, `Revisão final: ${LABEL[stage]}`, 'opus', ok, issues, String(v.lesson ?? '').replace(/\s+/g, ' ').trim().slice(0, 200));
  return `Gestor (Opus) revisou ${LABEL[stage]} no fim da etapa: ${ok ? 'aprovado' : 'com ressalvas'} — ${String(v.summary ?? '').slice(0, 220)}${issues.length ? ` (${issues.join('; ')})` : ''}`;
}
