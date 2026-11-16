// Gestor (o "Opus" da empresa de edição): mede cada agente (Leitor, Cortador, Montador), audita uma amostra depois de cada
// lote e propõe regras novas com exemplos. Nada vira regra sem você aprovar na tela /gestao.
// - Placar: calculado sem IA, do project.json + editlog (quantas partes você corrigiu, recortes pequenos/borrados, repetidas...).
// - Auditoria: 1 chamada da IA (modelo padrão, não o pequeno) sobre uma amostra das piores partes + algumas aleatórias.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractJson } from '@clipper/editing-planner';
import { jobLLM } from './ai-meter';
import { cropMetrics, QUALITY } from './crop-quality';
import { readLearning } from './learning';
import { addLearnedSkill, readSkills, type Agent } from './skills';
import { listProjects, projectDir, readProject, studioDir } from './store';
import { projectJobs, type JobCtx } from './jobs';
import { cropSheet } from './visual-review';
import type { Rect, StudioPage, StudioProject } from './types';
import { readJsonRetry, writeJsonAtomic } from './json-file';

export type ManagedAgent = Exclude<Agent, 'diretor'>;
export const MANAGED: ManagedAgent[] = ['leitor', 'cortador', 'montador'];
export const AGENT_NAME: Record<ManagedAgent, string> = { leitor: 'Leitor', cortador: 'Cortador', montador: 'Montador' };

export interface AgentScore {
  /** 0-100: 100 = você não corrigiu nada. */
  score: number;
  /** Partes que você mexeu nessa área / total de partes (0-1). */
  correctedRate: number;
  corrected: number;
  /** Problemas que a checagem automática achou (sem IA), com a explicação de cada contagem. */
  auto: { label: string; count: number }[];
}
export interface ProjectScore {
  projectId: string;
  title: string;
  shots: number;
  agents: Record<ManagedAgent, AgentScore>;
}
export interface Snapshot {
  at: string;
  projectId: string;
  title: string;
  shots: number;
  scores: Record<ManagedAgent, number>;
}
export interface Finding {
  id: string;
  agent: ManagedAgent;
  severity: 'alta' | 'media' | 'baixa';
  problem: string;
  suggestion: string;
  /** Exemplo para ver: texto da narração e, se for de recorte, a página e o recorte. */
  part: number;
  shotId: string;
  text: string;
  page?: StudioPage;
  focus?: Rect;
  areaPct?: number;
  projectId: string;
}
export interface Proposal {
  id: string;
  agent: ManagedAgent;
  title: string;
  rule: string;
  why: string;
  findingIds: string[];
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: string;
}
export interface Audit {
  id: string;
  at: string;
  projectId: string;
  title: string;
  summary: string;
  sampled: number;
  findings: Finding[];
  proposals: Proposal[];
}
export interface ManagerData {
  history: Snapshot[];
  audits: Audit[];
}

const file = () => path.join(studioDir(), '_gestao.json');
export function readManager(): ManagerData {
  try {
    return readJsonRetry<ManagerData>(file());
  } catch {
    return { history: [], audits: [] };
  }
}
function writeManager(d: ManagerData) {
  d.history = d.history.slice(-200);
  d.audits = d.audits.slice(-30);
  writeJsonAtomic(file(), d);
}

const AREA: Record<string, ManagedAgent> = {
  focus: 'cortador', fit: 'cortador', rotate: 'cortador', stretch: 'cortador', zoom: 'cortador', bgBand: 'cortador', motion: 'cortador',
  duration: 'montador', speed: 'montador', audioCuts: 'montador', pageId: 'montador',
  text: 'leitor',
};
type LogEntry = { kind: string; id: string; part: number; text?: string; note?: string; changes?: Record<string, [unknown, unknown]> };

/** Correções do lote atual: só as feitas depois da última edição com IA concluída (as antigas são de lotes anteriores). */
function readLog(projectId: string): LogEntry[] {
  const since = Math.max(0, ...projectJobs(projectId).filter((j) => j.kind === 'edit' && j.status !== 'error').map((j) => (j.status === 'running' ? (j.startedAt ?? 0) : (j.endedAt ?? 0))));
  try {
    return fs
      .readFileSync(path.join(projectDir(projectId), '.progress', 'editlog.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogEntry & { at?: string })
      .filter((e) => !since || !e.at || Date.parse(e.at) > since);
  } catch {
    return [];
  }
}

const SCREEN = { w: 1920, h: 1080 };

/** Partes em que o usuário mexeu, por agente, e o que cada uma mudou. */
function userTouches(projectId: string): Record<ManagedAgent, Map<string, string[]>> {
  const out = { leitor: new Map<string, string[]>(), cortador: new Map<string, string[]>(), montador: new Map<string, string[]>() };
  for (const e of readLog(projectId)) {
    const add = (a: ManagedAgent, what: string) => {
      const m = out[a];
      const l = m.get(e.id) ?? [];
      if (!l.includes(what)) l.push(what);
      m.set(e.id, l);
    };
    if (e.kind === 'remove' || e.kind === 'add' || e.kind === 'move') add('montador', e.kind === 'remove' ? 'apagou a parte' : e.kind === 'add' ? 'criou a parte' : 'moveu a parte');
    if (e.kind === 'doubt') add('cortador', 'respondeu uma dúvida');
    for (const k of Object.keys(e.changes ?? {})) if (AREA[k]) add(AREA[k], k);
  }
  return out;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Placar de um projeto, sem IA. */
export function scoreProject(p: StudioProject): ProjectScore {
  const n = Math.max(1, p.shots.length);
  const touches = userTouches(p.id);
  const pg = new Map(p.pages.map((x) => [x.id, x]));
  let small = 0, hard = 0, blurry = 0, loose = 0, repeated = 0;
  for (const [i, s] of p.shots.entries()) {
    const page = pg.get(s.pageId);
    if (page) {
      const m = cropMetrics(s.focus, page, s, SCREEN);
      if (m.area < QUALITY.minArea) small++;
      if (m.area < QUALITY.hardMinArea) hard++;
      if (m.problems.includes('blurry')) blurry++;
      if (!m.fillsHeight) loose++;
    }
    const prev = p.shots[i - 1];
    if (prev && prev.pageId === s.pageId && Math.abs(prev.focus.y0 - s.focus.y0) < 0.04 && Math.abs(prev.focus.x0 - s.focus.x0) < 0.04) repeated++;
  }
  const scripted = p.pages.filter((x) => p.pageScript?.[x.id]?.trim()).length;
  const noScript = p.pages.length - scripted;
  const mk = (a: ManagedAgent, auto: { label: string; count: number }[]): AgentScore => {
    const corrected = touches[a].size;
    const rate = Math.min(1, corrected / n);
    return { score: clamp(100 - rate * 100), correctedRate: rate, corrected, auto };
  };
  return {
    projectId: p.id,
    title: p.title,
    shots: p.shots.length,
    agents: {
      leitor: mk('leitor', [{ label: 'páginas sem leitura/roteiro', count: noScript }]),
      cortador: mk('cortador', [
        { label: `recortes abaixo de ${QUALITY.minArea * 100}% da tela`, count: small },
        { label: `abaixo de ${QUALITY.hardMinArea * 100}% (deve ser zero)`, count: hard },
        { label: 'recortes borrados', count: blurry },
        { label: 'soltos no meio da tela', count: loose },
      ]),
      montador: mk('montador', [{ label: 'mesma imagem repetida em seguida', count: repeated }]),
    },
  };
}

/** Placar de todos os projetos e a história (um ponto por auditoria). */
export function scoreboard(): { projects: ProjectScore[]; history: Snapshot[] } {
  const projects = listProjects()
    .filter((p) => p.shots.length)
    .map(scoreProject);
  return { projects, history: readManager().history };
}

// -------- auditoria --------

const SYSTEM = `Você é o GESTOR de uma empresa de edição de vídeos de resumo de mangá. Três agentes de IA trabalham para você:
- LEITOR: lê as páginas e escreve o roteiro/notas de cada página (o que acontece, quem fala).
- CORTADOR: escolhe e recorta a melhor parte de cada imagem (só a arte, sem balões; grudado em cima e embaixo). Ocupação da tela: 40% é o MÍNIMO (meta; nunca abaixo de 30%); ocupar mais é ótimo, 100% NÃO é problema. O problema real é a imagem borrada: ampliação acima de ~1,5x.
- MONTADOR: monta a linha do tempo (qual imagem em cada fala, sem repetir imagem, duração, ritmo).
Você recebe uma AMOSTRA de partes já editadas, com métricas e o que o dono do canal corrigiu à mão. Audite com rigor e seja concreto.
Responda SOMENTE JSON:
{"summary":"2-3 frases: como foi o lote e o que mais preocupa",
 "findings":[{"shot":"<id da parte>","agent":"leitor|cortador|montador","severity":"alta|media|baixa","problem":"o que está errado, concreto","suggestion":"o que o agente deveria ter feito"}],
 "proposals":[{"agent":"leitor|cortador|montador","title":"título curto","rule":"regra curta e acionável para o prompt do agente","why":"por que (padrão visto nos exemplos)","shots":["<ids dos exemplos>"]}]}
- Só aponte o que as métricas ou as correções do dono mostram; não invente. No máximo 8 achados e 3 propostas.
- Proposta só se houver padrão (2+ exemplos) e a regra ainda NÃO existir nas regras atuais, nem foi rejeitada antes.
- Corrija o agente certo: recorte/tamanho/balão = cortador; imagem repetida/duração/ordem = montador; texto/roteiro = leitor.`;

/** Escolhe a amostra: as partes com mais problema + as que o dono corrigiu + algumas aleatórias, no máximo `max`. */
function sample(p: StudioProject, max = 14) {
  const pg = new Map(p.pages.map((x) => [x.id, x]));
  const touches = userTouches(p.id);
  const rows = p.shots.map((s, i) => {
    const page = pg.get(s.pageId);
    const m = page ? cropMetrics(s.focus, page, s, SCREEN) : null;
    const prev = p.shots[i - 1];
    const repeated = !!prev && prev.pageId === s.pageId && Math.abs(prev.focus.y0 - s.focus.y0) < 0.04;
    const mine = (['leitor', 'cortador', 'montador'] as const).flatMap((a) => (touches[a].has(s.id) ? [`${a}: ${touches[a].get(s.id)!.join(', ')}`] : []));
    const bad = (m && m.area < QUALITY.minArea ? 3 : 0) + (m?.problems.includes('blurry') ? 2 : 0) + (m && !m.fillsHeight ? 1 : 0) + (repeated ? 2 : 0) + mine.length * 2;
    return { s, i, page, m, repeated, mine, bad };
  });
  const worst = [...rows].sort((a, b) => b.bad - a.bad).filter((r) => r.bad > 0).slice(0, Math.ceil(max * 0.75));
  const rest = rows.filter((r) => !worst.includes(r)).sort(() => Math.random() - 0.5).slice(0, max - worst.length);
  return [...worst, ...rest].sort((a, b) => a.i - b.i);
}

/** Auditoria do lote: 1 chamada da IA. Guarda achados (com exemplos visuais) e propostas de regra (pendentes). */
export async function auditProject(projectId: string, ctx: JobCtx, signal?: AbortSignal): Promise<string> {
  const p = readProject(projectId);
  if (!p || !p.shots.length) throw new Error('Projeto sem partes para auditar');
  ctx.progress(0.1, 'Gestor: medindo o placar');
  const score = scoreProject(p);
  const rows = sample(p);
  const data = readManager();
  const rejected = data.audits.flatMap((a) => a.proposals).filter((x) => x.status === 'rejected').slice(-15).map((x) => `- ${x.rule}`);
  const rules = readLearning().rules;
  const skills = MANAGED.map((a) => `${AGENT_NAME[a]}: ${readSkills(a).map((s) => s.title).join('; ')}`);
  const lines = rows.map((r) => {
    const m = r.m;
    return `[${r.s.id}] parte ${r.i + 1} (${r.s.kind ?? '?'}, ${r.s.duration.toFixed(1)} s) "${r.s.text.slice(0, 140)}"
  roteiro da página: ${(p.pageScript?.[r.s.pageId] ?? '(sem)').slice(0, 160)}
  recorte: ${m ? `${Math.round(m.area * 100)}% da tela, ampliação ${m.upscale.toFixed(2)}x, ${m.fillsHeight ? 'cobre a altura' : 'SOLTO no meio'}${m.problems.length ? `, problemas: ${m.problems.join('/')}` : ''}` : 'sem página'}${r.repeated ? '\n  MESMA IMAGEM da parte anterior' : ''}${r.mine.length ? `\n  dono corrigiu: ${r.mine.join(' | ')}` : ''}`;
  });
  ctx.progress(0.3, `Gestor: auditando ${rows.length} parte(s) da amostra`);
  const llm = jobLLM(ctx);
  // folha com o recorte real das 8 partes piores da amostra (o Opus VÊ o recorte, não só as métricas)
  const worstRows = [...rows].sort((a, b) => b.bad - a.bad).slice(0, 8).sort((a, b) => a.i - b.i);
  const sheet = await cropSheet(projectId, worstRows.map((r) => ({ page: r.page, focus: r.s.focus })));
  const sheetNote = sheet ? `IMAGEM: recortes reais das partes ${worstRows.filter((r) => r.page).map((r) => r.i + 1).join(', ')} (na ordem da lista, da esquerda para a direita e de cima para baixo). Use para confirmar ou descartar o que as métricas sugerem.\n\n` : '';
  const raw = await llm.complete({
    system: SYSTEM,
    images: sheet ? [sheet] : undefined,
    prompt: `Obra: ${p.title} (${p.shots.length} partes)\n\nPlacar atual: ${MANAGED.map((a) => `${AGENT_NAME[a]} ${score.agents[a].score}/100`).join(', ')}\n\nRegras já aprendidas (não repita):\n${rules.map((r) => `- ${r}`).join('\n') || '(nenhuma)'}\n\nHabilidades dos agentes: ${skills.join(' | ')}\n\nPropostas já rejeitadas pelo dono (não repita):\n${rejected.join('\n') || '(nenhuma)'}\n\n${sheetNote}AMOSTRA:\n${lines.join('\n')}`.slice(0, 36000),
    maxTokens: 3000,
    temperature: 0.2,
    tier: 'manager', // o gestor é sempre o Opus
    signal,
  });
  const out = extractJson(raw) as { summary?: string; findings?: Record<string, unknown>[]; proposals?: Record<string, unknown>[] };
  const byId = new Map(rows.map((r) => [r.s.id, r]));
  const okAgent = (a: unknown): a is ManagedAgent => a === 'leitor' || a === 'cortador' || a === 'montador';
  const findings: Finding[] = [];
  const idMap = new Map<string, string[]>();
  for (const f of out.findings ?? []) {
    const r = byId.get(String(f.shot ?? ''));
    if (!r || !okAgent(f.agent) || !String(f.problem ?? '').trim()) continue;
    const id = randomUUID().slice(0, 8);
    findings.push({
      id,
      agent: f.agent,
      severity: f.severity === 'alta' || f.severity === 'baixa' ? f.severity : 'media',
      problem: String(f.problem).trim(),
      suggestion: String(f.suggestion ?? '').trim(),
      part: r.i + 1,
      shotId: r.s.id,
      text: r.s.text.slice(0, 200),
      page: r.page,
      focus: r.s.focus,
      areaPct: r.m ? Math.round(r.m.area * 100) : undefined,
      projectId,
    });
    idMap.set(r.s.id, [...(idMap.get(r.s.id) ?? []), id]);
  }
  const proposals: Proposal[] = [];
  for (const pr of out.proposals ?? []) {
    if (!okAgent(pr.agent) || !String(pr.rule ?? '').trim()) continue;
    const ex = (Array.isArray(pr.shots) ? pr.shots : []).flatMap((s) => idMap.get(String(s)) ?? []);
    proposals.push({ id: randomUUID().slice(0, 8), agent: pr.agent, title: String(pr.title ?? pr.rule).trim().slice(0, 80), rule: String(pr.rule).trim(), why: String(pr.why ?? '').trim(), findingIds: [...new Set(ex)], status: 'pending' });
  }
  const audit: Audit = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), projectId, title: p.title, summary: String(out.summary ?? '').trim(), sampled: rows.length, findings, proposals: proposals.slice(0, 3) };
  const fresh = readManager();
  fresh.audits.push(audit);
  fresh.history.push({ at: audit.at, projectId, title: p.title, shots: p.shots.length, scores: { leitor: score.agents.leitor.score, cortador: score.agents.cortador.score, montador: score.agents.montador.score } });
  writeManager(fresh);
  ctx.log(llm.report());
  return `Auditoria: ${findings.length} achado(s), ${audit.proposals.length} proposta(s) de regra para você aprovar em /gestao`;
}

/** Aprova ou recusa uma proposta. Aprovada = vira habilidade do agente (arquivo .md em _skills). */
export function decideProposal(id: string, approve: boolean): boolean {
  const d = readManager();
  for (const a of d.audits) {
    const pr = a.proposals.find((x) => x.id === id);
    if (!pr) continue;
    pr.status = approve ? 'approved' : 'rejected';
    pr.decidedAt = new Date().toISOString();
    if (approve) addLearnedSkill(pr.agent, `gestao-${pr.id}`, pr.title, `${pr.rule}${pr.why ? `\nPor quê: ${pr.why}` : ''}`);
    writeManager(d);
    return true;
  }
  return false;
}
