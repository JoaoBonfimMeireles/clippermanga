// Aprendizado com as edições do usuário: cada mudança feita no editor (recorte, zoom, esticar, duração, velocidade,
// cortes, partes apagadas/movidas, texto) vai para um log por projeto. Depois de cada render, a IA lê o que mudou,
// transforma em REGRAS para os próximos vídeos e, quando não entende o porquê de uma mudança, PERGUNTA ao usuário.
// As regras e as respostas entram no prompt da edição com IA (lib/autoedit.ts).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractJson } from '@clipper/editing-planner';
import { jobLLM } from './ai-meter';
import { avoidPrompt } from './exemplos';
import { beforeAfterSheets, type BeforeAfter } from './visual-review';
import { projectDir, readProject, studioDir } from './store';
import type { JobCtx } from './jobs';
import type { Doubt, Rect, Shot } from './types';
import { readJsonRetry, writeJsonAtomic } from './json-file';

export interface LearnQuestion {
  id: string;
  projectId: string;
  title: string;
  part: number;
  question: string;
  answer?: string;
  at: string;
}
export interface Learning {
  rules: string[];
  questions: LearnQuestion[];
  updatedAt: string;
}

const FIELDS = ['focus', 'fit', 'motion', 'rotate', 'stretch', 'zoom', 'bgBand', 'duration', 'speed', 'audioCuts', 'text', 'pageId', 'extra'] as const;
type LogEntry = { at: string; kind: 'change' | 'remove' | 'add' | 'move' | 'doubt'; note?: string; id: string; part: number; from?: number; changes?: Record<string, [unknown, unknown]>; text?: string; shotKind?: string; impact?: number };

const learnFile = () => path.join(studioDir(), '_aprendizado.json');
const logFile = (id: string) => path.join(projectDir(id), '.progress', 'editlog.jsonl');
const markFile = (id: string) => path.join(projectDir(id), '.progress', 'editlog.learned');

export function readLearning(): Learning {
  try {
    return readJsonRetry<Learning>(learnFile());
  } catch {
    return { rules: [], questions: [], updatedAt: '' };
  }
}
export function writeLearning(l: Learning) {
  l.updatedAt = new Date().toISOString();
  writeJsonAtomic(learnFile(), l);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Um salvamento que muda dezenas de partes no MESMO instante não é correção feita à mão (ninguém ajusta 30 recortes em
 * 0,7 s): é o app (validação, piso de tamanho, tela desatualizada gravando por cima, linha do tempo recriada). Esses
 * lotes não contam como gosto do usuário nem no aprendizado nem no placar do gestor. As respostas às dúvidas ("doubt")
 * ficam de fora da conta: são escolhas dele, anotadas à parte.
 */
export const BULK_SAVE = 30;
export function bulkSaves(entries: { at?: string; kind: string }[]): Set<string> {
  const n = new Map<string, number>();
  for (const e of entries) if (e.at && (e.kind === 'change' || e.kind === 'add' || e.kind === 'remove')) n.set(e.at, (n.get(e.at) ?? 0) + 1);
  return new Set([...n].filter(([, c]) => c >= BULK_SAVE).map(([at]) => at));
}

/** Chamado ao salvar a linha do tempo: anota o que o usuário mudou em relação ao que estava salvo. */
export function logEdits(projectId: string, before: Shot[], after: Shot[]) {
  const out: LogEntry[] = [];
  const at = new Date().toISOString();
  const old = new Map(before.map((s, i) => [s.id, { s, i }]));
  const now = new Set(after.map((s) => s.id));
  for (const [i, s] of after.entries()) {
    const o = old.get(s.id);
    const base = { at, id: s.id, part: i + 1, text: s.text.slice(0, 160), shotKind: s.kind, impact: s.impact };
    if (!o) {
      out.push({ ...base, kind: 'add' });
      continue;
    }
    const changes: Record<string, [unknown, unknown]> = {};
    for (const k of FIELDS) if (!same(o.s[k], s[k])) changes[k] = [o.s[k], s[k]];
    if (Object.keys(changes).length) {
      // o que o usuário FEZ em termos de cena: reaproveitou a imagem da fala vizinha (o recorte sozinho não diz isso à IA)
      const notes: string[] = [];
      if (changes.focus || changes.pageId) {
        const sp = (x: Shot) => !!x.text.trim();
        const img = (x?: Shot) => (x ? `${x.pageId}|${JSON.stringify(x.focus)}` : '');
        const near = (arr: Shot[], i0: number, dir: -1 | 1) => {
          for (let j = i0 + dir; j >= 0 && j < arr.length; j += dir) if (sp(arr[j])) return { sh: arr[j], n: j + 1 };
          return null;
        };
        const oi = before.findIndex((x) => x.id === s.id);
        for (const [dir, nome] of [[-1, 'anterior'], [1, 'posterior']] as const) {
          const nowN = near(after, i, dir), wasN = oi >= 0 ? near(before, oi, dir) : null;
          if (nowN && img(nowN.sh) === img(s) && !(wasN && img(wasN.sh) === img(o.s))) notes.push(`passou a usar a MESMA imagem da fala ${nome} (parte ${nowN.n}): o usuário reaproveitou a cena vizinha em vez de um recorte próprio`);
        }
      }
      out.push({ ...base, kind: 'change', changes, ...(notes.length ? { note: notes.join('; ') } : {}) });
    }
  }
  for (const { s, i } of old.values()) if (!now.has(s.id)) out.push({ at, kind: 'remove', id: s.id, part: i + 1, text: s.text.slice(0, 160), shotKind: s.kind, impact: s.impact });
  if (!out.length) return;
  fs.mkdirSync(path.dirname(logFile(projectId)), { recursive: true });
  fs.appendFileSync(logFile(projectId), out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

/** Ao clicar em "Seguir" no modal: guarda cada resposta com a pergunta, o que foi escolhido e o que foi rejeitado. */
export function logDoubtAnswers(projectId: string, answers: (Doubt & { manual?: boolean })[]) {
  const at = new Date().toISOString();
  const out: LogEntry[] = [];
  for (const d of answers) {
    const o = d.chosen !== undefined ? d.options[d.chosen] : undefined;
    if (!o && !d.manual) continue; // sem resposta: não diz nada sobre o gosto do usuário
    const others = d.options.filter((x) => x !== o).map((x) => `"${x.label}"`).join(', ');
    const note = o
      ? `DÚVIDA DA IA "${d.question}": o usuário escolheu "${o.label}"${others ? `, rejeitou ${others}` : ''} (${d.chosen === 0 ? 'o palpite da IA estava certo' : `o palpite da IA, "${d.options[0].label}", estava errado`})${d.nextToo ? '; e abriu a cena SEGUINTE para ajustar à mão (a imagem reaproveitada vale para as duas partes): a cena que a IA escolheu para esta fala não estava boa e a imagem da próxima serviu' : ''}${d.prevToo ? '; e abriu a cena ANTERIOR para ajustar à mão (a imagem repetida vale para as duas partes): a cena que a IA escolheu para abrir o trecho não estava boa' : ''}`
      : `DÚVIDA DA IA "${d.question}": nenhuma opção serviu (${others}); o usuário ajustou o recorte à mão`;
    out.push({ at, kind: 'doubt', id: d.shotId, part: d.part, text: d.text.slice(0, 160), note });
  }
  if (!out.length) return;
  fs.mkdirSync(path.dirname(logFile(projectId)), { recursive: true });
  fs.appendFileSync(logFile(projectId), out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

/** Edições ainda não analisadas, juntadas por parte (primeiro valor → último valor). */
export function pendingEdits(projectId: string, only?: { fields?: ReadonlySet<string>; shotIds?: ReadonlySet<string>; ignoreMark?: boolean }): { summary: string[]; size: number } {
  let all = '';
  try {
    all = fs.readFileSync(logFile(projectId), 'utf8');
  } catch {
    return { summary: [], size: 0 };
  }
  const from = only?.ignoreMark ? 0 : Number(fs.existsSync(markFile(projectId)) ? fs.readFileSync(markFile(projectId), 'utf8') : 0) || 0;
  const lines = all.slice(from).split('\n').filter(Boolean);
  // dezenas de partes mudadas no MESMO instante são do app (validação, encaixe, salvar tudo de uma vez), não correção do usuário
  const bulk = bulkSaves(lines.map((l) => ({ at: /"at":"([^"]+)"/.exec(l)?.[1], kind: /"kind":"(\w+)"/.exec(l)?.[1] ?? '' })));
  const by = new Map<string, { e: LogEntry; changes: Record<string, [unknown, unknown]>; kinds: Set<string>; notes: string[] }>();
  for (const l of lines) {
    let e: LogEntry;
    try {
      e = JSON.parse(l) as LogEntry;
    } catch {
      continue;
    }
    if (bulk.has(e.at) && (e.kind === 'change' || e.kind === 'add' || e.kind === 'remove')) continue;
    if (only?.shotIds && !only.shotIds.has(e.id)) continue;
    // só os campos pedidos (ex.: modo teste olha cortes e disposição das imagens, não duração nem texto)
    if (only?.fields && e.changes) {
      e = { ...e, changes: Object.fromEntries(Object.entries(e.changes).filter(([k]) => only.fields!.has(k))) };
      if (!Object.keys(e.changes!).length && !e.note) continue;
    }
    const cur = by.get(e.id) ?? { e, changes: {}, kinds: new Set<string>(), notes: [] };
    cur.kinds.add(e.kind);
    if (e.note) cur.notes.push(e.note);
    cur.e = { ...e, part: e.part };
    for (const [k, [a, b]] of Object.entries(e.changes ?? {})) cur.changes[k] = [k in cur.changes ? cur.changes[k][0] : a, b];
    by.set(e.id, cur);
  }
  const fmt = (v: unknown) => {
    if (v && typeof v === 'object' && 'x0' in (v as object)) {
      const r = v as { x0: number; y0: number; x1: number; y1: number };
      return `recorte x ${r.x0.toFixed(2)}–${r.x1.toFixed(2)}, y ${r.y0.toFixed(2)}–${r.y1.toFixed(2)} (${Math.round((r.x1 - r.x0) * 100)}%×${Math.round((r.y1 - r.y0) * 100)}% da página)`;
    }
    return JSON.stringify(v ?? 'padrão').slice(0, 120);
  };
  // o gesto em palavras (os números sozinhos viravam regra com coordenada, que nenhuma IA consegue aplicar)
  const gesture = (a: unknown, b: unknown) => {
    const ok = (v: unknown): v is { x0: number; y0: number; x1: number; y1: number } => !!v && typeof v === 'object' && 'x0' in (v as object);
    if (!ok(a) || !ok(b)) return '';
    const ar = (r: { x0: number; y0: number; x1: number; y1: number }) => Math.max(1e-6, (r.x1 - r.x0) * (r.y1 - r.y0));
    const k = ar(b) / ar(a);
    const how = [b.x1 - b.x0 > (a.x1 - a.x0) * 1.1 ? 'mais largo' : '', b.y1 - b.y0 > (a.y1 - a.y0) * 1.1 ? 'mais alto' : '', b.y1 - b.y0 < (a.y1 - a.y0) * 0.9 ? 'mais baixo' : ''].filter(Boolean).join(', ');
    return k >= 1.2 ? ` [ABRIU o recorte: ${k.toFixed(1)}x a área${how ? `, ${how}` : ''}]` : k <= 0.8 ? ` [FECHOU o recorte: ${k.toFixed(1)}x a área${how ? `, ${how}` : ''}]` : ' [só moveu/ajustou a borda]';
  };
  const summary = [...by.values()].map(({ e, changes, kinds, notes }) => {
    const head = `Parte ${e.part}${e.shotKind ? ` (${e.shotKind}${e.impact ? `, impacto ${e.impact}` : ''})` : ''} "${e.text ?? ''}"`;
    if (kinds.has('remove')) return `${head}: APAGADA pelo usuário`;
    if (kinds.has('add')) return `${head}: parte NOVA criada pelo usuário`;
    const ch = Object.entries(changes)
      .filter(([, [a, b]]) => !same(a, b))
      .map(([k, [a, b]]) => (k === 'extra' ? `imagens durante a fala: ${((a as unknown[] | undefined)?.length ?? 0) + 1} → ${((b as unknown[] | undefined)?.length ?? 0) + 1}` : `${k}: ${fmt(a)} → ${fmt(b)}${k === 'focus' ? gesture(a, b) : ''}`));
    const all2 = [...notes, ...ch];
    return all2.length ? `${head}: ${all2.join('; ')}` : '';
  }).filter(Boolean);
  return { summary, size: all.length };
}

/** Recortes que o usuário mudou (primeiro valor → último), os de mudança maior primeiro: material para o Opus COMPARAR imagens. */
export function pendingFocusPairs(projectId: string, max = 12): { shotId: string; part: number; text: string; before: Rect; after: Rect }[] {
  let all = '';
  try {
    all = fs.readFileSync(logFile(projectId), 'utf8');
  } catch {
    return [];
  }
  const from = Number(fs.existsSync(markFile(projectId)) ? fs.readFileSync(markFile(projectId), 'utf8') : 0) || 0;
  const lines = all.slice(from).split('\n').filter(Boolean);
  const bulk = bulkSaves(lines.map((l) => ({ at: /"at":"([^"]+)"/.exec(l)?.[1], kind: /"kind":"(\w+)"/.exec(l)?.[1] ?? '' })));
  const by = new Map<string, { part: number; text: string; before: Rect; after: Rect }>();
  const isRect = (v: unknown): v is Rect => !!v && typeof v === 'object' && 'x0' in (v as object) && 'y1' in (v as object);
  for (const l of lines) {
    let e: LogEntry;
    try {
      e = JSON.parse(l) as LogEntry;
    } catch {
      continue;
    }
    if (e.kind !== 'change' || bulk.has(e.at) || !e.changes?.focus) continue;
    const [a, b] = e.changes.focus;
    if (!isRect(a) || !isRect(b)) continue;
    const cur = by.get(e.id);
    by.set(e.id, { part: e.part, text: e.text ?? '', before: cur?.before ?? a, after: b });
  }
  const area = (r: Rect) => Math.max(1e-6, (r.x1 - r.x0) * (r.y1 - r.y0));
  const score = (p: { before: Rect; after: Rect }) => Math.abs(Math.log(area(p.after) / area(p.before))) + Math.abs((p.after.y0 + p.after.y1) / 2 - (p.before.y0 + p.before.y1) / 2) * 4;
  return [...by].map(([shotId, v]) => ({ shotId, ...v })).filter((p) => score(p) > 0.15).sort((x, y) => score(y) - score(x)).slice(0, max);
}

const SYSTEM = `Você aprende o gosto de um editor de vídeos de resumo de mangá no YouTube. A IA dele faz a edição automática
(recorte de cada quadro da página, encaixe, zoom, esticar, movimento de câmera, duração, velocidade, texto narrado) e
o usuário corrige no editor. Você recebe as correções que ele fez e as regras que já aprendeu.
Responda SOMENTE JSON: {"rules": ["regra 1", ...], "questions": [{"part": 12, "question": "..."}]}
COMPARAÇÃO DE IMAGENS: às vezes vêm folhas de imagem. Cada linha da folha tem 3 quadros, da esquerda para a direita: (1) a página em volta, com o recorte que a IA fez em VERMELHO e o do usuário em VERDE; (2) o que o recorte da IA mostrava (borda vermelha); (3) o que o recorte do usuário mostra (borda verde). COMPARE os dois: o que a IA deixou de fora e o usuário incluiu (cabeça, corpo inteiro, outro personagem, balão, cenário) e o que o usuário tirou (balão, sarjeta, outro quadro). A causa visual é o que vira regra (ex.: "sempre incluir a cabeça inteira", "tirar o balão da borda"), sempre sem coordenadas. Use as imagens para entender o porquê em vez de perguntar; só pergunte se mesmo vendo ainda não dá para saber.
QUEM USA AS REGRAS (escreva para quem pode cumprir):
- A IA que monta o vídeo NÃO vê as imagens e não mexe em tamanho: ela só escolhe QUAL quadro vai em cada fala, quando REPETIR
  a imagem da fala vizinha e quando JUNTAR quadros vizinhos numa cena geral. A maioria das regras é para ela: diga QUANDO
  (tipo de cena ou de fala) fazer cada coisa.
- A IA que lê as páginas VÊ a imagem e desenha a caixa de cada quadro (a caixa vira o recorte). Para ela, comece a regra
  com "GEOMETRIA:" (no máximo 6): quanto do quadro a caixa pega, largura, altura, quando dividir, o que deixar de fora.
- O app força sozinho: recorte cobrindo a altura da tela, piso de 30-40% da largura, zoom 1, esticar só para cumprir o piso,
  balão aparado das bordas. NÃO escreva regra sobre zoom, stretch, rotate, fit ou bgBand, nem regra que contrarie isso.
- "rules": a lista COMPLETA e atualizada (máx. 24), em português, uma ideia por regra, até 45 palavras cada, sem coordenadas
  nem porcentagens de página (ninguém consegue aplicar "x 0.05–0.95") e sem citar partes ou cenas de uma obra específica.
  Junte regras parecidas, mantenha as antigas que continuam valendo, remova as que as correções contradizem, e use as respostas do usuário.
  Só crie regra quando houver padrão (3+ mudanças parecidas) ou explicação do usuário.
  Linhas com "passou a usar a MESMA imagem da fala anterior/posterior" mostram que o usuário reaproveita a cena vizinha: descubra QUANDO (fala de transição, mesmo assunto, reação, falas curtas, cena que se estende) e escreva a regra.
  Linhas com "imagens durante a fala: 1 → 2" mostram que ele colocou mais de uma imagem na mesma fala: descubra o padrão.
  Linhas com "DÚVIDA DA IA" são respostas diretas do usuário: valem mais que um ajuste solto. Procure o padrão de quando o palpite errou.
- "questions": no máximo 3 perguntas curtas e diretas sobre mudanças que você NÃO entendeu o motivo (cite a parte),
  ex.: "Na parte 14 você apagou a cena do ataque; foi por estar repetida ou por ser fraca?". Sem perguntas se tudo é claro.`;

/** Depois do render: lê as edições novas, atualiza as regras e cria perguntas. Nunca derruba o render. */
export async function learnFromEdits(projectId: string, ctx: JobCtx, signal?: AbortSignal): Promise<void> {
  const p = readProject(projectId);
  if (!p) return;
  const { summary, size } = pendingEdits(projectId);
  if (!summary.length) return;
  ctx.log(`Aprendendo com ${summary.length} parte(s) que você editou`);
  const l = readLearning();
  const answered = l.questions.filter((q) => q.answer).slice(-20).map((q) => `P (${q.title}, parte ${q.part}): ${q.question}\nR: ${q.answer}`);
  const llm = jobLLM(ctx);
  // em blocos: nenhuma correção fica de fora, e as regras de um bloco seguem para o próximo
  let rules = l.rules;
  const asked: { part?: number; question?: string }[] = [];
  // antes → depois em IMAGEM: o Opus compara o recorte da IA com o seu e entende o porquê (até 12 pares, o de maior mudança primeiro)
  let images: Awaited<ReturnType<typeof beforeAfterSheets>> = [];
  let imageNote = '';
  try {
    const pairs = pendingFocusPairs(projectId);
    const shotById = new Map(p.shots.map((x) => [x.id, x]));
    const pageById = new Map(p.pages.map((x) => [x.id, x]));
    const rows: (BeforeAfter & { part: number })[] = [];
    for (const pr of pairs) {
      const pg = pageById.get(shotById.get(pr.shotId)?.pageId ?? '');
      if (pg) rows.push({ page: pg, before: pr.before, after: pr.after, part: pr.part });
    }
    images = await beforeAfterSheets(projectId, rows);
    if (images.length) {
      imageNote = `\n\nFOLHAS DE IMAGEM (comparação antes → depois): ${images.length} folha(s), 4 linhas por folha, na ordem das partes ${rows.map((r) => r.part).join(', ')}.\n`;
      ctx.log(`Aprendizado: ${rows.length} recorte(s) seu(s) comparados em imagem (IA em vermelho, você em verde)`);
    }
  } catch (e) {
    ctx.log(`Comparação em imagem pulada (${(e as Error).message.slice(0, 100)})`);
  }
  for (let i = 0; i < summary.length; i += 120) {
    const raw = await llm.complete({
      system: SYSTEM,
      images: i === 0 && images.length ? images : undefined,
      prompt: `Obra: ${p.title}\n\nRegras atuais:\n${rules.map((r, n) => `${n + 1}. ${r}`).join('\n') || '(nenhuma)'}\n\nRespostas do usuário a perguntas anteriores:\n${answered.join('\n') || '(nenhuma)'}\n\nCorreções feitas agora (antes → depois):\n${summary.slice(i, i + 120).join('\n')}${i === 0 ? imageNote : ''}`.slice(0, 40000),
      maxTokens: 2500,
      temperature: 0.2,
      tier: 'manager', // gestão: Opus
      signal,
    });
    const out = extractJson(raw) as { rules?: unknown[]; questions?: { part?: number; question?: string }[] };
    if (Array.isArray(out.rules) && out.rules.length) rules = out.rules.map((r) => String(r).trim()).filter(Boolean).slice(0, 30);
    asked.push(...(out.questions ?? []));
  }
  const fresh = readLearning();
  fresh.rules = rules;
  const qs = asked.filter((q) => q.question?.trim()).slice(0, 3);
  fresh.questions.push(...qs.map((q) => ({ id: randomUUID().slice(0, 8), projectId, title: p.title, part: Number(q.part) || 0, question: String(q.question).trim(), at: new Date().toISOString() })));
  fresh.questions = fresh.questions.slice(-100);
  writeLearning(fresh);
  fs.writeFileSync(markFile(projectId), String(size));
  ctx.log(`Aprendizado: ${fresh.rules.length} regra(s)${qs.length ? ` · ${qs.length} pergunta(s) para você no editor (painel Aprendizado)` : ''}`);
}

/**
 * Regra de enquadramento (para quem desenha a caixa): só as marcadas "GEOMETRIA:". As regras antigas, sem a marca, trazem
 * coordenadas e porcentagens da página inteira ("~5–12% da tira"), que confundiriam o Leitor (ele vê fatias da página); o
 * essencial delas já está nas habilidades fixas do Leitor. A marca aparece na próxima rodada do aprendizado.
 */
const isFraming = (r: string) => /^GEOMETRIA:/i.test(r);

/** Bloco para o prompt do LEITOR: só o que o usuário ensinou sobre enquadramento (as correções dele quase sempre abrem o recorte). */
export function framingPrompt(max = 1600): string {
  const rules = readLearning().rules.filter(isFraming).map((r) => r.replace(/^GEOMETRIA:\s*/i, ''));
  if (!rules.length) return '';
  const out: string[] = [];
  let size = 0;
  for (const r of rules) {
    if (size + r.length > max) break;
    out.push(`- ${r}`);
    size += r.length;
  }
  return out.length ? `\n\nENQUADRAMENTO QUE O DONO DO CANAL PREFERE (aprendido das correções dele; vale para as caixas "box"):\n${out.join('\n')}\n` : '';
}

/** Bloco para o prompt da edição com IA: regras aprendidas + explicações do usuário. */
export function learningPrompt(max = 2500): string {
  const l = readLearning();
  const qa = l.questions.filter((q) => q.answer).slice(-10).map((q) => `- ${q.question} → ${q.answer}`);
  const avoid = avoidPrompt(3000);
  if (!l.rules.length && !qa.length) return avoid;
  return `PREFERÊNCIAS DO USUÁRIO (aprendidas das correções dele; siga sempre):\n${l.rules.map((r) => `- ${r}`).join('\n')}${qa.length ? `\nExplicações dele:\n${qa.join('\n')}` : ''}\n`.slice(0, max);
}
