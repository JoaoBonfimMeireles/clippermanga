// Áudio em inglês (opcional, depois do vídeo em português): a IA de texto traduz a narração de cada parte do português
// para inglês e o mesmo render de voz (lib/render.ts, modo "extra") gera um segundo MP4 com a fala em inglês, sem mexer
// no vídeo principal (lastRender). Mesma linha do tempo, mesmos recortes e mesma voz (as vozes do catálogo são multilíngues).
import path from 'node:path';
import { extractJson } from '@clipper/editing-planner';
import { createMangaLLM } from './llm';
import { loadCheckpoint, saveCheckpoint } from './checkpoint';
import { audioDuration } from './media';
import { renderProject } from './render';
import { projectDir, readProject, updateProject } from './store';
import { stripWords } from './wordcut';
import type { JobCtx } from './jobs';

const BATCH = 25;
const VERSION = 'en1';
const key = (t: string) => `${t.length}:${t.slice(0, 40)}:${t.slice(-20)}`;

/** Traduz a narração (por parte) para inglês. Reaproveita lotes já traduzidos (checkpoint em disco). */
async function translateEn(projectId: string, ctx: JobCtx, signal: AbortSignal): Promise<Record<string, string>> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  const cut = p.cutWords ?? [];
  const parts = p.shots
    .map((s) => ({ id: s.id, text: (cut.length ? stripWords(s.text, cut) : s.text).trim() }))
    .filter((x) => x.text);
  if (!parts.length) throw new Error('Nenhuma parte tem narração para traduzir');
  const llm = createMangaLLM({ paidGate: ctx.paid });
  llm.onNotice = ctx.log;
  const done = loadCheckpoint<string>(projectId, 'audio-en', VERSION);
  const out: Record<string, string> = {};
  for (let i = 0; i < parts.length; i += BATCH) {
    if (signal.aborted) throw signal.reason;
    const batch = parts.slice(i, i + BATCH);
    ctx.progress((i / parts.length) * 0.1, `Traduzindo a narração para inglês (${i + 1}-${i + batch.length} de ${parts.length})`);
    const missing = batch.filter((b) => !done.has(key(b.text)));
    if (missing.length) {
      const raw = await llm.complete({
        system:
          'Você traduz a narração de um vídeo de resumo de mangá do português do Brasil para o inglês, pronta para ser LIDA EM VOZ ALTA por um narrador: natural, fluente, animada, com o mesmo tom e ritmo (frases curtas continuam curtas). Mantenha nomes de personagens e lugares como estão. Não use emojis, marcações nem aspas extras. Responda só JSON: {"texts": string[]} com o MESMO número de itens, na mesma ordem.',
        prompt: JSON.stringify({ context: p.context?.slice(0, 600) ?? '', texts: missing.map((m) => m.text) }),
        maxTokens: 4000,
        temperature: 0.3,
        signal,
      });
      const texts = ((extractJson(raw) as { texts?: unknown[] }).texts ?? []).map((t) => String(t ?? '').trim());
      if (texts.length !== missing.length || texts.some((t) => !t)) throw new Error(`A IA devolveu ${texts.length} traduções para ${missing.length} textos; rode de novo`);
      missing.forEach((m, k) => {
        done.set(key(m.text), texts[k]);
        saveCheckpoint(projectId, 'audio-en', VERSION, key(m.text), texts[k]);
      });
    }
    for (const b of batch) out[b.id] = done.get(key(b.text))!;
  }
  return out;
}

/** Traduz o roteiro e renderiza a versão com voz em inglês (arquivo à parte em videos/; o vídeo em português não muda). */
/** Só traduz (sem renderizar): guarda o texto em inglês no projeto para baixar roteiro e legenda. */
export async function translateOnly(projectId: string, ctx: JobCtx, signal: AbortSignal): Promise<string> {
  const texts = await translateEn(projectId, ctx, signal);
  updateProject(projectId, (cur) => {
    cur.englishTexts = texts;
  });
  return `Texto em inglês pronto (${Object.keys(texts).length} partes)`;
}

export async function renderEnglish(projectId: string, ctx: JobCtx, signal: AbortSignal): Promise<string> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  if (!p.lastRender) throw new Error('Renderize o vídeo em português antes: o inglês vem depois dele');
  const texts = await translateEn(projectId, ctx, signal);
  // cópia do projeto com a fala em inglês: sem cortes de palavras/áudio (os tempos eram do áudio em português) e sempre voz de IA
  const en = {
    ...structuredClone(p),
    narration: 'voice' as const,
    cutWords: [] as string[],
    shots: p.shots.map((s) => ({ ...s, text: texts[s.id] ?? '', audioCuts: undefined })),
  };
  const base = p.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 60) || 'manga';
  const name = `${base}_EN_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  const sub: JobCtx = { ...ctx, progress: (x, m) => ctx.progress(0.1 + x * 0.9, m) };
  const file = await renderProject(projectId, sub, signal, { extra: { project: en, outDir: 'videos', name } });
  const duration = await audioDuration(file);
  updateProject(projectId, (cur) => {
    cur.englishTexts = texts;
    cur.english = { file: path.relative(projectDir(projectId), file).replace(/\\/g, '/'), at: new Date().toISOString(), duration, renderAt: cur.lastRender?.at ?? '', texts };
  });
  return `Vídeo com áudio em inglês pronto: ${duration.toFixed(1)} s → ${file}`;
}
