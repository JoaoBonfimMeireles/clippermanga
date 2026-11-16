// Revisão do gestor (Opus) sobre TODA chamada de IA do app, qualquer que seja o trabalhador (OmniRoute grátis ou Haiku).
// Depois que o trabalhador responde, o Opus lê SÓ O TEXTO (pedido resumido + resposta; nunca imagens/vídeo, para gastar pouco)
// e aprova ou reprova. Reprovou: o trabalhador refaz aquela resposta com o recado do gestor (1 vez). Cada reprovação e cada
// lição ficam guardadas por tarefa (_revisoes.json) e entram no prompt dos próximos pedidos da mesma tarefa, para os dois
// trabalhadores. Nunca derruba um job: se o Opus falhar ou estourar a cota, a resposta original segue.
// Desligar: MANGA_REVIEW=0 no .env. Limite de revisões por instância (job/etapa): MANGA_REVIEW_MAX (padrão 60).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractJson } from '@clipper/editing-planner';
import type { LLMProvider } from '@clipper/ai-providers';
import { studioDir } from './store';
import { readJsonRetry, writeJsonAtomic } from './json-file';

interface WorkerStats { calls: number; reviewed: number; redone: number }
export interface TaskMemory {
  label: string;
  lessons: string[];
  workers: Record<string, WorkerStats>;
  recent: { at: string; worker: string; ok: boolean; issues: string[] }[];
  updatedAt: string;
}
export type ReviewData = Record<string, TaskMemory>;

const file = () => path.join(studioDir(), '_revisoes.json');
export function readReviews(): ReviewData {
  try {
    return readJsonRetry<ReviewData>(file());
  } catch {
    return {};
  }
}
const MAX_LESSONS = 10;
const clean = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const keyOf = (system: string) => createHash('sha1').update(system.replace(/\s+/g, ' ').trim().slice(0, 80)).digest('hex').slice(0, 10);

function update(key: string, label: string, fn: (m: TaskMemory) => void) {
  try {
    const all = readReviews();
    const m = all[key] ?? { label, lessons: [], workers: {}, recent: [], updatedAt: '' };
    fn(m);
    m.updatedAt = new Date().toISOString();
    m.recent = m.recent.slice(-20);
    all[key] = m;
    writeJsonAtomic(file(), all);
  } catch {
    /* o registro nunca derruba a chamada */
  }
}

const REVIEW_SYSTEM = `Você é o GESTOR (Opus) de uma empresa de edição de vídeos do YouTube sobre mangá/manhwa (canal brasileiro). Um trabalhador de IA (modelo grátis ou Haiku) respondeu a um pedido. Você vê SÓ O TEXTO: o início do pedido (instruções + dados) e a resposta. Não vê imagens nem vídeo: não julgue o que depende delas.
Decida se a resposta presta. Reprove SOMENTE com problema claro: formato errado ou JSON quebrado/incompleto, regra explícita do pedido descumprida (tamanho, idioma, estrutura), texto sem sentido, repetido, cortado no meio, nomes/fatos inventados ou contraditórios com o pedido, português ruim, final sem fecho. Não reprove por gosto de estilo.
Responda SOMENTE JSON: {"ok":true|false,"issues":["problema concreto"],"redo":"instrução curta e direta do que corrigir (só se ok=false)","lesson":"regra curta e geral para evitar esse erro nesta tarefa no futuro (ou vazio)"}`;

/** Envolve um provedor: lições do gestor entram no prompt, o Opus revisa o texto e manda refazer se reprovar. */
export function supervise<T extends LLMProvider>(inner: T, makeReviewer: () => LLMProvider | null): T {
  if (process.env.MANGA_REVIEW === '0') return inner;
  const max = Number(process.env.MANGA_REVIEW_MAX) || 60;
  const complete = inner.complete.bind(inner);
  let reviews = 0;
  let reviewer: LLMProvider | null | undefined;
  inner.complete = async (req) => {
    if (req.tier === 'manager') return complete(req); // o próprio gestor não é revisado
    const key = keyOf(req.system);
    const label = clean(req.system, 70);
    const lessons = readReviews()[key]?.lessons ?? [];
    const system = lessons.length ? `${req.system}\n\nLIÇÕES DO GESTOR (erros que já apareceram nesta tarefa; não repita):\n${lessons.map((l) => `- ${l}`).join('\n')}` : req.system;
    let out = await complete({ ...req, system });
    const worker = `${inner.name}${req.tier === 'small' ? '/haiku' : ''}`;
    const count = (f: (w: WorkerStats) => void) => update(key, label, (m) => f((m.workers[worker] ??= { calls: 0, reviewed: 0, redone: 0 })));
    count((w) => w.calls++);
    // padrão novo: o Opus NÃO revisa cada chamada (obras grandes têm centenas); a revisão é no fim da etapa (lib/stage-review.ts)
    if (process.env.MANGA_REVIEW_EACH !== '1') return out;
    if (req.signal?.aborted || reviews >= max) return out;
    reviews++;
    let v: { ok?: unknown; issues?: unknown; redo?: unknown; lesson?: unknown };
    try {
      reviewer ??= makeReviewer();
      if (!reviewer) return out;
      const known = lessons.length ? `\nLições já registradas (não repita):\n${lessons.map((l) => `- ${l}`).join('\n')}\n` : '';
      v = extractJson(
        await reviewer.complete({
          system: REVIEW_SYSTEM,
          prompt: `PEDIDO (início)${req.images?.length ? ` [com ${req.images.length} imagem(ns) que você não vê]` : ''}:\n${req.system.slice(0, 1200)}\n---\n${req.prompt.slice(0, 3500)}\n${known}\nRESPOSTA DO TRABALHADOR (${worker}):\n${out.slice(0, 3500)}`,
          maxTokens: 700,
          temperature: 0.1,
          tier: 'manager',
          signal: req.signal,
        }),
      ) as typeof v;
    } catch {
      return out; // sem Opus (cota, erro): segue com a resposta original
    }
    const ok = v.ok !== false;
    const issues = (Array.isArray(v.issues) ? v.issues : []).map((x) => clean(x, 200)).filter(Boolean).slice(0, 4);
    const lesson = clean(v.lesson, 200);
    update(key, label, (m) => {
      const w = (m.workers[worker] ??= { calls: 0, reviewed: 0, redone: 0 });
      w.reviewed++;
      if (!ok) w.redone++;
      m.recent.push({ at: new Date().toISOString(), worker, ok, issues });
      if (lesson && !m.lessons.includes(lesson)) m.lessons = [...m.lessons, lesson].slice(-MAX_LESSONS);
    });
    if (ok) return out;
    const redo = clean(v.redo, 500) || issues.join('; ');
    if (!redo) return out;
    inner.onNotice?.(`Gestor (Opus) reprovou a resposta de ${worker} (${label.slice(0, 40)}…): ${issues.join('; ') || redo}. Refazendo.`);
    try {
      out = await complete({
        ...req,
        system,
        prompt: `${req.prompt}\n\nREVISÃO DO GESTOR: sua resposta anterior foi reprovada. Problemas: ${issues.join('; ') || 'ver abaixo'}. Corrija: ${redo}\nResponda de novo, no MESMO formato pedido acima, já corrigido.\n\nResposta anterior (reprovada):\n${out.slice(0, 3000)}`,
      });
    } catch {
      /* mantém a original */
    }
    return out;
  };
  return inner;
}

/** Registra um veredito feito fora do `supervise` (ex.: revisão visual dos shorts) e guarda a lição da tarefa. */
export function noteReview(key: string, label: string, worker: string, ok: boolean, issues: string[], lesson: string) {
  update(key, label, (m) => {
    const w = (m.workers[worker] ??= { calls: 0, reviewed: 0, redone: 0 });
    w.calls++;
    w.reviewed++;
    if (!ok) w.redone++;
    m.recent.push({ at: new Date().toISOString(), worker, ok, issues });
    if (lesson && !m.lessons.includes(lesson)) m.lessons = [...m.lessons, lesson].slice(-MAX_LESSONS);
  });
}

/** Lições visuais do gestor (quadros dos shorts e recortes da auditoria), para o planejamento dos próximos shorts. */
export function visualLessonsPrompt(): string {
  const all = readReviews();
  const l = [...(all['visual-short']?.lessons ?? []), ...(all['visual-crops']?.lessons ?? [])];
  return l.length ? `LIÇÕES VISUAIS DO GESTOR (vistas nos quadros dos shorts anteriores):\n${l.map((x) => `- ${x}`).join('\n')}\n\n` : '';
}
