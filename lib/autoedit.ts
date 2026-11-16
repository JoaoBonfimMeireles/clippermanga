// Edição automática pela IA: monta a linha do tempo inteira — quais quadros mostrar, o recorte de cada um (foco),
// tela cheia ou laterais desfocadas, movimento leve, duração e o texto.
// Economia: a IA de visão lê cada página UMA vez (lib/page-notes.ts: quadros com a caixa justa, tipo, impacto, giro,
// acontecimentos e falas, guardados em disco). A edição em si é só TEXTO, várias páginas por chamada: escolhe os
// quadros pelo número e escreve a narração. Os ajustes finos do recorte (bordas lisas, quadros altos, fundo) são
// feitos aqui, medindo os pixels da página original.
import { lockedSet } from './lock';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractJson } from '@clipper/editing-planner';
import { MANGA_SIZES } from '@clipper/shared';
import { runFfmpeg } from '@clipper/video-processing';
import { isClaude, jobLLM } from './ai-meter';
import { autoFill, BG_BAND, cleanRect, cropPx, effSize } from './camera';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from './checkpoint';
import { ensurePageNotes, type PageNote } from './page-notes';
import { avoidAds, findPromo, type AdRange } from './promo';
import { NARRATOR_STYLE } from './narrator';
import { seriesPrompt } from './series';
import { learningPrompt } from './learning';
import { cutsPrompt } from './cut-profiles';
import { skillsPrompt } from './skills';
import { maxHeightFrac, softenShot } from './crop-quality';
import { projectDir, readProject, updateProject } from './store';
import type { JobCtx } from './jobs';
import type { Motion, Shot, ShotView, StudioPage } from './types';

export const EDIT_SYSTEM = `Você é editor de vídeo de um canal brasileiro de resumos narrados de mangá/manhwa no YouTube.
Você recebe a LEITURA de algumas páginas seguidas (feita antes por quem viu as imagens): o que acontece, as falas já traduzidas e os QUADROS numerados de cada página, com o que mostram, tipo, impacto (1-10) e formato. Você NÃO vê as imagens: decide só por esse texto. Para cada página, decida como ela vira vídeo.
O vídeo mostra um quadro por vez. A caixa de cada quadro já vem pronta e o app cuida sozinho do tamanho na tela (altura cheia, largura mínima, balão aparado das bordas): você só escolhe QUAIS quadros entram, em que ordem (a de leitura) e o texto narrado.

ESCOLHA ("panel": número do quadro na página):
- A IMAGEM MOSTRA O QUE A NARRAÇÃO DIZ. Falou de alguém (quem é, passado, família, poder, aparência): o quadro DELE, mesmo de impacto baixo. Falou de lugar, criatura, golpe ou evento: o quadro disso.
- ARTE, NÃO TEXTO: escolha quadros com personagem, ação ou cenário. Quadro que é só balão, caixa de texto, placa, logo ou onomatopeia fica fora (meta: no máximo 5 a cada 100 recortes, e só quando a página não tem nenhuma arte daquele momento).
- CENA, NÃO DETALHE: entre quadros do mesmo momento, o que mostra a cena completa. Pule transição, objeto solto, repetição e quadro que é só preto, só branco ou fundo vazio (salvo quando a narração fala justamente da escuridão ou do clarão).
- FORMATO: quadro marcado "pequeno" (fica muito ampliado na tela) ou "ALTO" (vira cortes rápidos) é a última opção: só se nenhum outro mostra aquele momento.
- "close": false é o padrão. true só em impacto 9+, em quadro com "close disponível", quando a fala é sobre o rosto ou a expressão daquela pessoa.
- INTRODUÇÃO: nas primeiras páginas do primeiro capítulo a narração apresenta o protagonista, a origem dele e o mundo; use os quadros que mostram isso (ele criança, a família, flashbacks, o cenário). Esse contexto não é pulado nem resumido em balões.
- FIDELIDADE: use SÓ os quadros das páginas recebidas, na ordem da história; nunca invente nem adiante conteúdo, e narre apenas o que está nelas. Se nenhum quadro ilustra uma fala, não force um quadro sem relação: a fala vai no "text" do recorte vizinho (a narração costura).
- PROPAGANDA: nunca use quadro de divulgação da scan (Support Us, Discord, Ko-fi, Patreon, logo, créditos, capa/título, anúncio de outra obra, marca d'água), no início ou no rodapé.
- Página sem nada relevante: "shots": [].

TIPO ("kind"): "action" (luta, golpe, corrida, explosão, poder), "reaction" (rosto, surpresa, emoção), "dialogue" (conversa), "scene" (lugar ou personagem novo; use pouco). Em geral, mantenha o do quadro.

ENCAIXE ("fit"): "contain" é o padrão. "cover" (tela cheia) só em quadro "largo" de paisagem ou ação; o app recusa "cover" em quadro que não tem o formato da tela.

MOVIMENTO ("motion"), sempre leve: "zoom-in" (o padrão: reações e tensão), "zoom-out" (revelação, fim de cena), "pan" (só com "cover"). Evite "static".

RITMO:
- Canal de resumo: ação, emoção, clímax e apresentação de personagem/mundo ganham recortes. Conversa, explicação e enchimento viram UM recorte com o texto resumindo tudo, numa imagem de rosto ou de cena.
- Página com muita conversa: no máximo 1 recorte. Ação: até 6 recortes por página, com ritmo rápido.
- Uma fala pode ter 2 ou 3 imagens: os recortes seguintes vêm com "text": "" e aparecem NA TELA DURANTE a mesma fala, trocando de imagem enquanto a voz continua (ex.: "Um meteoro caiu bem no centro da cidade" mostra o céu, a explosão e a cratera). Cada imagem fica pelo menos ~1 segundo.
- O vídeo NUNCA fica com imagem sem narração: recorte com "text": "" só existe depois de um recorte com fala, e o PRIMEIRO recorte de cada página com algo para mostrar sempre tem "text".

NOTA DE IMPACTO ("impact", 1 a 10): parte da nota do quadro e ajuste pelo papel na história. Ela decide quanto tempo o recorte fica na tela.
- 9-10: clímax, virada, revelação, golpe decisivo, morte, transformação, primeira aparição de alguém importante.
- 6-8: ação forte, emoção marcante, informação importante da trama.
- 3-5: transição útil, contexto, reação comum.
- 1-2: enchimento. Prefira pular esses recortes em vez de incluí-los.
Seja criterioso: nem tudo é 8+. Varie as notas ao longo do capítulo para criar ritmo.

ROTEIRO (quando a página vier com "ROTEIRO NARRADO"): mostre na tela o que a narração fala e reparta as frases do roteiro no "text" dos recortes, na ordem, sem mudar o sentido.
- O que o roteiro não menciona tem impacto baixo ou fica fora.
- NUNCA corte uma frase no meio para repartir entre recortes ("E no meio" | "protagonista aqui,"): a voz fala cada "text" separado e o corte vira uma pausa sem sentido. Reparta só em fim de frase ou de oração inteira. Frase que não dá para dividir fica INTEIRA num recorte, e os recortes seguintes dela vêm com "text": "".

CONTINUIDADE: os "text" de todas as páginas formam UMA narração corrida, como filme. O primeiro "text" continua direto do fim da "História até aqui" (sem repetir nem recomeçar), cada página continua a anterior e o último deixa um gancho para a página seguinte.

TEXTO ("text"): SEMPRE em português do Brasil, qualquer que seja o idioma da obra.
${NARRATOR_STYLE}
- NUNCA repita no começo de um "text" o final do anterior (nem a mesma oração com outras palavras): cada trecho traz só informação NOVA.
- Cada "text" com voz tem no mínimo ~6 palavras, é frase completa dentro da história (nunca legenda solta como "Fulano surpreso.") e termina numa pausa natural. Sobrou pouco texto? Junte ao recorte vizinho e deixe o outro com "text": "".
- Tamanho proporcional ao impacto: impacto alto pode ter uma frase mais longa; impacto baixo, poucas palavras.

Responda SOMENTE JSON, com TODAS as páginas recebidas, na ordem:
{"pages":[{"page":12,"shots":[{"panel":2,"close":false,"kind":"action","fit":"contain","motion":"zoom-in","impact":7,"text":"..."}],"summary":"o que aconteceu nesta página, em uma frase"}]}`;

const MOTIONS: Motion[] = ['zoom-in', 'zoom-out', 'pan', 'static'];
const KINDS = ['action', 'reaction', 'dialogue', 'scene'] as const;

interface RawShot {
  rotate?: number;
  stretch?: number;
  box?: unknown;
  kind?: string;
  fit?: string;
  motion?: string;
  duration?: number;
  impact?: number;
  text?: string;
}

/** Duração pela nota de impacto: 1 → 1,6 s; 5 → 3 s; 10 → 4,8 s. */
export const durationForImpact = (impact: number) => Math.round((1.25 + Math.min(10, Math.max(1, impact)) * 0.355) * 10) / 10;

/** Valida o que a IA devolveu: descarta recortes inválidos ou minúsculos e limita valores. */
export function toShots(page: StudioPage, raw: RawShot[], voice: boolean, aspect = 16 / 9): Shot[] {
  const out: Shot[] = [];
  for (const r of raw.slice(0, 8)) {
    if (!Array.isArray(r.box) || r.box.length !== 4 || !r.box.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    let [x0, y0, x1, y1] = r.box as number[];
    // alguns modelos devolvem pixels ou 0..100 em vez de frações
    if (Math.max(x0, x1) > 1.5 || Math.max(y0, y1) > 1.5) {
      const sx = Math.max(x0, x1) > 100 ? page.width : 100, sy = Math.max(y0, y1) > 100 ? page.height : 100;
      [x0, x1, y0, y1] = [x0 / sx, x1 / sx, y0 / sy, y1 / sy];
    }
    let focus = cleanRect({ x0, y0, x1, y1 });
    // quadro alto demais vira tirinha na tela: fica só o topo (onde costuma estar o rosto), com altura até 1,9x a largura
    {
      const w0 = (focus.x1 - focus.x0) * page.width, h0 = (focus.y1 - focus.y0) * page.height;
      if (h0 > w0 * 1.9) focus = cleanRect({ ...focus, y1: focus.y0 + (w0 * 1.9) / page.height });
    }
    const pxW = (focus.x1 - focus.x0) * page.width, pxH = (focus.y1 - focus.y0) * page.height;
    if (pxW < 120 || pxH < 120) continue; // pequeno demais: provavelmente ruído
    const kind = KINDS.find((k) => k === r.kind) ?? 'scene';
    // tela cheia só quando o quadro já tem quase o formato da tela (senão cortaria cabeça/arma): nunca forçar preenchimento
    const fit = r.fit === 'cover' && Math.abs(pxW / pxH / aspect - 1) < 0.12 ? 'cover' : 'contain';
    const rotate = r.rotate === 90 || r.rotate === -90 ? r.rotate : 0;
    // ocupar o máximo da tela: esticar (até 1.35) e aproximar (até 1.25) conforme o formato do recorte
    const ef = effSize({ w: pxW, h: pxH }, { rotate });
    // sem esticar nem aproximar: aproximar além do encaixe corta a cena; o quadro inteiro aparece como é
    const stretch = 1;
    const zoom = 1;
    void ef;
    let motion = MOTIONS.find((m) => m === r.motion) ?? 'zoom-in';
    if (motion === 'pan' && fit !== 'cover') motion = 'zoom-in';
    const text = (r.text ?? '').toString().trim();
    const impact = Math.round(Math.min(10, Math.max(1, Number(r.impact) || 5)));
    if (impact <= 1) continue; // enchimento: fora do vídeo
    let duration = durationForImpact(impact);
    if (voice && text) duration = Math.max(duration, Math.min(10, text.split(/\s+/).length / 2.5));
    out.push({ id: randomUUID().slice(0, 8), pageId: page.id, focus, fit, rotate, stretch, zoom, kind, impact, motion, duration: Math.round(duration * 10) / 10, text });
  }
  return out;
}

/** Versão reduzida (160 px de largura) e em tons de cinza do recorte, para medir bordas e cortes. */
async function grayCrop(img: string, page: StudioPage, focus: Shot['focus']) {
  const c = cropPx(focus, page.width, page.height);
  const SW = 160;
  const SH = Math.max(8, Math.round((c.h / c.w) * SW));
  const raw = path.join(os.tmpdir(), `manga-gray-${randomUUID().slice(0, 8)}.gray`);
  try {
    await runFfmpeg(['-i', img, '-vf', `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${SW}:${SH},format=gray`, '-f', 'rawvideo', '-frames:v', '1', raw]);
    const px = fs.readFileSync(raw);
    if (px.length < SW * SH) return null;
    const dev = (vals: number[]) => {
      const m = vals.reduce((x, y) => x + y, 0) / vals.length;
      return Math.sqrt(vals.reduce((x, y) => x + (y - m) ** 2, 0) / vals.length);
    };
    /** Variação de cada linha/coluna: perto de 0 = faixa lisa (sarjeta, fundo vazio). */
    const rowDev = (y: number) => dev(Array.from({ length: SW }, (_, x) => px[y * SW + x]));
    const colDev = (x: number) => dev(Array.from({ length: SH }, (_, y) => px[y * SW + x]));
    return { SW, SH, px, rowDev, colDev };
  } catch {
    return null;
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

/**
 * Blocos reais de imagem da página: o que fica entre faixas lisas (sarjeta branca/preta) altas o bastante. Balão que
 * invade a sarjeta (ou pessoa saindo de um degradê) fica DENTRO do bloco, porque quebra a faixa lisa. Medido nos pixels,
 * sem IA. Em fração da altura da página.
 */
const blockCache = new Map<string, { y0: number; y1: number }[]>();
export async function pageBlocks(img: string, page: StudioPage): Promise<{ y0: number; y1: number }[]> {
  const hit = blockCache.get(img);
  if (hit) return hit;
  const SW = 160;
  const SH = Math.max(8, Math.round((page.height / page.width) * SW));
  const raw = path.join(os.tmpdir(), `manga-rows-${randomUUID().slice(0, 8)}.gray`);
  const blocks: { y0: number; y1: number }[] = [];
  try {
    await runFfmpeg(['-i', img, '-vf', `scale=${SW}:${SH},format=gray`, '-f', 'rawvideo', '-frames:v', '1', raw]);
    const px = fs.readFileSync(raw);
    if (px.length >= SW * SH) {
      const flat: boolean[] = [];
      const pale: boolean[] = []; // linha quase toda clara (fundo branco com um balão): sem desenho
      for (let y = 0; y < SH; y++) {
        let s = 0, s2 = 0;
        for (let x = 0; x < SW; x++) { const v = px[y * SW + x]; s += v; s2 += v * v; }
        const m = s / SW;
        flat.push(Math.sqrt(Math.max(0, s2 / SW - m * m)) < 7);
        pale.push(m > 225);
      }
      const paleFrac = (a: number, b: number) => { let n = 0; for (let y = a; y < b; y++) if (pale[y]) n++; return n / Math.max(1, b - a); };
      const MIN_GAP = 5; // ~22 px da página original: sarjeta de verdade, não uma linha lisa dentro do desenho
      let start = -1, gap = 0;
      for (let y = 0; y <= SH; y++) {
        const isFlat = y < SH ? flat[y] : true;
        if (!isFlat) { if (start < 0) start = y; gap = 0; }
        else if (start >= 0) {
          gap++;
          if (gap >= MIN_GAP || y === SH) {
            const end = y - gap + 1;
            if (end - start >= 12) blocks.push({ y0: start / SH, y1: end / SH, bare: paleFrac(start, end) > 0.75 } as { y0: number; y1: number });
            start = -1;
          }
        }
      }
      // bloco "só balão" (fundo branco, sem desenho) não é um quadro: cola no vizinho mais próximo (o balão fala dele)
      const MAX_GAP = 0.04;
      for (let k = 0; k < blocks.length; k++) {
        const b = blocks[k] as { y0: number; y1: number; bare?: boolean };
        if (!b.bare) continue;
        const prev = blocks[k - 1] as typeof b | undefined, next = blocks[k + 1] as typeof b | undefined;
        const gp = prev && !prev.bare ? b.y0 - prev.y1 : Infinity, gn = next && !next.bare ? next.y0 - b.y1 : Infinity;
        if (Math.min(gp, gn) > MAX_GAP) continue; // sem vizinho perto: continua isolado (e sai como vazio depois)
        if (gn <= gp) { next!.y0 = b.y0; } else { prev!.y1 = b.y1; }
        blocks.splice(k, 1);
        k--;
      }
    }
  } catch {
    /* sem blocos: mantém as caixas da IA */
  } finally {
    fs.rmSync(raw, { force: true });
  }
  blockCache.set(img, blocks);
  return blocks;
}

/**
 * A IA erra o recorte por alguns pixels: corta das bordas as faixas lisas (sarjeta branca/preta, fundo vazio).
 */
export async function trimBorders(img: string, page: StudioPage, focus: Shot['focus']): Promise<Shot['focus']> {
  const g = await grayCrop(img, page, focus);
  if (!g) return focus;
  const { SW, SH } = g;
  let top = 0, bot = SH - 1, left = 0, right = SW - 1;
  while (top < SH * 0.4 && g.rowDev(top) < 7) top++;
  while (bot > SH * 0.6 && g.rowDev(bot) < 7) bot--;
  while (left < SW * 0.4 && g.colDev(left) < 7) left++;
  while (right > SW * 0.6 && g.colDev(right) < 7) right--;
  const fx = (focus.x1 - focus.x0) / SW, fy = (focus.y1 - focus.y0) / SH;
  return cleanRect({ x0: focus.x0 + left * fx, x1: focus.x0 + (right + 1) * fx, y0: focus.y0 + top * fy, y1: focus.y0 + (bot + 1) * fy });
}

/**
 * REGRA FIXA: a imagem tem que dar para ver. Recorte vazio (só preto/branco/liso) ou com formato extremo (faixa fina,
 * ou largo demais) sai da linha do tempo, e o texto dele vai para o recorte vizinho da mesma página (a narração costura).
 * Devolve os recortes que ficam e quantos saíram.
 */
export async function keepLegible(img: string, page: StudioPage, shots: Shot[], aspect: number): Promise<{ shots: Shot[]; dropped: number }> {
  const ok: boolean[] = [];
  for (const s of shots) {
    const c = cropPx(s.focus, page.width, page.height);
    const ef = effSize({ w: c.w, h: c.h }, { rotate: s.rotate });
    const a = (ef.w * (s.stretch ?? 1)) / ef.h; // proporção do recorte como aparece
    // formato: tira alta fina (altura > 2,5x a largura) ou faixa larga demais (> 4,5) não dá para ler na tela
    if (a < 1 / MAX_TALL_RATIO || a > 4.5) {
      ok.push(false);
      continue;
    }
    const g = await grayCrop(img, page, s.focus);
    if (!g) {
      ok.push(true);
      continue;
    }
    // vazio: quase todas as linhas lisas (sem desenho) ou imagem toda numa cor só
    let flat = 0;
    for (let y = 0; y < g.SH; y++) if (g.rowDev(y) < 7) flat++;
    const mean = g.px.reduce((t, v) => t + v, 0) / g.px.length;
    const blank = flat / g.SH > 0.9 || (mean > 242 && flat / g.SH > 0.7);
    ok.push(!blank);
  }
  const kept: Shot[] = [];
  let carry = ''; // texto de recortes descartados antes do primeiro que fica
  shots.forEach((s, k) => {
    if (ok[k]) {
      kept.push(carry ? { ...s, text: `${carry} ${s.text}`.trim() } : s);
      carry = '';
    } else if (s.text.trim()) {
      if (kept.length) kept[kept.length - 1] = { ...kept[kept.length - 1], text: `${kept[kept.length - 1].text} ${s.text}`.trim() };
      else carry = `${carry} ${s.text}`.trim();
    }
  });
  void aspect;
  return { shots: kept, dropped: shots.length - kept.length };
}

const normW = (w: string) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
/**
 * Remove do começo de `next` o trecho (3+ palavras) que repete o final de `prev` ("...mas logo o clima pesaria de vez."
 * | "Mas logo o clima pesaria de vez, e minha atenção..."). Devolve o texto novo e quantas palavras saíram.
 */
export function trimOverlap(prev: string, next: string): { text: string; cut: number } {
  const a = prev.split(/\s+/).filter(Boolean), b = next.split(/\s+/).filter(Boolean);
  const an = a.map(normW), bn = b.map(normW);
  for (let k = Math.min(30, a.length, b.length - 1); k >= 3; k--) {
    let same = true;
    for (let j = 0; j < k && same; j++) same = an[a.length - k + j] === bn[j] && bn[j] !== '';
    if (!same) continue;
    const rest = b.slice(k).join(' ').replace(/^[,;:\s-]+/, '');
    return { text: rest ? rest[0].toUpperCase() + rest.slice(1) : '', cut: k };
  }
  return { text: next, cut: 0 };
}
/** Aplica trimOverlap em toda a sequência de partes com fala (também entre páginas e lotes). Devolve quantas corrigiu. */
export function dedupeNarration(shots: Shot[]): number {
  let fixed = 0, prev = '';
  for (const s of shots) {
    if (!s.text.trim()) continue;
    const r = trimOverlap(prev, s.text);
    if (r.cut) {
      s.text = r.text;
      fixed++;
    }
    if (s.text.trim()) prev = s.text;
  }
  return fixed;
}

/** Altura máxima de um recorte, em múltiplos da largura: acima disso vira faixa ilegível na tela. */
export const MAX_TALL_RATIO = 2.5;

/**
 * Trava final: partes que ficaram com a tira alta (página/capítulo inteiro, "mantida como estava" depois de uma falha)
 * são divididas em cortes legíveis; o que continua alto demais ou vazio sai, e o texto vai para o vizinho.
 */
export async function legibleOrSplit(img: string, page: StudioPage, shots: Shot[], voice: boolean, aspect: number): Promise<Shot[]> {
  const out: Shot[] = [];
  let carry = '';
  for (const s of shots) {
    const c = cropPx(s.focus, page.width, page.height);
    const ef = effSize({ w: c.w, h: c.h }, { rotate: s.rotate });
    const ratio = ef.h / ef.w;
    let parts: Shot[] = [s];
    if (ratio > MAX_TALL_RATIO) parts = ratio > 9 ? [] : await splitTall(img, page, s, voice, aspect);
    const lg = await keepLegible(img, page, parts, aspect);
    const kept = lg.shots;
    const lost = [s.text, ...(s.extra ? [] : [])].filter(Boolean).join(' ');
    if (!kept.length) {
      if (lost) carry = `${carry} ${lost}`.trim();
      continue;
    }
    if (carry) kept[0] = { ...kept[0], text: `${carry} ${kept[0].text}`.trim() };
    carry = '';
    out.push(...kept);
  }
  if (carry && out.length) out[out.length - 1] = { ...out[out.length - 1], text: `${out[out.length - 1].text} ${carry}`.trim() };
  return out;
}

/** Só a imagem de uma parte (página, recorte, câmera), para mostrar durante a fala de outra. */
export const viewOf = (s: Shot): ShotView => ({ pageId: s.pageId, focus: s.focus, fit: s.fit, rotate: s.rotate, stretch: s.stretch, zoom: s.zoom, motion: s.motion, bgBand: s.bgBand });

/**
 * Regra fixa: nenhuma parte fica só com imagem, sem fala. Recorte sem "text" vira imagem EXTRA da parte com fala
 * vizinha: aparece durante a mesma frase (a voz não para) e o tempo dele soma ao da parte.
 * Antes da primeira fala: as imagens entram no começo dessa fala. Página toda sem fala: sai do vídeo.
 */
export function withSpeech(shots: Shot[]): Shot[] {
  const out: Shot[] = [];
  let lead: Shot[] = [];
  const r1 = (x: number) => Math.round(x * 10) / 10;
  for (const s of shots) {
    if (!s.text.trim()) {
      const prev = out[out.length - 1];
      if (prev) {
        prev.extra = [...(prev.extra ?? []), viewOf(s), ...(s.extra ?? [])];
        prev.duration = r1(prev.duration + s.duration);
      } else lead.push(s);
      continue;
    }
    if (lead.length) {
      const views = [...lead.flatMap((x) => [viewOf(x), ...(x.extra ?? [])]), viewOf(s), ...(s.extra ?? [])];
      out.push({ ...s, ...views[0], extra: views.slice(1), duration: r1(lead.reduce((n, x) => n + x.duration, s.duration)) });
      lead = [];
    } else out.push(s);
  }
  return out;
}

/** Proporção (altura/largura) acima da qual um recorte em pé vira 2 ou 3 cortes rápidos. */
const SPLIT_RATIO = 1.9;

/**
 * Divide o texto em até n pedaços SEM cortar frase no meio (a voz fala cada pedaço separado: cortar "E no meio" |
 * "protagonista aqui" vira pausa sem sentido). Corta em fim de frase; se não der, em vírgula/ponto e vírgula que
 * deixe os dois lados com 5+ palavras; senão o texto fica inteiro no primeiro corte e os outros ficam sem fala.
 */
function splitText(text: string, n: number): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
  if (sentences.length >= n) {
    const out: string[] = Array.from({ length: n }, () => '');
    const per = Math.ceil(sentences.length / n);
    sentences.forEach((x, k) => (out[Math.min(n - 1, Math.floor(k / per))] += (out[Math.min(n - 1, Math.floor(k / per))] ? ' ' : '') + x));
    return out;
  }
  // poucas frases: cada frase vira um pedaço; as que ainda dá, quebra numa vírgula com orações inteiras dos dois lados
  const pieces = [...sentences];
  while (pieces.length < n) {
    let bestK = -1, bestAt = -1, bestScore = Infinity;
    pieces.forEach((pc, k) => {
      const words = pc.split(/\s+/);
      words.forEach((w, j) => {
        if (!/[,;:]$/.test(w) || j + 1 < 5 || words.length - j - 1 < 5) return;
        const score = Math.abs(j + 1 - words.length / 2) - words.length; // prefere o pedaço maior, perto do meio
        if (score < bestScore) (bestScore = score), (bestK = k), (bestAt = j + 1);
      });
    });
    if (bestK < 0) break;
    const words = pieces[bestK].split(/\s+/);
    pieces.splice(bestK, 1, words.slice(0, bestAt).join(' '), words.slice(bestAt).join(' '));
  }
  return Array.from({ length: n }, (_, k) => pieces[k] ?? '');
}

/**
 * Quadro muito alto mostrado de uma vez fica pequeno e espremido. Divide em 2-3 cortes rápidos, cortando nas
 * linhas mais "calmas" (sarjeta, fundo liso) perto das posições ideais. O texto e a duração são repartidos.
 */
export async function splitTall(img: string, page: StudioPage, shot: Shot, voice: boolean, aspect = 16 / 9): Promise<Shot[]> {
  if (shot.rotate) return [shot];
  const c = cropPx(shot.focus, page.width, page.height);
  const ratio = c.h / c.w;
  if (ratio < SPLIT_RATIO) return [shot];
  const n = Math.min(10, Math.max(2, Math.round(ratio / 1.15))); // quadro muito alto: mais cortes, nenhum fica uma faixa fina
  const g = await grayCrop(img, page, shot.focus);
  const SH = g?.SH ?? 100;
  const cuts: number[] = [0];
  for (let k = 1; k < n; k++) {
    const ideal = Math.round((k * SH) / n);
    const span = Math.round(SH / n / 4); // procura o corte em ±25% de um pedaço
    let best = ideal, bestDev = Infinity;
    if (g) for (let y = Math.max(cuts[k - 1] + 4, ideal - span); y <= Math.min(SH - 4, ideal + span); y++) {
      const d = g.rowDev(y);
      if (d < bestDev) (best = y), (bestDev = d);
    }
    cuts.push(best);
  }
  cuts.push(SH);
  const texts = splitText(shot.text, n);
  const f = shot.focus;
  const fy = (f.y1 - f.y0) / SH;
  const motions: Shot['motion'][] = ['zoom-in', 'zoom-out', 'zoom-in', 'zoom-out', 'zoom-in', 'zoom-out'];
  const parts: Shot[] = [];
  for (let k = 0; k < n; k++) {
    const focus = await trimBorders(img, page, cleanRect({ x0: f.x0, x1: f.x1, y0: f.y0 + cuts[k] * fy, y1: f.y0 + cuts[k + 1] * fy }));
    const text = texts[k] ?? '';
    let duration = Math.max(1.5, shot.duration / n);
    if (voice && text) duration = Math.max(duration, Math.min(10, text.split(/\s+/).length / 2.5));
    // pedaço já não é tão estreito: menos esticar
    const pc = cropPx(focus, page.width, page.height);
    const fill = shot.fit === 'cover' ? { stretch: 1, zoom: 1 } : autoFill(pc.w, pc.h, aspect);
    const zoom = shot.fit === 'cover' ? 1 : autoFill(pc.w * fill.stretch, pc.h, aspect).zoom;
    parts.push({ ...shot, id: randomUUID().slice(0, 8), focus, text, stretch: fill.stretch, zoom, motion: shot.motion === 'pan' ? 'zoom-in' : motions[k], duration: Math.round(duration * 10) / 10 });
  }
  // pedaço que virou faixa lisa/minúscula depois do corte de bordas: descarta, sem perder o texto
  const kept = parts.filter((x) => { const pc = cropPx(x.focus, page.width, page.height); return pc.w > 100 && pc.h > 100; });
  if (!kept.length) return [shot];
  const lost = parts.filter((x) => !kept.includes(x)).map((x) => x.text).filter(Boolean).join(' ');
  if (lost) kept[kept.length - 1].text = `${kept[kept.length - 1].text} ${lost}`.trim();
  return kept;
}

/**
 * Fundo desfocado sem texto: mede o "texto" (pixels bem claros com borda forte, como letras brancas ou balões)
 * na faixa de cima e na de baixo do recorte e escolhe a mais limpa.
 */
export async function pickBgBand(img: string, page: StudioPage, shot: Shot): Promise<Shot['bgBand']> {
  if (shot.rotate) return 'top';
  const g = await grayCrop(img, page, shot.focus);
  if (!g) return 'top';
  const { SW, SH, px } = g;
  const score = (y0: number, y1: number) => {
    let n = 0, tot = 0;
    for (let y = y0; y < y1; y++) for (let x = 1; x < SW - 1; x++) {
      const v = px[y * SW + x];
      tot++;
      if (v > 215 && (Math.abs(v - px[y * SW + x - 1]) > 70 || Math.abs(v - px[y * SW + x + 1]) > 70)) n++;
    }
    return tot ? n / tot : 0;
  };
  const h = Math.max(1, Math.round(SH * BG_BAND));
  return score(SH - h, SH) < score(0, h) ? 'bottom' : 'top';
}

/** (legado) Antes havia teto de 5 min por capítulo; hoje só vale se o usuário escolher uma duração. */
export const SECONDS_PER_CHAPTER = 300;

/** Orçamento total em segundos: a duração escolhida pelo usuário ou, sem ela, 5 min por capítulo. */
export function videoBudget(p: { targetMinutes?: number; pages: StudioPage[] }, pages: StudioPage[] = p.pages): number {
  if (p.targetMinutes && p.targetMinutes > 0) return p.targetMinutes * 60;
  void pages;
  return Number.POSITIVE_INFINITY; // automático: sem teto, a IA decide pela relevância de cada capítulo
}

/** Instrução de foco para a IA conforme o aperto do orçamento (segundos por página). */
export function budgetHint(secPerPage: number): string {
  if (secPerPage < 3) return 'Resumo BEM enxuto: mostre só os momentos que mudam a história ou chamam muita atenção (viradas, revelações, lutas, clímax, cenas engraçadas marcantes). Página sem nada disso: pule.';
  if (secPerPage < 7) return 'Resumo enxuto: priorize os momentos importantes e legais (viradas, ação, revelações, emoção forte); conversa e transição viram 1 recorte curto ou somem.';
  return 'Há tempo de sobra: pode mostrar mais detalhes e reações, mas sempre com ritmo, sem enrolar.';
}

/**
 * Corta o vídeo até caber no teto: tira primeiro as partes de menor impacto (conversa e cena antes de ação),
 * preservando o clímax (impacto 8+), e depois encurta o que sobrou (nunca abaixo de 1,2 s).
 */
export function fitBudget(shots: Shot[], maxSec: number): { shots: Shot[]; removed: number } {
  const sum = (xs: Shot[]) => xs.reduce((n, s) => n + s.duration, 0);
  if (sum(shots) <= maxSec) return { shots, removed: 0 };
  const kindRank = { dialogue: 0, scene: 1, reaction: 2, action: 3 } as const;
  // primeiro só as de impacto < 8; se mesmo assim o vídeo ficar muito acima do alvo (> 1,5×), também as de 8+
  const order = shots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.impact ?? 5) - (b.s.impact ?? 5) || kindRank[a.s.kind ?? 'scene'] - kindRank[b.s.kind ?? 'scene'] || b.s.duration - a.s.duration);
  const drop = new Set<number>();
  let total = sum(shots);
  for (const { s, i } of order) {
    if (total <= maxSec) break;
    if ((s.impact ?? 5) >= 8 && total <= maxSec * 1.5) break;
    drop.add(i);
    total -= s.duration;
  }
  let kept = shots.filter((_, i) => !drop.has(i));
  total = sum(kept);
  if (total > maxSec) {
    const k = maxSec / total;
    kept = kept.map((s) => ({ ...s, duration: Math.max(1.2, Math.round(s.duration * k * 10) / 10) }));
  }
  return { shots: kept, removed: drop.size };
}

/** Muda quando o prompt/regras da edição mudam, para não reaproveitar progresso antigo incompatível. */
const EDIT_CK_VERSION = 'edit-v14'; // v9: recortes vêm dos quadros da leitura das páginas (page-notes), edição só com texto

/** Páginas por chamada da edição (só texto): provedor grátis / Claude. */
const EDIT_PAGES = 4;
const EDIT_PAGES_CLAUDE = 8;

/**
 * Quadro com poucos pixels: para cobrir a altura da tela (ou a largura, se for mais largo que 16:9) seria ampliado mais de 2,5x.
 * A edição não vê a imagem nem mede nada: recebe só a marca "pequeno" e deixa esse quadro por último.
 */
export function isSmallSource(pg: Pick<StudioPage, 'width' | 'height'>, r: Shot['focus'], screen = { w: 1920, h: 1080 }): boolean {
  const w = (r.x1 - r.x0) * pg.width, h = (r.y1 - r.y0) * pg.height;
  return Math.min(screen.w / Math.max(1, w), screen.h / Math.max(1, h)) > 2.5;
}

/** Formato do quadro em palavras (a edição não vê a imagem). */
function shape(pg: StudioPage, r: Shot['focus']): string {
  const w = (r.x1 - r.x0) * pg.width, h = (r.y1 - r.y0) * pg.height;
  const a = w / h;
  return a > 1.4 ? 'largo' : a < 0.7 ? (a < 0.45 ? 'muito alto' : 'alto') : 'quase quadrado';
}

/** Leitura de uma página como texto para a edição: acontecimentos, falas, roteiro e quadros numerados. */
function pageBlock(pg: StudioPage, n: number, total: number, note: PageNote, script?: string): string {
  const panels = note.panels.map(
    (q, k) =>
      `  ${k + 1}. ${q.what || '(sem descrição)'} [${q.kind}, impacto ${q.impact}, ${shape(pg, q.box)}${q.rotate ? ', desenhado de lado' : ''}${q.focus ? ', close disponível' : ''}${isSmallSource(pg, q.box) ? ', pequeno' : ''}${q.box.y1 - q.box.y0 > maxHeightFrac(q.box, pg) * 1.02 ? ', ALTO: prefira outro quadro; este vira cortes rápidos' : ''}]`,
  );
  return [
    `PÁGINA ${n} (de ${total}, ${pg.chapter})`,
    note.events && `Acontece: ${note.events}`,
    note.dialogue && `Falas: ${note.dialogue}`,
    script && `ROTEIRO NARRADO: "${script.slice(0, 900)}"`,
    panels.length ? `Quadros:\n${panels.join('\n')}` : 'Quadros: nenhum com conteúdo (página sem história)',
  ]
    .filter(Boolean)
    .join('\n');
}

interface PlanShot extends RawShot {
  panel?: number;
  close?: boolean;
}

export async function autoEdit(projectId: string, ctx: JobCtx): Promise<string> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  // Páginas: as que já estão na linha do tempo (na ordem), ou todas se ela estiver vazia.
  const locked = lockedSet(p); // capítulos prontos: a edição só trabalha nas páginas novas
  const ids = (p.shots.length ? [...new Set(p.shots.map((s) => s.pageId))] : p.pages.map((pg) => pg.id)).filter((x) => !locked.has(x));
  const pageById = new Map(p.pages.map((pg) => [pg.id, pg]));
  const pages = ids.map((id) => pageById.get(id)).filter((pg): pg is StudioPage => !!pg);
  if (!pages.length && locked.size) return 'Nenhum capítulo novo para editar: os capítulos prontos estão protegidos';
  if (!pages.length) throw new Error('Importe páginas antes de editar');

  const llm = jobLLM(ctx);
  const { w, h } = MANGA_SIZES[p.format];
  const voice = p.narration !== 'text'; // voz da IA ou a sua: texto no tamanho da fala
  const sub = (a: number, b: number): JobCtx => ({ ...ctx, progress: (x, m) => ctx.progress(a + x * (b - a), m) });

  // 1) leitura das páginas (a única etapa que vê imagens; com cache em disco)
  const notes = await ensurePageNotes(p, pages, llm, sub(0, 0.5));
  ctx.log(`Edição pela IA: ${pages.length} páginas, só texto, várias páginas por chamada`);
  // propaganda da scan (Support Us, Discord, Ko-fi, anúncios): tirada dos quadros ANTES da IA escolher, medida nos pixels
  const adsOf = new Map<string, AdRange[]>();
  let adPages = 0;
  for (const pg of pages) {
    const note = notes[pg.id];
    const ads = await findPromo(path.join(projectDir(p.id), pg.file), pg);
    adsOf.set(pg.id, ads);
    if (!note || !ads.length) continue;
    adPages++;
    const keep = [];
    for (const q of note.panels) {
      const box = avoidAds(q.box, ads);
      if (!box) continue;
      keep.push({ ...q, box, focus: q.focus ? avoidAds(q.focus, ads) ?? undefined : undefined });
    }
    notes[pg.id] = { ...note, panels: keep };
  }
  if (adPages) ctx.log(`Propaganda da scan achada em ${adPages} página(s): ficou fora dos recortes`);

  const memory = seriesPrompt(p, 800) + learningPrompt(7500) + cutsPrompt(p) + skillsPrompt('cortador') + skillsPrompt('montador');
  const budget = videoBudget(p, pages);
  const secPerPage = budget / pages.length;
  const capped = Number.isFinite(budget);
  ctx.log(capped ? `Duração-alvo: até ${Math.round(budget / 60)} min · ~${secPerPage.toFixed(1)} s por página` : 'Duração automática: sem teto por capítulo, a IA decide pela relevância de cada um');
  const result = new Map<string, Shot[]>();
  const failed: number[] = [];
  // continuação: a edição já começa sabendo o que aconteceu no último capítulo pronto
  const lastDone = locked.size ? p.pages.filter((pg) => locked.has(pg.id)).at(-1)?.chapter : undefined;
  let story = lastDone ? p.chapterContexts?.[lastDone] ?? '' : '';
  // roteiro (se já foi gerado): o que vai ser narrado em cada página guia o que mostrar
  const script: Record<string, string> = { ...p.pageScript };
  for (const s of p.shots) if (s.text && !p.pageScript?.[s.pageId]) script[s.pageId] = script[s.pageId] ? `${script[s.pageId]} ${s.text}` : s.text;
  // roteiro já escrito (passo 1): página sem narração no roteiro está FORA do resumo (capítulo pulado/sem relevância)
  if (Object.keys(script).length) for (const pg of pages) if (!script[pg.id]) script[pg.id] = '(sem narração: o roteiro não usa esta página; devolva "shots": [])';
  if (Object.keys(script).length) ctx.log(`Usando o roteiro de ${Object.keys(script).length} página(s) como guia do que focar`);
  // páginas já editadas antes de uma interrupção (progresso salvo): reaproveita sem gastar IA
  const done = loadCheckpoint<{ shots: Shot[]; summary?: string }>(projectId, 'edit', EDIT_CK_VERSION);
  const reused = pages.filter((pg) => done.has(pg.id)).length;
  if (reused) ctx.log(`Retomando: ${reused} página(s) já editadas antes foram reaproveitadas`);
  const fixed =
    `${memory}${p.context ? `Contexto da obra: ${p.context.slice(0, 2000)}\n` : ''}` +
    `Tela do vídeo: ${w}x${h} (${p.format}). Modo de narração: ${voice ? 'voz' : 'texto'}. ` +
    `${capped ? `Orçamento de tempo: o vídeo inteiro tem no máximo ${Math.round(budget / 60)} min para ${pages.length} páginas; cada página tem cerca de ${Math.max(1, Math.round(secPerPage))} s em média. ${budgetHint(secPerPage)}` : 'SEM teto de duração: o tempo de cada página é o que o roteiro pede. Páginas de capítulos importantes (apresentação, origem, poder, explicações) mostram tudo o que o capítulo traz; o que o roteiro não cita fica fora.'} Dê "impact" alto (8-10) só ao que é realmente marcante.
`;
  const system = `${EDIT_SYSTEM}\n\n${fixed}`;
  let calls = 0;
  let stop = false;
  for (let i = 0; i < pages.length && !stop; ) {
    if (ctx.signal?.aborted) throw new Error('cancelado');
    const pg0 = pages[i];
    const saved = done.get(pg0.id);
    if (saved) {
      result.set(pg0.id, withSpeech(saved.shots));
      if (saved.summary) story += ' ' + saved.summary;
      i++;
      continue;
    }
    // página sem leitura (a leitura falhou): fica como estava; rodar de novo tenta ler outra vez
    if (!notes[pg0.id]) {
      failed.push(i + 1);
      ctx.log(`Página ${i + 1}: sem leitura da imagem; mantida como estava`);
      i++;
      continue;
    }
    // lote: páginas seguidas, ainda não editadas, com leitura (mais por chamada quando a IA atual é o Claude)
    const size = isClaude(llm) ? EDIT_PAGES_CLAUDE : EDIT_PAGES;
    const batch: { pg: StudioPage; n: number }[] = [];
    while (i < pages.length && batch.length < size && !done.has(pages[i].id) && notes[pages[i].id]) batch.push({ pg: pages[i], n: ++i });
    ctx.progress(0.5 + (i / pages.length) * 0.5, `Editando páginas ${batch[0].n}–${batch.at(-1)!.n} de ${pages.length}`);
    try {
      // JSON cortado/quebrado (o modelo às vezes gasta o limite raciocinando): uma segunda tentativa com mais espaço
      type Plan = { pages?: { page?: number; shots?: PlanShot[]; summary?: string }[] };
      let out: Plan | null = null;
      for (let attempt = 1; !out; attempt++) {
        calls++;
        const raw = await llm.complete({
          // parte fixa do job (regras aprendidas, habilidades, obra, orçamento) no SYSTEM: é igual em todas as chamadas,
          // então o provedor guarda em cache em vez de cobrar ~6 mil tokens de novo a cada lote de páginas
          system,
          prompt:
            `${p.chapterContexts?.[batch[0].pg.chapter] ? `Resumo do capítulo: ${p.chapterContexts[batch[0].pg.chapter]}\n` : ''}${story ? `História até aqui: ${story.slice(-1200)}\n` : ''}\n` +
            batch.map(({ pg, n }) => pageBlock(pg, n, pages.length, notes[pg.id], script[pg.id])).join('\n\n'),
          maxTokens: (600 + batch.length * 700) * attempt,
          temperature: 0.5,
          tier: 'small', // escolha do usuario: Haiku na edicao; Sonnet so no aprendizado
          signal: ctx.signal,
        });
        try {
          const j = extractJson(raw) as { pages?: unknown; shots?: PlanShot[]; summary?: string };
          // uma página só às vezes volta no formato antigo {"shots":[...]}
          out = Array.isArray(j.pages) ? (j as Plan) : batch.length === 1 && Array.isArray(j.shots) ? { pages: [{ page: batch[0].n, shots: j.shots, summary: j.summary }] } : null;
          if (!out) throw new Error('resposta sem "pages"');
        } catch (err) {
          if (attempt >= 3) throw err;
          ctx.log(`Páginas ${batch[0].n}–${batch.at(-1)!.n}: resposta inválida, tentando de novo`);
        }
      }
      for (const [k, { pg, n }] of batch.entries()) {
        const got = out.pages!.find((x) => Number(x?.page) === n) ?? (out.pages!.length === batch.length ? out.pages![k] : undefined);
        if (!got) {
          failed.push(n);
          ctx.log(`Página ${n}: a IA não devolveu; mantida como estava`);
          continue;
        }
        const note = notes[pg.id];
        // quadro escolhido → caixa da leitura (ou o close), giro do quadro
        const raws: RawShot[] = [];
        for (const s of Array.isArray(got.shots) ? got.shots : []) {
          const q = note.panels[Number(s?.panel) - 1];
          if (!q) continue;
          const b = s.close && q.focus ? q.focus : q.box;
          raws.push({ ...s, box: [b.x0, b.y0, b.x1, b.y1], rotate: q.rotate, kind: s.kind ?? q.kind, impact: s.impact ?? q.impact });
        }
        const shots = toShots(pg, raws, voice, w / h);
        const img = path.join(projectDir(p.id), pg.file);
        const ads = adsOf.get(pg.id) ?? [];
        for (const sh of shots) {
          sh.focus = await trimBorders(img, pg, sh.focus); // a caixa da leitura vale como foi desenhada: sem encaixe em blocos de pixel
          sh.focus = avoidAds(sh.focus, ads) ?? sh.focus;
        }
        // recorte que ficou todo dentro de propaganda: sai, e o texto vai para o vizinho
        const clean = shots.filter((sh) => !ads.length || avoidAds(sh.focus, ads));
        if (clean.length < shots.length) {
          const lost = shots.filter((sh) => !clean.includes(sh)).map((sh) => sh.text).filter(Boolean).join(' ');
          if (lost && clean.length) clean[clean.length - 1].text = `${clean[clean.length - 1].text} ${lost}`.trim();
          shots.splice(0, shots.length, ...clean);
        }
        // duas caixas da IA que caíram no mesmo bloco: fica um recorte só, com o texto dos dois
        for (let a = 0; a < shots.length; a++) {
          for (let b = a + 1; b < shots.length; b++) {
            const A = shots[a].focus, B = shots[b].focus;
            if (Math.abs(A.y0 - B.y0) < 0.01 && Math.abs(A.y1 - B.y1) < 0.01) {
              shots[a].text = `${shots[a].text} ${shots[b].text}`.trim();
              shots[a].duration = Math.round((shots[a].duration + shots[b].duration) * 10) / 10;
              shots.splice(b, 1);
              b--;
            }
          }
        }
        const splitRaw: Shot[] = [];
        for (const sh of shots) splitRaw.push(...(await splitTall(img, pg, sh, voice, w / h)));
        // regra fixa: só entra imagem que dá para ver (nada vazio, nada fino demais)
        const lg = await keepLegible(img, pg, splitRaw, w / h);
        if (lg.dropped) ctx.log(`Página ${n}: ${lg.dropped} recorte(s) vazios ou estreitos demais saíram (o texto foi para o recorte vizinho)`);
        // trava de qualidade: tira zoom/esticar que deixam o recorte borrado (ampliação máxima 1,5x)
        const split = lg.shots.map((s) => softenShot(s, pg, { w, h }));
        for (const sh of split) sh.bgBand = await pickBgBand(img, pg, sh);
        if (split.length > shots.length) ctx.log(`Página ${n}: quadros altos divididos em cortes rápidos (${shots.length} → ${split.length})`);
        const spoken = withSpeech(split);
        if (spoken.length < split.length) ctx.log(`Página ${n}: ${split.length - spoken.length} recorte(s) sem fala viraram imagens extras durante a fala vizinha`);
        result.set(pg.id, spoken);
        if (got.summary) story += ' ' + got.summary;
        saveCheckpoint(projectId, 'edit', EDIT_CK_VERSION, pg.id, { shots: spoken, summary: got.summary });
        ctx.log(`Página ${n} [${llm.name}: ${llm.name === 'claude-code' ? 'haiku' : llm.model}]: ${spoken.length ? `${spoken.length} recorte(s) (${spoken.map((s) => s.kind).join(', ')})` : 'pulada (sem conteúdo relevante)'}`);
      }
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      failed.push(...batch.map((x) => x.n));
      ctx.log(`Páginas ${batch[0].n}–${batch.at(-1)!.n}: falhou (${(e as Error).message.slice(0, 200)}); mantidas como estavam`);
      // limite do plano/cota: as próximas também falhariam — para aqui (o feito fica salvo para retomar)
      if (/limite|limit|quota|cota|429/i.test((e as Error).message)) {
        for (let k = i + 1; k <= pages.length; k++) failed.push(k);
        ctx.log(`Limite da IA atingido: parei na página ${batch[0].n}. Rode "Editar com IA" de novo depois — as páginas já feitas são reaproveitadas.`);
        stop = true;
      }
    }
  }

  // Página que a IA não editou (falha, limite, JSON quebrado): NUNCA fica a tira inteira. Usa os quadros da leitura
  // (sem IA, texto vazio: a narração escreve depois) e, sem eles, passa a imagem antiga pela trava de legibilidade.
  const before = readProject(projectId);
  for (const pg of pages) {
    if (result.has(pg.id)) continue;
    const img = path.join(projectDir(projectId), pg.file);
    const ads = adsOf.get(pg.id) ?? [];
    const note = notes[pg.id];
    let shots: Shot[] = [];
    const panels = (note?.panels ?? []).filter((q) => q.impact >= 4).slice(0, 8);
    if (panels.length) {
      const raws: RawShot[] = panels.map((q) => ({ box: [q.box.x0, q.box.y0, q.box.x1, q.box.y1], rotate: q.rotate, kind: q.kind, impact: q.impact, fit: 'contain', text: '' }));
      shots = toShots(pg, raws, voice, w / h);
      for (const sh of shots) {
        sh.focus = await trimBorders(img, pg, sh.focus);
        sh.focus = avoidAds(sh.focus, ads) ?? sh.focus;
      }
      shots = shots.filter((sh) => !ads.length || avoidAds(sh.focus, ads));
      ctx.log(`Página ${pages.indexOf(pg) + 1}: sem edição da IA; recortes feitos direto dos quadros da leitura (${shots.length})`);
    } else {
      shots = (before?.shots ?? []).filter((s) => s.pageId === pg.id);
    }
    shots = (await legibleOrSplit(img, pg, shots, voice, w / h)).map((s) => softenShot(s, pg, { w, h }));
    for (const sh of shots) sh.bgBand = await pickBgBand(img, pg, sh);
    result.set(pg.id, shots);
  }

  let total = 0;
  let budgetNote = '';
  updateProject(projectId, (cur) => {
    const next: Shot[] = [];
    for (const pg of pages) {
      const shots = result.get(pg.id);
      // falhou: mantém o que já havia para essa página
      next.push(...(shots ?? cur.shots.filter((s) => s.pageId === pg.id)));
    }
    const maxSec = budget;
    const before = next.reduce((n, s) => n + s.duration, 0);
    const keep = cur.shots.filter((s) => locked.has(s.pageId));
    const fitted = fitBudget(next, Math.max(1, maxSec - keep.reduce((n, s) => n + s.duration, 0)));
    if (before > maxSec) budgetNote = `; cortado de ${Math.round(before / 60)} para ${Math.round(maxSec / 60)} min (${fitted.removed} parte(s) de menos impacto fora)`;
    const rep = dedupeNarration(fitted.shots);
    if (rep) budgetNote += `; ${rep} início(s) de fala que repetiam o fim da anterior foram corrigidos`;
    total = fitted.shots.length;
    cur.shots = [...keep, ...fitted.shots];
    // o roteiro (passo 1) já existe: a edição só reparte o texto nos recortes; o roteiro por página é refeito a partir deles
    const byPage: Record<string, string> = Object.fromEntries(Object.entries(cur.pageScript ?? {}).filter(([id]) => locked.has(id)));
    for (const s of fitted.shots) if (s.text) byPage[s.pageId] = byPage[s.pageId] ? `${byPage[s.pageId]} ${s.text}` : s.text;
    cur.pageScript = byPage;
  });
  // com falhas, guarda o progresso: rodar de novo só refaz as páginas que faltaram
  if (!failed.length) clearCheckpoint(projectId, 'edit'); // resultado aplicado à linha do tempo
  ctx.log(llm.report());
  const fails = [...new Set(failed)].sort((a, b) => a - b);
  // seu estilo de recorte (regras aprendidas) + dúvidas para o modal de Processos
  let styleNote = '';
  try {
    const { restyleProject } = await import('./restyle');
    styleNote = ` · ${await restyleProject(projectId, ctx, {})}`;
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    ctx.log(`Estilo de recorte não aplicado (${(e as Error).message.slice(0, 120)})`);
  }
  return `Edição pronta: ${total} partes de ${pages.length} páginas · ${calls} chamada(s) de edição${budgetNote}${fails.length ? `; faltaram ${fails.length} página(s) (${fails[0]}–${fails[fails.length - 1]}): rode de novo para completar` : ''}${styleNote}`;
}
