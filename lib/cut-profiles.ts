// Modo teste e perfis de corte.
// Ao baixar um lote, só os primeiros 1-2 capítulos (o "teste") passam pelo fluxo normal; o resto fica estacionado
// (project.parked). O usuário valida e ajusta os cortes do teste e clica "Teste finalizado": o gestor (Opus) compara o que a
// IA propôs (baseline gravado depois de cada etapa de IA) com o resultado final, escreve REGRAS de corte e de disposição das
// imagens e guarda em projetos/_perfis/:
//   _global.json        regras que valem para qualquer obra (só nascem quando 2+ obras mostram o mesmo padrão)
//   <série>.json        peculiaridades de UMA obra, com tags de estilo para casar com obras parecidas no futuro
// As regras entram no prompt da edição (lib/autoedit.ts) e do ajuste de recortes (lib/restyle.ts). Regras duras (piso de
// tamanho do recorte, duração dos shorts) vêm de outros módulos e sempre vencem: aqui só se aprende o que sobra de margem.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractJson } from '@clipper/editing-planner';
import { jobLLM } from './ai-meter';
import { cropMetrics } from './crop-quality';
import { pendingEdits } from './learning';
import { seriesKey } from './series';
import { addPagesToTimeline, chaptersInOrder } from './timeline';
import { projectDir, readProject, studioDir, updateProject } from './store';
import type { JobCtx } from './jobs';
import type { Shot, StudioPage, StudioProject } from './types';

export type Confidence = 'baixa' | 'media' | 'alta';
export interface CutRule {
  id: string;
  text: string;
  confidence: Confidence;
  /** Quantos testes confirmaram a regra. */
  seen: number;
  /** De onde veio: partes, capítulos e o que o usuário mudou. */
  evidence: string[];
  /** Global: obras que mostraram o mesmo padrão. */
  alsoIn?: string[];
  at: string;
}
export interface CutProfile {
  key: string;
  title: string;
  /** Jeito do mangá (ritmo, densidade de texto, ação, flashback...) para casar com obras parecidas. */
  tags: string[];
  rules: CutRule[];
  tests: { at: string; chapters: string[]; summary: string }[];
  updatedAt: string;
}
export interface GlobalProfile {
  rules: CutRule[];
  updatedAt: string;
}

const dir = () => path.join(studioDir(), '_perfis');
const GLOBAL_KEY = '_global';
const fileOf = (key: string) => path.join(dir(), `${key.replace(/[^a-z0-9_-]/gi, '-')}.json`);

export function readGlobalCuts(): GlobalProfile {
  try {
    return JSON.parse(fs.readFileSync(fileOf(GLOBAL_KEY), 'utf8')) as GlobalProfile;
  } catch {
    return { rules: [], updatedAt: '' };
  }
}
export function writeGlobalCuts(g: GlobalProfile) {
  fs.mkdirSync(dir(), { recursive: true });
  g.updatedAt = new Date().toISOString();
  fs.writeFileSync(fileOf(GLOBAL_KEY), JSON.stringify(g, null, 2), 'utf8');
}
export function readCutProfile(key: string): CutProfile | null {
  try {
    return JSON.parse(fs.readFileSync(fileOf(key), 'utf8')) as CutProfile;
  } catch {
    return null;
  }
}
export function writeCutProfile(p: CutProfile) {
  fs.mkdirSync(dir(), { recursive: true });
  p.updatedAt = new Date().toISOString();
  fs.writeFileSync(fileOf(p.key), JSON.stringify(p, null, 2), 'utf8');
}
export function listCutProfiles(): CutProfile[] {
  try {
    return fs
      .readdirSync(dir())
      .filter((f) => f.endsWith('.json') && f !== `${GLOBAL_KEY}.json`)
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')) as CutProfile)
      .filter((p) => p.key);
  } catch {
    return [];
  }
}
/** Apaga uma regra (a revisão manual das regras aprendidas). */
export function deleteCutRule(profile: string, ruleId: string): boolean {
  if (profile === GLOBAL_KEY) {
    const g = readGlobalCuts();
    const n = g.rules.length;
    g.rules = g.rules.filter((r) => r.id !== ruleId);
    if (g.rules.length === n) return false;
    writeGlobalCuts(g);
    return true;
  }
  const p = readCutProfile(profile);
  if (!p) return false;
  const n = p.rules.length;
  p.rules = p.rules.filter((r) => r.id !== ruleId);
  if (p.rules.length === n) return false;
  writeCutProfile(p);
  return true;
}

// ---------------------------------------------------------------- estado do teste

/** Estaciona os capítulos que não são do teste: saem de pages/shots até o teste terminar. */
export function parkChapters(p: StudioProject, chapters: string[]): void {
  const set = new Set(chapters);
  const out = p.pages.filter((pg) => set.has(pg.chapter));
  if (!out.length) return;
  const ids = new Set(out.map((pg) => pg.id));
  p.pages = p.pages.filter((pg) => !ids.has(pg.id));
  p.shots = p.shots.filter((s) => !ids.has(s.pageId));
  const parked = p.parked ?? [];
  for (const ch of chaptersInOrder(out)) {
    const pages = out.filter((pg) => pg.chapter === ch);
    const cur = parked.find((x) => x.chapter === ch);
    if (cur) cur.pages.push(...pages);
    else parked.push({ chapter: ch, pages });
  }
  p.parked = parked;
}

/**
 * Conserta um teste que estacionou os próprios capítulos do teste (reimportar o lote com o teste ativo): devolve as páginas
 * dos capítulos do teste ao projeto e descarta duplicatas. Retorna true se mudou algo.
 */
export function healTest(p: StudioProject): boolean {
  if (!p.test || !p.parked?.length) return false;
  const mine = new Set(p.test.chapters);
  const back = p.parked.filter((x) => mine.has(x.chapter));
  if (!back.length) return false;
  const have = new Set(p.pages.map((pg) => pg.chapter));
  const restored: StudioPage[] = [];
  for (const x of back) if (!have.has(x.chapter)) restored.push(...x.pages);
  p.parked = p.parked.filter((x) => !mine.has(x.chapter));
  if (!p.parked.length) p.parked = undefined;
  if (restored.length) {
    p.pages.push(...restored);
    addPagesToTimeline(p, restored);
  }
  return true;
}

/** Começa o teste no que acabou de ser importado (`imported` = capítulos novos, em ordem cronológica). */
export function startTest(p: StudioProject, imported: string[], count: number): void {
  const n = Math.max(1, Math.min(2, Math.round(count)));
  const ordered = chaptersInOrder(p.pages.filter((pg) => imported.includes(pg.chapter)));
  const test = ordered.slice(0, n);
  parkChapters(p, ordered.slice(n));
  p.test = { count: n, chapters: test, startedAt: new Date().toISOString() };
}

const baseFile = (id: string) => path.join(projectDir(id), '.progress', 'test-baseline.json');
const logFile = (id: string) => path.join(projectDir(id), '.progress', 'editlog.jsonl');

function lastEditAt(id: string): number {
  try {
    const all = fs.readFileSync(logFile(id), 'utf8');
    const m = [...all.matchAll(/"at":"([^"]+)"/g)].at(-1);
    return m ? Date.parse(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** O que a IA propôs para os capítulos do teste, antes de o usuário mexer: gravado depois de cada etapa de IA (edição, validação...). */
export function snapshotBaseline(projectId: string): void {
  try {
    const p = readProject(projectId);
    if (!p?.test) return;
    // depois que o usuário já corrigiu algo, uma nova etapa de IA não vira "o que a IA propôs" (já levaria as correções dele)
    const prevAt = fs.existsSync(baseFile(projectId)) ? (JSON.parse(fs.readFileSync(baseFile(projectId), 'utf8')) as { at: string }).at : '';
    if (prevAt && lastEditAt(projectId) > Date.parse(prevAt)) return;
    const pages = new Set(p.pages.filter((pg) => p.test!.chapters.includes(pg.chapter)).map((pg) => pg.id));
    const shots = p.shots.filter((s) => pages.has(s.pageId));
    if (!shots.length) return;
    fs.mkdirSync(path.dirname(baseFile(projectId)), { recursive: true });
    fs.writeFileSync(baseFile(projectId), JSON.stringify({ at: new Date().toISOString(), shots }), 'utf8');
  } catch {
    /* baseline é só aprendizado: nunca derruba a etapa */
  }
}

function readBaseline(id: string): Shot[] {
  try {
    return (JSON.parse(fs.readFileSync(baseFile(id), 'utf8')) as { shots: Shot[] }).shots;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- números da disposição das imagens

interface Stats {
  partes: number;
  comFala: number;
  duracaoMedia: number;
  porPagina: number;
  imagemRepetidaEmSeguida: number;
  partesComImagensExtras: number;
  areaMediaPct: number;
  tipos: Record<string, number>;
}
const SCREEN = { w: 1920, h: 1080 };

function stats(shots: Shot[], pages: Map<string, StudioPage>): Stats {
  const tipos: Record<string, number> = {};
  let repeated = 0, extra = 0, dur = 0, area = 0, areaN = 0;
  const per = new Map<string, number>();
  const img = (s: Shot) => `${s.pageId}|${s.focus.x0.toFixed(2)},${s.focus.y0.toFixed(2)}`;
  for (const [i, s] of shots.entries()) {
    tipos[s.kind ?? '?'] = (tipos[s.kind ?? '?'] ?? 0) + 1;
    per.set(s.pageId, (per.get(s.pageId) ?? 0) + 1);
    dur += s.duration || 0;
    if (s.extra?.length) extra++;
    const prev = shots[i - 1];
    if (prev && img(prev) === img(s)) repeated++;
    const pg = pages.get(s.pageId);
    if (pg) {
      try {
        area += cropMetrics(s.focus, pg, s, SCREEN).area;
        areaN++;
      } catch {
        /* sem métrica */
      }
    }
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    partes: shots.length,
    comFala: shots.filter((s) => s.text.trim()).length,
    duracaoMedia: r(dur / Math.max(1, shots.length)),
    porPagina: r(shots.length / Math.max(1, per.size)),
    imagemRepetidaEmSeguida: repeated,
    partesComImagensExtras: extra,
    areaMediaPct: Math.round((area / Math.max(1, areaN)) * 100),
    tipos,
  };
}

// ---------------------------------------------------------------- aprendizado (Opus)

const CUT_FIELDS = new Set(['focus', 'fit', 'rotate', 'stretch', 'zoom', 'bgBand', 'motion', 'pageId', 'extra']);

const SYSTEM = `Você é o GESTOR de uma empresa de edição de vídeos de resumo de mangá. A IA pequena (Haiku) faz os CORTES (qual parte da imagem, o recorte de cada quadro) e a DISPOSIÇÃO das imagens (qual imagem em cada fala, se repete imagem, quantas imagens por fala). O dono do canal validou um TESTE de 1-2 capítulos de uma obra e corrigiu à mão o que não gostou. Você aprende com isso.
Escopo: SÓ cortes e disposição das imagens. Não aprenda sobre texto da narração nem sobre duração.
Você recebe: números da proposta da IA vs. o resultado final do dono, as correções dele (antes → depois), as respostas dele às dúvidas da IA, o perfil atual desta obra, as regras globais e os perfis de obras parecidas.
Responda SOMENTE JSON:
{"summary":"2-3 frases: o que o dono mudou e o que isso ensina",
 "tags":["3 a 8 tags curtas do JEITO deste mangá: ritmo, densidade de texto/balões, ação, flashback, quadros largos/altos, cenas de impacto..."],
 "rules":[{"id":"id de uma regra atual que continua valendo (ou vazio se é nova)","text":"regra curta e acionável para o Cortador/Montador","confidence":"baixa|media|alta","evidence":"onde viu: partes, capítulo, o que o dono mudou"}],
 "global":[{"id":"id de regra global atual (ou vazio)","text":"...","evidence":"...","alsoIn":["título da outra obra que mostra o MESMO padrão"]}]}
Regras:
- "rules" é a lista COMPLETA e atualizada das peculiaridades DESTA obra (máx. 20): mantenha (com o mesmo id) as atuais que continuam valendo, ajuste ou remova as que as correções contradizem. Só peculiaridade do jeito DESTE mangá (ex.: "nas cenas de luta o autor usa quadros largos: recorte o quadro inteiro, sem close"). O que serve a qualquer mangá vai em "global".
- "global": só proponha quando OUTRA obra do perfil já mostra o mesmo padrão ("alsoIn" obrigatório, com o título dela). Sem obras parecidas nos perfis, devolva [].
- Só crie regra com padrão (2+ ocorrências nas correções ou nos números) ou explicação direta do dono (respostas às dúvidas valem mais). Com UM capítulo de teste, use "baixa" e só regras vistas 2+ vezes dentro dele. Ajuste solto, visto uma vez, NÃO vira regra.
- Descubra QUANDO: em que tipo de cena (ação, reação, diálogo, cena nova) o dono repetiu/trocou/apagou imagem, esticou, aproximou ou mudou recorte. Regra sem o "quando" não serve.
- Nunca contradiga as regras duras (recorte ocupa ao menos 30-40% da tela; sem foto borrada; balão quase nunca). Regra que afrouxa isso não pode existir.
- Sem correções do dono: ele aprovou o que a IA fez. Isso confirma as regras atuais (mantenha) e não cria nenhuma.`;

const rid = () => randomUUID().slice(0, 8);
const confOf = (c: unknown, cap: Confidence): Confidence => {
  const order: Confidence[] = ['baixa', 'media', 'alta'];
  const v = order.indexOf(c as Confidence);
  return order[Math.max(0, Math.min(v < 0 ? 0 : v, order.indexOf(cap)))];
};

/** Lê o teste, pede ao Opus as regras e grava os perfis. Não mexe nos capítulos estacionados. */
export async function learnCutProfile(projectId: string, ctx: JobCtx, signal?: AbortSignal): Promise<string> {
  const p = readProject(projectId);
  if (!p?.test) throw new Error('Este projeto não está em modo teste');
  const chapters = p.test.chapters;
  const pageIds = new Set(p.pages.filter((pg) => chapters.includes(pg.chapter)).map((pg) => pg.id));
  const pageMap = new Map(p.pages.map((pg) => [pg.id, pg]));
  const final = p.shots.filter((s) => pageIds.has(s.pageId));
  const base = readBaseline(projectId);
  const key = seriesKey(p);
  const prof: CutProfile = readCutProfile(key) ?? { key, title: p.series?.trim() || p.title, tags: [], rules: [], tests: [], updatedAt: '' };
  const glob = readGlobalCuts();
  const others = listCutProfiles().filter((o) => o.key !== key);

  const ids = new Set([...final.map((s) => s.id), ...base.map((s) => s.id)]);
  const { summary: edits } = pendingEdits(projectId, { fields: CUT_FIELDS, shotIds: ids });
  ctx.progress(0.2, `Gestor: lendo o teste (${chapters.join(', ')}) e ${edits.length} correção(ões) suas`);

  const ruleLines = (rs: CutRule[]) => rs.map((r) => `[${r.id}] (${r.confidence}, visto ${r.seen}x) ${r.text}`).join('\n') || '(nenhuma)';
  const prompt = [
    `Obra: ${prof.title} · capítulos do teste: ${chapters.join(', ')} (${chapters.length} capítulo(s))`,
    `Proposta da IA (antes de você mexer): ${base.length ? JSON.stringify(stats(base, pageMap)) : '(não gravada: use só as correções)'}`,
    `Resultado final: ${JSON.stringify(stats(final, pageMap))}`,
    `Perfil atual desta obra — tags: ${prof.tags.join(', ') || '(nenhuma)'}\nRegras:\n${ruleLines(prof.rules)}`,
    `Regras globais atuais:\n${ruleLines(glob.rules)}`,
    `Perfis de outras obras (para "global" e "alsoIn"):\n${others.map((o) => `## ${o.title} — tags: ${o.tags.join(', ')}\n${ruleLines(o.rules)}`).join('\n') || '(nenhum)'}`,
    `Correções do dono nos cortes e na disposição das imagens (antes → depois):\n${edits.slice(0, 150).join('\n') || '(nenhuma: ele aprovou o que a IA fez)'}`,
  ].join('\n\n');

  const llm = jobLLM(ctx);
  const raw = await llm.complete({ system: SYSTEM, prompt: prompt.slice(0, 40000), maxTokens: 3500, temperature: 0.2, tier: 'manager', signal });
  const out = extractJson(raw) as { summary?: string; tags?: unknown[]; rules?: { id?: string; text?: string; confidence?: string; evidence?: string }[]; global?: { id?: string; text?: string; evidence?: string; alsoIn?: string[] }[] };
  const at = new Date().toISOString();
  // um capítulo só: no máximo "baixa" (amostra pequena); dois: até "media"; "alta" só com 3+ confirmações
  const cap: Confidence = chapters.length >= 2 ? 'media' : 'baixa';

  const prev = new Map(prof.rules.map((r) => [r.id, r]));
  const rules: CutRule[] = [];
  for (const r of out.rules ?? []) {
    const text = String(r.text ?? '').trim();
    if (!text) continue;
    const old = r.id ? prev.get(String(r.id)) : undefined;
    const seen = (old?.seen ?? 0) + 1;
    const ev = String(r.evidence ?? '').trim();
    rules.push({
      id: old?.id ?? rid(),
      text,
      seen,
      confidence: seen >= 3 ? confOf('alta', 'alta') : confOf(r.confidence, seen >= 2 ? 'media' : cap),
      evidence: [...(old?.evidence ?? []), ...(ev ? [`${chapters.join('+')}: ${ev}`] : [])].slice(-6),
      at,
    });
  }
  const tags = [...new Set((out.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  const summary = String(out.summary ?? '').trim();
  // "sem correções" confirma o que já existe: não apaga o perfil se a IA devolveu lista vazia
  prof.rules = (rules.length || edits.length ? rules : prof.rules).slice(0, 20);
  if (tags.length) prof.tags = tags;
  prof.tests = [...prof.tests, { at, chapters, summary }].slice(-10);
  writeCutProfile(prof);

  // regras globais só com a mesma regra confirmada por OUTRA obra que já tem perfil
  let promoted = 0;
  const known = new Set(others.map((o) => o.title.toLowerCase()));
  const gprev = new Map(glob.rules.map((r) => [r.id, r]));
  for (const g of out.global ?? []) {
    const text = String(g.text ?? '').trim();
    const also = (g.alsoIn ?? []).map(String).filter((t) => known.has(t.toLowerCase()));
    if (!text || !also.length) continue;
    const old = g.id ? gprev.get(String(g.id)) : undefined;
    const ev = String(g.evidence ?? '').trim();
    const next: CutRule = { id: old?.id ?? rid(), text, seen: (old?.seen ?? 0) + 1, confidence: 'media', evidence: [...(old?.evidence ?? []), ...(ev ? [`${prof.title}: ${ev}`] : [])].slice(-6), alsoIn: [...new Set([...(old?.alsoIn ?? []), ...also, prof.title])], at };
    glob.rules = old ? glob.rules.map((r) => (r.id === old.id ? next : r)) : [...glob.rules, next];
    promoted++;
  }
  if (promoted) writeGlobalCuts({ ...glob, rules: glob.rules.slice(-25) });

  ctx.log(llm.report());
  const learned = `${prof.rules.length} regra(s) de ${prof.title}${prof.tags.length ? ` (${prof.tags.join(', ')})` : ''}${promoted ? ` · ${promoted} global(is)` : ''}`;
  updateProject(projectId, (cur) => {
    cur.testSummary = `${summary || 'Sem correções: o que a IA propôs foi aprovado.'}\n${prof.rules.map((r) => `• ${r.confidence === 'baixa' ? '[hipótese] ' : ''}${r.text}`).join('\n')}`.trim();
  });
  return learned;
}

/** Fecha o teste: os capítulos estacionados entram no projeto e o teste vira capítulo pronto (a história continua dele). */
export function finishTest(projectId: string): { released: number; locked: boolean } {
  let released = 0;
  let locked = false;
  updateProject(projectId, (cur) => {
    const test = cur.test;
    const pages: StudioPage[] = (cur.parked ?? []).flatMap((x) => x.pages);
    if (pages.length) {
      // o teste que já tem partes com fala fica protegido: roteiro, edição e validação só mexem nos capítulos que entram agora
      const testPages = cur.pages.filter((pg) => test?.chapters.includes(pg.chapter)).map((pg) => pg.id);
      const done = new Set(cur.shots.filter((s) => s.text.trim()).map((s) => s.pageId));
      const keep = testPages.filter((id) => done.has(id));
      if (keep.length) {
        cur.lockedPages = [...new Set([...(cur.lockedPages ?? []), ...keep])];
        locked = true;
      }
      cur.pages.push(...pages);
      addPagesToTimeline(cur, pages);
      released = new Set(pages.map((x) => x.chapter)).size;
    }
    cur.parked = undefined;
    cur.test = undefined;
  });
  try {
    fs.rmSync(baseFile(projectId), { force: true });
  } catch {
    /* sem baseline */
  }
  return { released, locked };
}

// ---------------------------------------------------------------- uso no prompt

const norm = (tags: string[]) => new Set(tags.map((t) => t.toLowerCase()));
/** Obras parecidas: 2+ tags em comum e metade das tags da menor. */
function similar(a: CutProfile, all: CutProfile[]): CutProfile[] {
  const A = norm(a.tags);
  return all
    .filter((o) => o.key !== a.key)
    .map((o) => {
      const B = norm(o.tags);
      const shared = [...A].filter((t) => B.has(t)).length;
      return { o, shared, score: shared / Math.max(1, Math.min(A.size, B.size)) };
    })
    .filter((x) => x.shared >= 2 && x.score >= 0.5)
    .sort((x, y) => y.score - x.score)
    .slice(0, 2)
    .map((x) => x.o);
}

const line = (r: CutRule) => `- ${r.confidence === 'baixa' ? '(hipótese, aplique com cuidado) ' : ''}${r.text}`;

/** Bloco do prompt da edição: regras globais de corte + peculiaridades desta obra + sugestões de obras parecidas. */
export function cutsPrompt(p: Pick<StudioProject, 'title' | 'series'>, max = 3500): string {
  const g = readGlobalCuts().rules;
  const prof = readCutProfile(seriesKey(p));
  const kin = prof ? similar(prof, listCutProfiles()) : [];
  const inherited = kin.flatMap((o) => o.rules.filter((r) => r.confidence !== 'baixa').slice(0, 5).map((r) => ({ r, from: o.title }))).slice(0, 8);
  if (!g.length && !prof?.rules.length && !inherited.length) return '';
  const parts = [
    g.length ? `REGRAS DE CORTE E DISPOSIÇÃO (valem para todas as obras; aprendidas nos testes do dono):\n${g.map(line).join('\n')}` : '',
    prof?.rules.length ? `PECULIARIDADES DESTA OBRA (${prof.title}; aprendidas no teste dos primeiros capítulos):\n${prof.rules.map(line).join('\n')}` : '',
    inherited.length ? `OBRAS PARECIDAS (sugestão, vale se combinar com o que você vê nas páginas):\n${inherited.map((x) => `- (${x.from}) ${x.r.text}`).join('\n')}` : '',
  ].filter(Boolean);
  return `${parts.join('\n')}\nEssas regras NÃO afrouxam as regras duras de tamanho/qualidade do recorte.\n`.slice(0, max);
}
