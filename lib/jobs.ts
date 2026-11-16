// Jobs no próprio processo do Next (sem worker separado: o app é enxuto).
// Cada etapa (mudança de mensagem de progresso) e cada aviso vira uma linha com horário em job.logs,
// que a tela mostra ao expandir o job — sem custo de IA.
// O registro também é salvo em disco (<projeto>/.progress/jobs.json, últimas 24 h): se o servidor reiniciar,
// a tela ainda mostra o que foi feito, e o job aparece como interrompido. Os jobs longos (edição, roteiro)
// guardam o trabalho já concluído em lib/checkpoint.ts e o reaproveitam ao rodar de novo.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { claudeLimits } from '@clipper/ai-providers';
import { CHECKPOINT_TTL_MS } from './checkpoint';
import { peekProject, projectDir } from './store';
import type { JobInfo } from './types';

const g = globalThis as unknown as { __mangaJobs?: Map<string, JobInfo> };
const jobs = (g.__mangaJobs ??= new Map());

export interface JobCtx {
  progress: (x: number, message?: string) => void;
  log: (m: string) => void;
  /** Disparado pelo botão Cancelar. */
  signal?: AbortSignal;
  /** Portão da reserva paga (Claude): pergunta na tela "usar o Claude?" e guarda a resposta do job. */
  paid?: PaidGate;
  /** Pausa o job e espera a resposta do usuário na tela (POST kind 'resume'). */
  pause?: (info: JobPause) => Promise<JobAnswer>;
}

export interface PaidGate {
  allowed(): boolean;
  denied(): boolean;
  ask(): void;
}

/** Resposta da tela à pergunta "OmniRoute fora: usar o Claude?" de um job. */
export function answerPaid(id: string, yes: boolean): boolean {
  const j = jobs.get(id);
  if (!j || j.status !== 'running') return false;
  j.paid = yes ? 'yes' : 'no';
  delete j.askPaid;
  j.logs.push(`${clock()}  ${yes ? '▶ Você liberou o Claude para este job' : '⏸ Você recusou o Claude: esperando a OmniRoute voltar (sem gastar)'}`);
  persist(j.projectId, true);
  return true;
}

/** Pergunta mostrada na tela enquanto o job está pausado. */
export interface JobPause {
  chapter: string;
  url: string;
  error: string;
  tried: string[];
}
export interface JobAnswer {
  url?: string;
  html?: string;
  skip?: boolean;
}
/** JobInfo com a pausa pendente (o tipo base fica em types.ts). */
export type JobWithPause = JobInfo & { pause?: JobPause };

const gw = globalThis as unknown as { __mangaJobWaits?: Map<string, (a: JobAnswer) => void> };
const waits: Map<string, (a: JobAnswer) => void> = (gw.__mangaJobWaits ??= new Map());

/** Responde a um job pausado; false se ele não está esperando. */
export function resumeJob(id: string, answer: JobAnswer): boolean {
  const w = waits.get(id);
  if (!w) return false;
  waits.delete(id);
  w(answer);
  return true;
}

const gc = globalThis as unknown as { __mangaJobAborts?: Map<string, AbortController> };
const aborts = (gc.__mangaJobAborts ??= new Map());

/** Cancela um job em andamento (o trabalho já salvo no progresso continua valendo). */
export function cancelJob(id: string): boolean {
  const a = aborts.get(id);
  if (!a) return false;
  a.abort();
  return true;
}

const MAX_LOGS = 500;
const clock = () => new Date().toLocaleTimeString('pt-BR', { hour12: false });
const INTERRUPTED = 'Interrompido (o servidor reiniciou). Rode de novo: o que já foi feito é reaproveitado.';

const jobsFile = (projectId: string) => path.join(projectDir(projectId), '.progress', 'jobs.json');

// a tela consulta os jobs a cada ~1 s: só relê o arquivo quando ele muda (stat é bem mais barato que ler + JSON.parse)
const diskCache = new Map<string, { key: string; list: JobInfo[] }>();
function readDisk(projectId: string): JobInfo[] {
  try {
    const f = jobsFile(projectId);
    const st = fs.statSync(f);
    const key = `${st.mtimeMs}:${st.size}`;
    let hit = diskCache.get(f);
    if (hit?.key !== key) diskCache.set(f, (hit = { key, list: JSON.parse(fs.readFileSync(f, 'utf8')) as JobInfo[] }));
    const list = hit.list;
    const now = Date.now();
    return list.filter((j) => now - (j.endedAt ?? j.startedAt ?? 0) < CHECKPOINT_TTL_MS);
  } catch {
    return [];
  }
}

/** Grava os jobs do projeto (memória + o que já estava em disco), no máximo a cada 1 s por projeto. */
const pending = new Map<string, NodeJS.Timeout>();
function persist(projectId: string, now = false) {
  const write = () => {
    pending.delete(projectId);
    try {
      if (!fs.existsSync(path.join(projectDir(projectId), 'project.json'))) return; // projeto excluído: não recria a pasta
      const mem = [...jobs.values()].filter((j) => j.projectId === projectId);
      const ids = new Set(mem.map((j) => j.id));
      const all = [...readDisk(projectId).filter((j) => !ids.has(j.id)), ...mem].slice(-50);
      const f = jobsFile(projectId);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      try {
        fs.renameSync(tmp, f);
      } catch {
        fs.writeFileSync(f, fs.readFileSync(tmp));
        fs.rmSync(tmp, { force: true });
      }
    } catch {
      /* registro é só conveniência: nunca derruba o job */
    }
  };
  if (now) {
    clearTimeout(pending.get(projectId));
    return write();
  }
  if (!pending.has(projectId)) pending.set(projectId, setTimeout(write, 1000));
}

export function startJob(kind: JobInfo['kind'], projectId: string, run: (ctx: JobCtx, signal: AbortSignal) => Promise<string | void>): JobInfo {
  const ac = new AbortController();
  const job: JobInfo = { id: randomUUID(), kind, projectId, status: 'running', progress: 0, message: 'Começando…', logs: [], startedAt: Date.now() };
  jobs.set(job.id, job);
  if (peekProject(projectId)?.autoPaid) job.paid = 'yes'; // check do topo: usa o Claude direto se a OmniRoute acabar
  aborts.set(job.id, ac);
  // quanto do limite de 5 h do plano do Claude este processo gasta: soma das subidas do medidor (descidas = janela renovou)
  // o medidor oscila (respostas fora de ordem: 52→54→52): vale a MAIOR leitura desde o começo; só uma queda grande é janela renovada
  let qBase: number | null = null, qPeak = 0, qDone = 0;
  const sampleQuota = () => {
    try {
      const l = claudeLimits();
      if (!l || typeof l.fiveHour !== 'number' || Date.now() - l.at > 15 * 60_000) return;
      const q = l.fiveHour;
      if (qBase === null) qBase = qPeak = q;
      else if (q < qPeak - 0.15) {
        qDone += qPeak - qBase;
        qBase = qPeak = q;
      } else if (q > qPeak) qPeak = q;
      job.quotaUsed = qDone + (qPeak - qBase);
    } catch {
      /* medidor é só informação */
    }
  };
  sampleQuota();
  const push = (line: string) => {
    sampleQuota();
    job.logs.push(`${clock()}  ${line}`);
    if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
    persist(projectId);
  };
  const ctx: JobCtx = {
    progress: (x, m) => {
      job.progress = Math.max(0, Math.min(1, x));
      if (m && m !== job.message) push(m);
      if (m) job.message = m;
    },
    log: (m) => {
      push(m);
      console.log(`[manga:${kind}] ${m}`);
    },
    signal: ac.signal,
    paid: {
      allowed: () => job.paid === 'yes',
      denied: () => job.paid === 'no',
      ask: () => {
        if (job.askPaid || job.paid) return;
        job.askPaid = true;
        push('⚠ OmniRoute fora do ar: usar o Claude (gasta o seu plano)? Responda Sim ou Não na tela');
        persist(projectId, true);
      },
    },
    pause: (info) =>
      new Promise<JobAnswer>((ok, err) => {
        const j = job as JobWithPause;
        j.pause = info;
        j.message = `Pausado: ${info.chapter} falhou — informe o link certo na aba "Importar e páginas"`;
        push(`⏸ ${info.chapter} falhou (${info.url}): ${info.error}`);
        const done = () => {
          delete j.pause;
          waits.delete(job.id);
        };
        waits.set(job.id, (a: JobAnswer) => {
          done();
          push(a.skip ? `▶ ${info.chapter} pulado` : `▶ Continuando ${info.chapter} com ${a.url || 'o HTML colado'}`);
          ok(a);
        });
        ac.signal.addEventListener('abort', () => (done(), err(new Error('Cancelado'))), { once: true });
      }),
  };
  push('Começando…');
  run(ctx, ac.signal)
    .finally(() => aborts.delete(job.id))
    .then((m) => {
      sampleQuota();
      Object.assign(job, { status: 'done', progress: 1, message: m || 'Pronto', endedAt: Date.now() });
      push(`✔ ${m || 'Pronto'}`);
      persist(projectId, true);
    })
    .catch((e: Error) => {
      sampleQuota();
      console.error(e);
      const msg = ac.signal.aborted ? 'Cancelado' : e.message;
      Object.assign(job, { status: 'error', message: msg, endedAt: Date.now() });
      push(`✖ ${msg}`);
      persist(projectId, true);
    });
  return job;
}

export const getJob = (id: string) => jobs.get(id) ?? null;

/** Jobs do projeto: os da memória e, das últimas 24 h, os salvos em disco (os que ficaram "rodando" sem processo = interrompidos). */
export function projectJobs(projectId: string): JobInfo[] {
  const mem = [...jobs.values()].filter((j) => j.projectId === projectId);
  const ids = new Set(mem.map((j) => j.id));
  const old = readDisk(projectId)
    .filter((j) => !ids.has(j.id))
    .map((j) => (j.status === 'running' ? { ...j, status: 'error' as const, message: INTERRUPTED } : j));
  return [...old, ...mem].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}
