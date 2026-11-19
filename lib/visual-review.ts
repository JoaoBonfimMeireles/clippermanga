// Revisão VISUAL do gestor (Opus): olha QUADROS, nunca o vídeo, para gastar pouco.
//  1) reviewShortVisual: depois de renderizar cada short, uma grade de 6 quadros (início, meio, fim) + narração + título.
//     Diz se o gancho visual e o final funcionam e quais trechos têm recorte ruim; o app tira esses trechos (só em
//     shorts de corte, e só se o short continuar com 20 s ou mais) e renderiza de novo, uma vez.
//  2) cropSheet: usado na auditoria do lote (lib/manager.ts): em vez de descrever os recortes piores em texto, o Opus vê
//     uma folha com o recorte real de cada parte da amostra.
// Nos dois casos entram os seus shorts bons e ruins (exemplosPrompt) como referência do que funciona no canal.
// Nunca derruba um job: sem Opus (cota/erro) o short segue como está. Desligar: MANGA_VISUAL_REVIEW=0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractJson } from '@clipper/editing-planner';
import type { LLMImage } from '@clipper/ai-providers';
import { runFfmpeg } from '@clipper/video-processing';
import { managerProvider } from './llm';
import { exemplosPrompt } from './exemplos';
import { noteReview } from './review';
import { cropPx } from './camera';
import { projectDir } from './store';
import type { Rect, StudioPage } from './types';

export const visualReviewOn = () => process.env.MANGA_VISUAL_REVIEW !== '0';
const clean = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function jpegImage(file: string): Promise<LLMImage> {
  return { mimeType: 'image/jpeg', base64: fs.readFileSync(file).toString('base64') };
}

/** Grade 3x2 de 6 quadros espaçados do início ao fim do conteúdo (sem os 2 s finais de silêncio). */
async function frameGrid(video: string, contentSeconds: number): Promise<LLMImage> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-vr-'));
  try {
    const out = path.join(tmp, 'grid.jpg');
    const fps = (6 / Math.max(2, contentSeconds)).toFixed(5);
    await runFfmpeg(['-y', '-i', video, '-t', String(Math.max(2, contentSeconds)), '-vf', `fps=${fps},scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2,tile=3x2`, '-frames:v', '1', '-q:v', '4', out]);
    return await jpegImage(out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface ShortVerdict {
  ok: boolean;
  summary: string;
  /** Partes do short (1-based) com recorte/imagem ruim, para tirar. */
  badParts: number[];
  issues: string[];
}

const SHORT_SYSTEM = `Você é o GESTOR (Opus) de um canal brasileiro de YouTube Shorts que resume mangás/manhwas. Recebe UMA imagem com 6 quadros de um short vertical, na ordem do tempo (esquerda→direita, cima→baixo: 1 a 6), mais título e narração. Avalie só o que se vê:
- Gancho visual: o quadro 1 prende (ação, rosto, impacto) ou é parado/confuso?
- Recortes: arte cortada no meio de um rosto/corpo, borrado/pixelado, muito pequeno ou solto no meio da tela, balão de fala cortado, margem em branco, imagem repetida em seguida.
- Final: o último quadro fecha com impacto ou termina fraco?
- A imagem combina com o título e a narração?
Compare com os shorts bons e ruins do canal (referência). Reprove SÓ com problema visível e claro; não opine sobre gosto.
Responda SOMENTE JSON: {"ok":true|false,"summary":"1-2 frases","issues":["problema concreto"],"badQuadros":[números 1-6 dos quadros com recorte/imagem ruim],"lesson":"regra curta e geral para os próximos shorts (ou vazio)"}`;

/** Opus olha a grade do short renderizado. Devolve null se não deu para avaliar. */
export async function reviewShortVisual(opts: {
  video: string;
  contentSeconds: number;
  title: string;
  mode: string;
  narration: string;
  /** Início (s) de cada parte do short, em ordem, para ligar "quadro N" à parte certa. */
  partStarts: number[];
  signal?: AbortSignal;
}): Promise<ShortVerdict | null> {
  if (!visualReviewOn()) return null;
  try {
    const llm = managerProvider();
    if (!llm) return null;
    const grid = await frameGrid(opts.video, opts.contentSeconds);
    const raw = await llm.complete({
      system: SHORT_SYSTEM,
      prompt: `${exemplosPrompt(3500)}Short (${opts.mode}, ${Math.round(opts.contentSeconds)} s)\nTítulo: ${opts.title}\nNarração: ${opts.narration.slice(0, 1500) || '(só imagens)'}`,
      images: [grid],
      maxTokens: 700,
      temperature: 0.2,
      tier: 'manager',
      signal: opts.signal,
    });
    const j = extractJson(raw) as { ok?: unknown; summary?: unknown; issues?: unknown; badQuadros?: unknown; lesson?: unknown };
    const issues = (Array.isArray(j.issues) ? j.issues : []).map((x) => clean(x, 200)).filter(Boolean).slice(0, 5);
    const step = opts.contentSeconds / 6;
    const part = (q: number) => {
      const t = (q - 1) * step + 0.01;
      let k = 0;
      opts.partStarts.forEach((s, i) => void (s <= t && (k = i)));
      return k + 1;
    };
    const badParts = [...new Set((Array.isArray(j.badQuadros) ? j.badQuadros : []).map(Number).filter((q) => q >= 1 && q <= 6).map(part))];
    const ok = j.ok !== false;
    noteReview('visual-short', 'Revisão visual dos shorts (quadros)', 'opus', ok, issues, clean(j.lesson, 200));
    return { ok, summary: clean(j.summary, 300), badParts, issues };
  } catch (e) {
    console.warn(`[visual-review] pulada: ${(e as Error).message}`);
    return null;
  }
}

/** Folha com o recorte REAL de cada parte (até 8), na ordem (esquerda→direita, cima→baixo), para o Opus ver na auditoria do lote. */
export async function cropSheet(projectId: string, rows: { page?: StudioPage; focus: Rect }[]): Promise<LLMImage | null> {
  if (!visualReviewOn()) return null;
  const list = rows.filter((r) => r.page).slice(0, 8);
  if (!list.length) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-cs-'));
  try {
    let made = 0;
    for (const r of list) {
      const c = cropPx(r.focus, r.page!.width, r.page!.height);
      const src = path.join(projectDir(projectId), r.page!.file);
      try {
        await runFfmpeg(['-y', '-i', src, '-vf', `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2:color=gray`, '-frames:v', '1', '-q:v', '4', path.join(tmp, `t${String(made + 1).padStart(2, '0')}.jpg`)]);
        made++;
      } catch {
        /* recorte ilegível: fica fora da folha */
      }
    }
    if (!made) return null;
    const out = path.join(tmp, 'sheet.jpg');
    await runFfmpeg(['-y', '-framerate', '1', '-i', path.join(tmp, 't%02d.jpg'), '-vf', 'tile=4x2', '-frames:v', '1', '-q:v', '4', out]);
    return await jpegImage(out);
  } catch (e) {
    console.warn(`[visual-review] folha de recortes pulada: ${(e as Error).message}`);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface BeforeAfter {
  page: StudioPage;
  before: Rect; // recorte da IA
  after: Rect; // recorte do usuário
}

/**
 * Folhas de "antes e depois" para o Opus aprender COMPARANDO imagens: cada linha tem 3 quadros, da esquerda para a direita:
 * 1) a página (trecho em volta) com o recorte da IA em VERMELHO e o do usuário em VERDE; 2) o que o recorte da IA mostrava
 * (borda vermelha); 3) o que o recorte do usuário mostra (borda verde). Até 4 pares por folha.
 */
export async function beforeAfterSheets(projectId: string, rows: BeforeAfter[]): Promise<LLMImage[]> {
  if (!visualReviewOn() || !rows.length) return [];
  const sheets: LLMImage[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-ba-'));
  const W = 360, H = 270;
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=gray`;
  try {
    for (let s = 0; s * 4 < rows.length; s++) {
      const chunk = rows.slice(s * 4, s * 4 + 4);
      let made = 0;
      for (const r of chunk) {
        try {
          const src = path.join(projectDir(projectId), r.page.file);
          const pw = r.page.width, ph = r.page.height;
          const b = cropPx(r.before, pw, ph), a = cropPx(r.after, pw, ph);
          // trecho da página em volta dos dois recortes (a página pode ter milhares de px de altura)
          const y0 = Math.min(b.y, a.y), y1 = Math.max(b.y + b.h, a.y + a.h), m = Math.max(Math.round(ph * 0.04), Math.round((y1 - y0) * 0.4));
          const cy = Math.max(0, y0 - m), ch = Math.min(ph, y1 + m) - cy, chEven = ch - (ch % 2);
          const th = Math.max(4, Math.round(pw / 120));
          const box = (c: { x: number; y: number; w: number; h: number }, color: string) => `drawbox=x=${c.x}:y=${c.y - cy}:w=${c.w}:h=${c.h}:color=${color}:t=${th}`;
          const n = String(made * 3 + 1).padStart(2, '0'), n2 = String(made * 3 + 2).padStart(2, '0'), n3 = String(made * 3 + 3).padStart(2, '0');
          await runFfmpeg(['-y', '-i', src, '-vf', `crop=${pw - (pw % 2)}:${chEven}:0:${cy},${box(b, 'red')},${box(a, 'lime')},${fit}`, '-frames:v', '1', '-q:v', '4', path.join(tmp, `t${n}.jpg`)]);
          await runFfmpeg(['-y', '-i', src, '-vf', `crop=${b.w}:${b.h}:${b.x}:${b.y},${fit},drawbox=x=0:y=0:w=iw:h=ih:color=red:t=6`, '-frames:v', '1', '-q:v', '4', path.join(tmp, `t${n2}.jpg`)]);
          await runFfmpeg(['-y', '-i', src, '-vf', `crop=${a.w}:${a.h}:${a.x}:${a.y},${fit},drawbox=x=0:y=0:w=iw:h=ih:color=lime:t=6`, '-frames:v', '1', '-q:v', '4', path.join(tmp, `t${n3}.jpg`)]);
          made++;
        } catch {
          /* par ilegível: fica fora da folha */
        }
      }
      if (!made) continue;
      const out = path.join(tmp, `sheet${s}.jpg`);
      await runFfmpeg(['-y', '-framerate', '1', '-i', path.join(tmp, 't%02d.jpg'), '-vf', `tile=3x${made}`, '-frames:v', '1', '-q:v', '5', out]);
      sheets.push(await jpegImage(out));
      for (const f of fs.readdirSync(tmp)) if (f.startsWith('t')) fs.rmSync(path.join(tmp, f), { force: true });
    }
  } catch (e) {
    console.warn(`[visual-review] folhas antes/depois puladas: ${(e as Error).message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return sheets;
}
