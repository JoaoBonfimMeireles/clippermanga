// Shorts: o Diretor de Shorts (lib/shorts-director.ts) planeja os shorts de 20-40 s (até 45) a partir da história:
// corte com a voz original ou narração nova (voz do vídeo longo), em trecho seguido ou em ordem livre. Cada um vira
// um vídeo VERTICAL (9:16) pelo mesmo render do vídeo principal (reaproveita a voz já gerada e o cache de partes)
// e ganha título, resumo, descrição e tags. O plano fica em cache (checkpoint): rodar de novo não gasta IA.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MANGA_SIZES } from '@clipper/shared';
import { extractJson } from '@clipper/editing-planner';
import { createMangaLLM } from './llm';
import { exemplosPrompt } from './exemplos';
import { durationsOf, HARD_MAX_S, MIN_S, partSeconds, planShorts } from './shorts-director';
import { reviewShortVisual } from './visual-review';
import { estimateSpeechSeconds } from './voice';
import { projectDir, readProject, updateProject } from './store';
import { autoFill, cropPx, effSize } from './camera';
import { renderProject } from './render';
import { toVertical as toVerticalPages } from './vertical';
const toVertical = (s: Shot, p: StudioProject, aspect: number) => toVerticalPages(s, p.pages, aspect);
import { runFfmpeg } from '@clipper/video-processing';
import { audioDuration } from './media';
import { renderUpToDate } from './sig';
import type { JobCtx } from './jobs';
import type { PlanItem, Rect, Shot, ShortInfo, ShortPart, StudioProject } from './types';

/** Duração de cada parte: a real do último render; partes novas usam a pedida. */
const durations = durationsOf;
/** Silêncio no fim de cada short do Diretor (s): a última imagem fica parada, sem som; não conta nos 20-40 s. */
const SHORT_END_SILENCE = 2;

/**
 * Diretor de Shorts (lib/shorts-director.ts): planeja os shorts (corte e/ou narração nova) e renderiza.
 * pauseForNarration: se o plano tem narração nova, para aqui e espera a aprovação na tela (nenhuma voz é gasta antes).
 */
export async function generateShorts(projectId: string, ctx: JobCtx, signal: AbortSignal, count = 5, pauseForNarration = false): Promise<string> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  if (!p.shots.length) throw new Error('A linha do tempo está vazia');
  if (!p.lastRender) throw new Error('Renderize o vídeo principal antes de criar os shorts');
  if (!renderUpToDate(p)) throw new Error('O vídeo tem edições que ainda não foram renderizadas: clique em "Renderizar vídeo" e depois crie os shorts (eles usam sempre a versão mais recente)');
  const items = await planShorts(p, ctx, signal, count);
  const narrated = items.filter((i) => i.mode === 'narrated').length;
  if (pauseForNarration && narrated) {
    updateProject(projectId, (cur) => (cur.shortsPlan = { at: new Date().toISOString(), items }));
    return `Plano pronto: ${items.length} short(s), ${narrated} com narração nova. Revise e aprove para gerar a voz`;
  }
  return renderPlan(projectId, items, ctx, signal);
}

/** Aprovou o plano parado: aplica as edições da tela (texto da narração, shorts removidos) e renderiza. */
export async function approveShortsPlan(projectId: string, edited: PlanItem[] | undefined, ctx: JobCtx, signal: AbortSignal): Promise<string> {
  const p = readProject(projectId);
  const plan = p?.shortsPlan;
  if (!p || !plan) throw new Error('Não há plano esperando aprovação');
  const ids = new Set(p.shots.map((s) => s.id));
  const items: PlanItem[] = [];
  for (const it of plan.items) {
    const e = edited?.find((x) => x.id === it.id);
    if (edited && !e) continue; // tirado na tela
    const parts = (e?.parts ?? it.parts).filter((x) => ids.has(x.shot) && (it.mode === 'cut' || x.text?.trim())).map((x): ShortPart => ({ shot: x.shot, ...(it.mode === 'narrated' ? { text: String(x.text).replace(/\s+/g, ' ').trim() } : {}) }));
    if (parts.length) items.push({ ...it, title: e?.title?.trim() || it.title, parts });
  }
  if (!items.length) throw new Error('Todos os shorts do plano foram tirados');
  const out = await renderPlan(projectId, items, ctx, signal);
  updateProject(projectId, (cur) => void delete cur.shortsPlan);
  return out;
}

/** Renderiza os itens do plano: cada um vira um vídeo vertical (corte com a voz original ou narração nova com a voz do vídeo). */
async function renderPlan(projectId: string, items: PlanItem[], ctx: JobCtx, signal: AbortSignal): Promise<string> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  const dur = durations(p);
  const idx = new Map(p.shots.map((s, i) => [s.id, i]));
  const { w, h } = MANGA_SIZES.vertical;
  const outDir = path.join('videos', 'shorts');
  fs.mkdirSync(path.join(projectDir(projectId), outDir), { recursive: true });
  const out: ShortInfo[] = [];
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); // nomes novos a cada vez: não sobrescreve shorts antigos
  for (const [k, it0] of items.entries()) {
    let it = it0;
    const lo = 0.05 + (k / items.length) * 0.95, span = 0.95 / items.length;
    ctx.log(`Short ${k + 1}/${items.length} (${it.mode === 'narrated' ? 'narração nova' : 'corte'}): ${it.title}`);
    const renderParts = async (parts: ShortPart[], tag: string) => {
      const slice = parts.map((pt, j) => {
        const s = p.shots[idx.get(pt.shot)!];
        const v = toVertical(s, p, w / h);
        // narração nova: texto novo, sem os cortes da voz antiga; id próprio para o cache não confundir com o vídeo longo
        return pt.text ? { ...v, id: `${s.id}~${it.id}~${j}`, text: pt.text, audioCuts: undefined, speed: undefined, duration: Math.max(1.2, estimateSpeechSeconds(pt.text)) } : v;
      });
      const variant: StudioProject = { ...p, format: 'vertical', shots: slice, endSilence: SHORT_END_SILENCE };
      const name = `short_${stamp}_${k + 1}_${it.mode}${tag}`;
      return renderProject(projectId, { ...ctx, progress: (x, m) => ctx.progress(lo + x * span, `Short ${k + 1}/${items.length}: ${m ?? ''}`) }, signal, { extra: { project: variant, outDir, name, tail: true } });
    };
    const secsOf = (parts: ShortPart[]) => parts.reduce((a, pt) => a + partSeconds(dur[idx.get(pt.shot)!], pt.text), 0);
    let file = await renderParts(it.parts, '');
    // Gestor (Opus): olha 6 quadros do short pronto (não o vídeo). Se achar partes com recorte/imagem ruim, tira só elas e
    // renderiza de novo uma vez (só em corte, e só se sobrar pelo menos MIN_S segundos); senão o short segue e o aviso vai ao log
    const verdict = await reviewShortVisual({
      video: file,
      contentSeconds: Math.max(2, secsOf(it.parts)),
      title: it.title,
      mode: it.mode,
      narration: it.parts.map((pt) => pt.text ?? p.shots[idx.get(pt.shot)!].text).join(' '),
      partStarts: it.parts.reduce<number[]>((a, pt, i) => (a.push(i ? a[i - 1] + partSeconds(dur[idx.get(it.parts[i - 1].shot)!], it.parts[i - 1].text) : 0), a), []),
      signal,
    });
    if (verdict) {
      ctx.log(`Gestor (Opus) viu os quadros do short ${k + 1}: ${verdict.ok ? 'aprovado' : 'reprovado'} — ${verdict.summary}${verdict.issues.length ? ` (${verdict.issues.join('; ')})` : ''}`);
      if (!verdict.ok && it.mode === 'cut' && verdict.badParts.length) {
        const bad = new Set(verdict.badParts.map((n) => n - 1));
        const kept = it.parts.filter((_, i) => !bad.has(i));
        if (kept.length && kept.length < it.parts.length && secsOf(kept) >= MIN_S - 1) {
          ctx.log(`Gestor mandou refazer o short ${k + 1} sem a(s) parte(s) ${verdict.badParts.join(', ')}`);
          const redo = await renderParts(kept, '_r');
          fs.rmSync(file, { force: true });
          file = redo;
          it = { ...it, parts: kept };
        }
      }
    }
    const at = it.parts.map((pt) => idx.get(pt.shot)!);
    const first = Math.min(...at), last = Math.max(...at);
    const real = Math.round(((await audioDuration(file)) || it.parts.reduce((a, pt) => a + partSeconds(dur[idx.get(pt.shot)!], pt.text), 0) + SHORT_END_SILENCE) * 10) / 10;
    // os 2 s finais de silêncio não entram na conta de 20-45 s (existem só para a última fala não ser cortada)
    if (real - SHORT_END_SILENCE > HARD_MAX_S) ctx.log(`⚠ "${it.title}" ficou com ${Math.round(real - SHORT_END_SILENCE)} s de conteúdo (passou de ${HARD_MAX_S} s)`);
    const contiguous = it.mode === 'cut' && at.every((x, i) => i === 0 || x === at[i - 1] + 1);
    out.push({
      id: randomUUID().slice(0, 8),
      from: first,
      to: last,
      fromId: p.shots[first].id,
      toId: p.shots[last].id,
      ...(contiguous ? {} : { mode: it.mode, parts: it.parts }),
      title: it.title,
      summary: it.summary,
      description: it.description,
      tags: it.tags,
      file: path.relative(projectDir(projectId), file).replace(/\\/g, '/'),
      duration: real,
      at: new Date().toISOString(),
    });
  }
  // os novos entram antes dos que já existiam (apagar é com o ✕ de cada um)
  updateProject(projectId, (cur) => (cur.shorts = [...out, ...(cur.shorts ?? [])]));
  return `${out.length} short(s) pronto(s) em ${outDir.replace(/\\/g, '/')}`;
}

/** Renderiza de novo UM short com o trecho escolhido no modal (de from a to, inclusive). Título e textos ficam. */
export async function renderOneShort(projectId: string, shortId: string, from: number, to: number, ctx: JobCtx, signal: AbortSignal, skipIds: string[] = [], cutsIn: [number, number][] = [], framesIn: Record<string, Rect> = {}): Promise<string> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  if (!renderUpToDate(p)) throw new Error('O vídeo tem edições que ainda não foram renderizadas: clique em "Renderizar vídeo" antes (os shorts usam sempre a versão mais recente)');
  const sh = p.shorts?.find((x) => x.id === shortId);
  if (!sh) throw new Error('Short não encontrado (foi apagado?)');
  const n = p.shots.length - 1;
  from = Math.max(0, Math.min(n, Math.floor(from)));
  to = Math.max(from, Math.min(n, Math.floor(to)));
  const dur = durations(p);
  const skip = new Set(skipIds);
  const keep = Array.from({ length: to - from + 1 }, (_, k) => from + k).filter((i) => !skip.has(p.shots[i].id));
  if (!keep.length) throw new Error('Todas as partes do short foram tiradas');
  const before = keep.reduce((a, i) => a + dur[i], 0);
  // enquadramentos válidos, só das partes do short
  const frames: Record<string, Rect> = {};
  for (const i of keep) {
    const r = framesIn[p.shots[i].id];
    if (r && [r.x0, r.y0, r.x1, r.y1].every((v) => Number.isFinite(v)) && r.x1 - r.x0 > 0.02 && r.y1 - r.y0 > 0.02) frames[p.shots[i].id] = { x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(1, r.x1), y1: Math.min(1, r.y1) };
  }
  const cuts = normCuts(cutsIn, before);
  const total = before - cuts.reduce((a, [x, y]) => a + (y - x), 0);
  if (total < 1) throw new Error('Os cortes apagaram o short inteiro');
  if (total > 180) throw new Error(`O trecho tem ${Math.round(total)} s: o YouTube aceita shorts de até 3 minutos`);
  const { w, h } = MANGA_SIZES.vertical;
  const outDir = path.join('videos', 'shorts');
  const name = `short_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}_${from + 1}-${to + 1}`;
  ctx.log(`Short "${sh.title}": partes ${from + 1}–${to + 1} (${Math.round(total)} s)`);
  const file = await renderProject(projectId, ctx, signal, {
    extra: { project: { ...p, format: 'vertical', shots: keep.map((i) => toVerticalPages(p.shots[i], p.pages, w / h, frames[p.shots[i].id])) }, outDir, name },
  });
  // pedaços cortados em segundos: tira do vídeo e do áudio do short já renderizado
  let finalDur = total;
  if (cuts.length) {
    ctx.progress(0.97, `Cortando ${cuts.length} pedaço(s) do short`);
    const expr = cuts.map(([x, y]) => `between(t,${x.toFixed(3)},${y.toFixed(3)})`).join('+');
    const tmp = file.replace(/\.mp4$/, '_cut.mp4');
    await runFfmpeg(['-y', '-i', file, '-vf', `select='not(${expr})',setpts=N/FRAME_RATE/TB`, '-af', `aselect='not(${expr})',asetpts=N/SR/TB`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp], { signal });
    fs.renameSync(tmp, file);
    finalDur = (await audioDuration(file)) || total;
  }
  const rel = path.relative(projectDir(projectId), file).split(path.sep).join('/');
  let old = '';
  updateProject(projectId, (cur) => {
    const s = cur.shorts?.find((x) => x.id === shortId);
    if (!s) return;
    old = s.file;
    Object.assign(s, { from, to, fromId: p.shots[from].id, toId: p.shots[to].id, skip: [...skip].filter((x) => keep.every((i) => p.shots[i].id !== x)), cuts, frames, file: rel, duration: Math.round(finalDur * 10) / 10, at: new Date().toISOString() });
  });
  if (old && old !== rel) fs.rmSync(path.join(projectDir(projectId), old), { force: true });
  return `Short "${sh.title}" renderizado: ${Math.round(total)} s`;
}

/** Cortes válidos: dentro do short, em ordem, sem sobrepor (juntam quando encostam). */
function normCuts(cuts: [number, number][], len: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [x, y] of cuts
    .map(([a, b]) => [Math.max(0, Math.min(Number(a), Number(b))), Math.min(len, Math.max(Number(a), Number(b)))] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b - a >= 0.1)
    .sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && x <= last[1]) last[1] = Math.max(last[1], y);
    else out.push([x, y]);
  }
  return out;
}

const SYSTEM_CAPTION = `Você escreve a legenda de UM YouTube Short de um canal que narra mangás em português do Brasil.
Recebe a narração do trecho do short. Responda só JSON: {"title": string, "description": string, "tags": string[]}.
- title: até 70 caracteres, termine com #shorts. MUITO chamativo: descubra o GANCHO de interesse do trecho (harém/romance, dinheiro/fortuna/ficar rico, poder/força/influência, guerra/batalhas, vingança, sobrevivência, monstros, etc.) e foque o título NELE, com palavras fortes e MAIÚSCULAS em 1-2 palavras-chave; fiel ao trecho, sem mentir.
- description: 2 a 3 frases curtas em pt-BR sobre ESTE trecho (gancho + convite para ver o vídeo completo no canal) e no fim 3 a 5 hashtags incluindo #shorts.
- tags: 10 a 15 tags curtas sem "#" (obra, personagens do trecho, gênero, "mangá", "shorts", "manhwa" quando couber).`;

/** Gera de novo título, descrição e tags de UM short a partir das falas do trecho escolhido (sem as partes tiradas). */
export async function shortCaption(projectId: string, shortId: string, from: number, to: number, skipIds: string[], signal?: AbortSignal): Promise<{ title: string; description: string; tags: string[] }> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  const sh = p.shorts?.find((x) => x.id === shortId);
  if (!sh) throw new Error('Short não encontrado (foi apagado?)');
  const skip = new Set(skipIds);
  const n = p.shots.length - 1;
  from = Math.max(0, Math.min(n, Math.floor(from)));
  to = Math.max(from, Math.min(n, Math.floor(to)));
  const text = p.shots.slice(from, to + 1).filter((s) => !skip.has(s.id)).map((s) => s.text.trim()).filter(Boolean).join(' ');
  if (!text) throw new Error('O trecho não tem fala para escrever a legenda');
  const llm = createMangaLLM();
  const raw = await llm.complete({ system: SYSTEM_CAPTION, prompt: `${exemplosPrompt()}Obra: ${p.series || p.title}\n\nNarração do trecho:\n${text.slice(0, 6000)}`, maxTokens: 1500, temperature: 0.6, signal });
  const j = extractJson(raw) as { title?: unknown; description?: unknown; tags?: unknown };
  const cap = {
    title: String(j.title ?? '').trim() || sh.title,
    description: String(j.description ?? '').trim() || sh.description,
    tags: (Array.isArray(j.tags) ? j.tags : String(j.tags ?? '').split(',')).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean),
  };
  if (!cap.tags.length) cap.tags = sh.tags;
  updateProject(projectId, (cur) => {
    const s = cur.shorts?.find((x) => x.id === shortId);
    if (s) Object.assign(s, cap);
  });
  return cap;
}
