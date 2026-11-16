// Legendas do vídeo final (publicação): SRT em pt-BR com a minutagem real do render (lastRender.segments = início e
// duração de cada parte no vídeo final), tradução para chinês simplificado pela IA de texto, e o vídeo final com a
// legenda chinesa queimada por cima (ffmpeg só sobre o MP4 já renderizado, sem refazer as cenas).
// Dentro de cada parte, o tempo de cada bloco é proporcional ao tamanho do texto (como a legenda do próprio render).
import fs from 'node:fs';
import path from 'node:path';
import { extractJson } from '@clipper/editing-planner';
import { runFfmpeg } from '@clipper/video-processing';
import { createMangaLLM } from './llm';
import { loadCheckpoint, saveCheckpoint } from './checkpoint';
import { projectDir, readProject, updateProject } from './store';
import { stripWords } from './wordcut';
import type { JobCtx } from './jobs';
import type { StudioProject } from './types';

const srtTime = (t: number) => {
  const ms = Math.max(0, Math.round(t * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

/** Divide em blocos de legenda: pt por palavras (~7), chinês por caracteres (~16, quebrando em pontuação quando der). */
function chunks(text: string, cjk: boolean): string[] {
  if (!cjk) {
    const w = text.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < w.length; i += 7) out.push(w.slice(i, i + 7).join(' '));
    return out;
  }
  const out: string[] = [];
  let cur = '';
  for (const ch of text.replace(/\s+/g, '')) {
    cur += ch;
    if ((cur.length >= 10 && /[，。！？；、,.!?]/.test(ch)) || cur.length >= 16) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Partes do vídeo com o texto falado e onde ficam no vídeo final. */
function spoken(p: StudioProject) {
  const segs = p.lastRender?.segments ?? [];
  const cut = p.cutWords ?? [];
  const byId = new Map(p.shots.map((s) => [s.id, s])); // O(1) por segmento em vez de varrer as partes
  return segs
    .map((g) => {
      const s = byId.get(g.id);
      const text = s ? (cut.length ? stripWords(s.text, cut) : s.text).trim() : '';
      return { id: g.id, start: g.start, dur: g.dur, text };
    })
    .filter((x) => x.text);
}

export function buildSrt(parts: { start: number; dur: number; text: string }[], cjk: boolean): string {
  const out: string[] = [];
  for (const part of parts) {
    const cs = chunks(part.text, cjk);
    const total = cs.reduce((n, c) => n + c.length, 0) || 1;
    let t = part.start;
    for (const c of cs) {
      const d = (c.length / total) * part.dur;
      out.push(`${out.length + 1}\n${srtTime(t)} --> ${srtTime(t + d - 0.02)}\n${c}\n`);
      t += d;
    }
  }
  return out.join('\n');
}

/** SRT em pt-BR montado na hora a partir do último render. */
export function srtPt(projectId: string): string {
  const p = readProject(projectId);
  if (!p?.lastRender?.segments?.length) throw new Error('Renderize o vídeo antes (a legenda usa os tempos do render)');
  return buildSrt(spoken(p), false);
}

/** Tudo o que a IA escreveu no projeto: obra, resumos dos capítulos, roteiro por página e a narração final com tempos. */
export function fullTranscript(projectId: string): string {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  const chapters = [...new Set(p.pages.map((x) => x.chapter))];
  const parts: string[] = [`# ${p.title}`];
  if (p.context) parts.push(`## Obra\n${p.context}`);
  if (p.chapterContexts && Object.keys(p.chapterContexts).length) parts.push(`## Resumo dos capítulos\n${chapters.filter((c) => p.chapterContexts?.[c]).map((c) => `${c}: ${p.chapterContexts![c]}`).join('\n\n')}`);
  if (p.pageScript && Object.keys(p.pageScript).length) {
    const order = p.pages.filter((pg) => p.pageScript?.[pg.id]);
    parts.push(`## Roteiro por página\n${order.map((pg, i) => `[${pg.chapter} · pág. ${i + 1}] ${p.pageScript![pg.id]}`).join('\n')}`);
  }
  const segs = new Map((p.lastRender?.segments ?? []).map((g) => [g.id, g]));
  parts.push(`## Narração do vídeo\n${p.shots.filter((s) => s.text.trim()).map((s) => `${segs.has(s.id) ? `[${srtTime(segs.get(s.id)!.start).slice(0, 8)}] ` : ''}${s.text.trim()}`).join('\n')}`);
  if (p.subs?.zh?.length) parts.push(`## Narração em chinês\n${p.subs.zh.map((x) => x.text).join('\n')}`);
  return parts.join('\n\n') + '\n';
}

const BATCH = 25;

/** Traduz a narração (por parte) para chinês simplificado e salva no projeto. Reaproveita lotes já traduzidos. */
export async function translateZh(projectId: string, ctx: JobCtx, signal: AbortSignal): Promise<string> {
  const p = readProject(projectId);
  if (!p?.lastRender?.segments?.length) throw new Error('Renderize o vídeo antes');
  const parts = spoken(p);
  const llm = createMangaLLM({ paidGate: ctx.paid });
  llm.onNotice = ctx.log;
  const version = 'zh1';
  const done = loadCheckpoint<string>(projectId, 'subs-zh', version);
  const out: { id: string; text: string }[] = [];
  for (let i = 0; i < parts.length; i += BATCH) {
    if (signal.aborted) throw signal.reason;
    const batch = parts.slice(i, i + BATCH);
    ctx.progress(i / parts.length, `Traduzindo para chinês (${i + 1}-${i + batch.length} de ${parts.length})`);
    const key = (t: string) => `${t.length}:${t.slice(0, 40)}:${t.slice(-20)}`;
    const missing = batch.filter((b) => !done.has(key(b.text)));
    if (missing.length) {
      const raw = await llm.complete({
        system: 'Você traduz narração de vídeo de resumo de mangá do português do Brasil para chinês simplificado (mandarim), natural e fluente para legenda. Mantenha nomes próprios (translitere quando houver forma comum). Responda só JSON: {"texts": string[]} com o MESMO número de itens, na mesma ordem.',
        prompt: JSON.stringify({ context: p.context?.slice(0, 600) ?? '', texts: missing.map((m) => m.text) }),
        maxTokens: 4000,
        temperature: 0.2,
        signal,
      });
      const texts = ((extractJson(raw) as { texts?: unknown[] }).texts ?? []).map((t) => String(t ?? '').trim());
      if (texts.length !== missing.length || texts.some((t) => !t)) throw new Error(`A IA devolveu ${texts.length} traduções para ${missing.length} textos; rode de novo`);
      missing.forEach((m, k) => {
        done.set(key(m.text), texts[k]);
        saveCheckpoint(projectId, 'subs-zh', version, key(m.text), texts[k]);
      });
    }
    for (const b of batch) out.push({ id: b.id, text: done.get(key(b.text))! });
  }
  updateProject(projectId, (cur) => {
    cur.subs = { zh: out, zhAt: cur.lastRender?.at };
  });
  return `Legenda em chinês pronta (${out.length} partes)`;
}

/** SRT chinês com os tempos do render atual (as partes traduzidas são casadas pelo id). */
export function srtZh(projectId: string): string {
  const p = readProject(projectId);
  if (!p?.subs?.zh?.length) throw new Error('Gere a tradução em chinês antes');
  const zh = new Map(p.subs.zh.map((x) => [x.id, x.text]));
  return buildSrt(spoken(p).map((x) => ({ ...x, text: zh.get(x.id) ?? '' })).filter((x) => x.text), true);
}

/** Queima a legenda chinesa sobre o MP4 já renderizado (áudio copiado, sem refazer as cenas). */
export async function burnZh(projectId: string, ctx: JobCtx, signal: AbortSignal): Promise<string> {
  const p = readProject(projectId);
  if (!p?.lastRender) throw new Error('Renderize o vídeo antes');
  if (!p.subs?.zh?.length) await translateZh(projectId, ctx, signal);
  const dir = path.join(projectDir(projectId), 'publish');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'legenda_zh.srt'), srtZh(projectId), 'utf8');
  const vertical = p.format === 'vertical';
  const style = `FontName=Microsoft YaHei,FontSize=${vertical ? 14 : 22},Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=${vertical ? 60 : 26}`;
  const outRel = 'publish/video_legendado_zh.mp4';
  const D = p.lastRender.duration || 1;
  ctx.progress(0.3, 'Queimando a legenda chinesa no vídeo');
  // cwd = pasta publish: o filtro subtitles recebe nome simples (caminhos do Windows com ":" quebram o filtro)
  const args = (venc: string[]) => ['-i', p.lastRender!.file, '-vf', `subtitles=legenda_zh.srt:force_style='${style}'`, ...venc, '-c:a', 'copy', '-movflags', '+faststart', 'video_legendado_zh.mp4'];
  const onStderrLine = (l: string) => {
    const m = /time=(\d+):(\d+):([\d.]+)/.exec(l);
    if (m) ctx.progress(0.3 + 0.7 * Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / D));
  };
  try {
    await runFfmpeg(args(['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '21']), { cwd: dir, signal, onStderrLine });
  } catch (e) {
    if (signal.aborted) throw e;
    await runFfmpeg(args(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']), { cwd: dir, signal, onStderrLine });
  }
  updateProject(projectId, (cur) => {
    cur.subs = { ...(cur.subs ?? { zh: [] }), zhVideo: { file: outRel, at: new Date().toISOString(), renderAt: cur.lastRender?.at ?? '' } };
  });
  return 'Vídeo com legenda em chinês pronto';
}
