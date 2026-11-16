// REGRAS FIXAS dos recortes (combinadas com o usuário), garantidas no FIM de cada passo que mexe neles:
//  0) SÓ A ARTE: balão de fala, caixa de texto e área branca lisa nas bordas do recorte saem (o foco é a imagem; a
//     narração já diz o texto). Só ficam se não sobrar mais nada para mostrar.
//  1) VERTICAL: o recorte cobre a altura inteira da tela, colado em cima e embaixo (nunca zoom < 1, nunca mais largo
//     que 16:9: se sobrar largura, corta as laterais; só abre para cima e para baixo se faltar muito).
//  2) HORIZONTAL: o recorte ocupa pelo menos 40% da largura da tela (meta) e NUNCA menos de 30% (zero exceções).
//     Esticar até 1,4x ajuda; se não bastar, o quadro alto vira UMA JANELA dele (altura ≈ 1,6x a largura) no trecho
//     mais forte (arte e ação, sem balão), com as bordas caindo em linhas calmas para não cortar rosto ou tronco de
//     forma brusca; só em último caso estica até 1,9x.
// Só geometria e uma leitura em tons de cinza feita pelo FFmpeg: não gasta IA. Não mexe em páginas protegidas, em
// recortes girados nem em tela cheia. O piso vale também para ajustes à mão: zero exceções.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runFfmpeg } from '@clipper/video-processing';
import { cropPx } from './camera';
import { cropMetrics, QUALITY } from './crop-quality';
import { lockedSet } from './lock';
import { projectDir, readProject, updateProject } from './store';
import type { JobCtx } from './jobs';
import type { Rect, Shot, StudioPage } from './types';

const SW = 120; // largura da leitura em cinza
const TARGET = QUALITY.minArea + 0.015; // meta (40% + folga)
const FILL = 9 / 16; // altura/largura de uma tela 16:9: abaixo disso o recorte não cobriria a altura

/** Ajustes da limpeza de balão/branco (calibrados contra os cortes do usuário: scripts/crop-eval.ts). */
export const TRIM = {
  /** pixel "claro" (papel do balão, branco liso). */
  bright: 245,
  /** linha de balão/branco: fração de pixels claros da linha (IoU 0,58 → 0,74 contra os cortes do usuário). */
  rowFrac: 0.45,
  /** coluna de branco liso nas laterais. */
  colFrac: 0.7,
  /** no máximo isto da altura/largura sai por borda. */
  maxEdge: 0.45,
  /** sempre sobra pelo menos isto da altura original. */
  keep: 0.3,
};

export interface Enforced { focus: Rect; stretch: number; zoom: number; changed: boolean }

export interface Rows { px: Buffer; SH: number; mean: number[]; dev: number[]; bright: number[] }

export async function grayRows(img: string, page: StudioPage, focus: Rect): Promise<Rows | null> {
  const c = cropPx(focus, page.width, page.height);
  const SH = Math.max(8, Math.round((c.h / c.w) * SW));
  const raw = path.join(os.tmpdir(), `manga-enf-${randomUUID().slice(0, 8)}.gray`);
  try {
    await runFfmpeg(['-y', '-i', img, '-vf', `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${SW}:${SH},format=gray`, '-f', 'rawvideo', '-frames:v', '1', raw]);
    const px = fs.readFileSync(raw);
    if (px.length < SW * SH) return null;
    const dev: number[] = [], mean: number[] = [], bright: number[] = [];
    for (let y = 0; y < SH; y++) {
      let s = 0, b = 0;
      for (let x = 0; x < SW; x++) {
        const v = px[y * SW + x];
        s += v;
        if (v > TRIM.bright) b++;
      }
      const m = s / SW;
      let v2 = 0;
      for (let x = 0; x < SW; x++) v2 += (px[y * SW + x] - m) ** 2;
      mean.push(m);
      dev.push(Math.sqrt(v2 / SW));
      bright.push(b / SW);
    }
    return { px, SH, mean, dev, bright };
  } catch {
    return null;
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

const textRow = (r: Rows, i: number) => r.bright[i] >= TRIM.rowFrac;
const colBrightFrac = (r: Rows, x: number) => {
  let b = 0;
  for (let y = 0; y < r.SH; y++) if (r.px[y * SW + x] > TRIM.bright) b++;
  return b / r.SH;
};

/** Ajustes do detector 2D (blocos de 4x4 px na leitura em cinza). */
export const TRIM2 = {
  /** bloco "papel de balão": claro e pouco texturizado (o texto dentro vira ruído que o fechamento cobre). */
  cream: 242,
  creamDev: 40,
  /** bloco liso e claro (branco, rosa/lilás esmaecido): nunca é arte. */
  flatDev: 7,
  flatMean: 225,
  /** raio do fechamento (junta o texto de dentro do balão ao papel). */
  close: 1,
  /** mancha clara só conta como balão/branco se ocupar pelo menos isto do recorte. */
  minComp: 0.012,
  /** peso de cada bloco de balão/branco que ficaria dentro do recorte, contra cada bloco de arte. */
  penalty: 3,
  maxEdge: 0.45,
  /** sempre sobra pelo menos isto da área. */
  keepArea: 0.35,
  /** o que é cortado precisa ser pelo menos esta fração de balão/branco (confiança). */
  minDensity: 0.8,
};
const BS = 4;

function morph(src: Uint8Array, bw: number, bh: number, k: number, dilate: boolean): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let hit = dilate ? 0 : 1;
      for (let dy = -k; dy <= k && (dilate ? !hit : hit); dy++) {
        for (let dx = -k; dx <= k; dx++) {
          const yy = y + dy, xx = x + dx;
          const v = yy < 0 || yy >= bh || xx < 0 || xx >= bw ? (dilate ? 0 : 1) : src[yy * bw + xx];
          if (dilate && v) { hit = 1; break; }
          if (!dilate && !v) { hit = 0; break; }
        }
      }
      out[y * bw + x] = hit;
    }
  }
  return out;
}

/**
 * Detector 2D: marca como "não arte" as manchas claras que parecem balão/caixa de texto (papel + texto dentro) e
 * as áreas lisas e claras (branco, rosa/lilás esmaecido) e escolhe o retângulo (cortando cada lado até 45%) que
 * mais tem arte e menos tem isso. Pega balão de canto, balão oval e fundo pálido que as faixas inteiras não pegavam.
 */
export function trimToArt2(r: Rows, f: Rect): Rect {
  const bw = Math.floor(SW / BS), bh = Math.floor(r.SH / BS);
  if (bh < 4) return f;
  const base = new Uint8Array(bw * bh), flat = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let s = 0, s2 = 0;
      for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) { const v = r.px[(by * BS + y) * SW + bx * BS + x]; s += v; s2 += v * v; }
      const n = BS * BS, m = s / n, d = Math.sqrt(Math.max(0, s2 / n - m * m));
      const i = by * bw + bx;
      if (m >= TRIM2.cream && d <= TRIM2.creamDev) base[i] = 1;
      if (d <= TRIM2.flatDev && m >= TRIM2.flatMean) { flat[i] = 1; base[i] = 1; }
    }
  }
  const closed = morph(morph(base, bw, bh, TRIM2.close, true), bw, bh, TRIM2.close, false);
  // manchas (4-conexas) grandes o bastante viram "não arte"; áreas lisas e claras sempre
  const non = new Uint8Array(bw * bh);
  const seen = new Uint8Array(bw * bh);
  const minBlocks = Math.max(3, Math.round(TRIM2.minComp * bw * bh));
  for (let i0 = 0; i0 < closed.length; i0++) {
    if (!closed[i0] || seen[i0]) continue;
    const comp: number[] = [], stack = [i0];
    seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % bw, y = (i - x) / bw;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
        const j = yy * bw + xx;
        if (closed[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (comp.length >= minBlocks) for (const i of comp) non[i] = 1;
  }
  for (let i = 0; i < non.length; i++) if (flat[i]) non[i] = 1;
  // imagem integral da "não arte"
  const I = new Int32Array((bw + 1) * (bh + 1));
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) I[(y + 1) * (bw + 1) + x + 1] = non[y * bw + x] + I[y * (bw + 1) + x + 1] + I[(y + 1) * (bw + 1) + x] - I[y * (bw + 1) + x];
  const sum = (x0: number, y0: number, x1: number, y1: number) => I[y1 * (bw + 1) + x1] - I[y0 * (bw + 1) + x1] - I[y1 * (bw + 1) + x0] + I[y0 * (bw + 1) + x0];
  const total = bw * bh;
  if (sum(0, 0, bw, bh) / total > 0.85) return f; // quase tudo é balão/branco: deixa como está
  const score = (x0: number, y0: number, x1: number, y1: number) => {
    const area = (x1 - x0) * (y1 - y0), nA = sum(x0, y0, x1, y1);
    return area - nA - TRIM2.penalty * nA;
  };
  let best = { t: 0, b: 0, l: 0, r: 0, sc: score(0, 0, bw, bh) };
  const s0 = best.sc;
  const mT = Math.floor(bh * TRIM2.maxEdge), mL = Math.floor(bw * TRIM2.maxEdge);
  for (let t = 0; t <= mT; t++) for (let b = 0; b <= mT; b++) {
    if (t + b >= bh) continue;
    for (let l = 0; l <= mL; l++) for (let rr = 0; rr <= mL; rr++) {
      const w2 = bw - l - rr, h2 = bh - t - b;
      if (w2 < 2 || (w2 * h2) / total < TRIM2.keepArea) continue;
      const sc = score(l, t, bw - rr, bh - b) - 0.02 * (t + b + l + rr);
      if (sc > best.sc) best = { t, b, l, r: rr, sc };
    }
  }
  if (best.sc <= s0 + 0.5) return f;
  // só corta com confiança: o que sai tem que ser quase todo balão/branco (senão estaria cortando arte)
  const removed = total - (bw - best.l - best.r) * (bh - best.t - best.b);
  const removedNon = sum(0, 0, bw, bh) - sum(best.l, best.t, bw - best.r, bh - best.b);
  if (removed <= 0 || removedNon / removed < TRIM2.minDensity) return f;
  const h = f.y1 - f.y0, w = f.x1 - f.x0;
  return { x0: f.x0 + ((best.l * BS) / SW) * w, x1: f.x1 - ((best.r * BS) / SW) * w, y0: f.y0 + ((best.t * BS) / r.SH) * h, y1: f.y1 - ((best.b * BS) / r.SH) * h };
}

/** Versão 1: tira balão/caixa de texto/branco liso das bordas, só faixas inteiras (cima, baixo, laterais). */
export function trimToArtV1(r: Rows, f: Rect): Rect {
  const h = f.y1 - f.y0, w = f.x1 - f.x0;
  const maxRows = Math.floor(r.SH * TRIM.maxEdge);
  let top = 0;
  while (top < maxRows && textRow(r, top)) top++;
  let bot = 0;
  while (bot < maxRows && textRow(r, r.SH - 1 - bot)) bot++;
  if ((r.SH - top - bot) / r.SH < TRIM.keep) { top = 0; bot = 0; } // quase tudo é texto: deixa como está
  const maxCols = Math.floor(SW * TRIM.maxEdge);
  let left = 0;
  while (left < maxCols && colBrightFrac(r, left) >= TRIM.colFrac) left++;
  let right = 0;
  while (right < maxCols && colBrightFrac(r, SW - 1 - right) >= TRIM.colFrac) right++;
  if ((SW - left - right) / SW < TRIM.keep) { left = 0; right = 0; }
  return { x0: f.x0 + (left / SW) * w, x1: f.x1 - (right / SW) * w, y0: f.y0 + (top / r.SH) * h, y1: f.y1 - (bot / r.SH) * h };
}

/** Limpeza usada no fluxo: o detector 2D (balão de canto, oval, fundo pálido). */
export const trimToArt = trimToArt2;

/** Nota de uma janela [i0, i0+n): arte e ação (traço) valem; balão/fundo branco liso atrapalha; borda em cima de traço também. */
function windowScore(r: Rows, i0: number, n: number): number {
  let art = 0, text = 0;
  for (let i = i0; i < i0 + n; i++) {
    if (textRow(r, i)) text++;
    else art += Math.min(r.dev[i], 60) / 60;
  }
  const edge = (a: number, b: number) => {
    let t = 0;
    for (let i = a; i < b; i++) t += Math.min(r.dev[i], 60) / 60;
    return t / Math.max(1, b - a);
  };
  const top = edge(i0, Math.min(i0 + 3, i0 + n)), bot = edge(Math.max(i0, i0 + n - 3), i0 + n);
  return art - 1.0 * text - 0.3 * n * (top + bot);
}

const pxOf = (f: Rect, page: StudioPage) => ({ w: (f.x1 - f.x0) * page.width, h: (f.y1 - f.y0) * page.height });
const ratioEff = (f: Rect, page: StudioPage, s: number) => { const c = pxOf(f, page); return c.h / (c.w * s); };

/** Menor esticar (1..max) que leva o recorte à meta, ou null se nem o máximo basta. */
function stretchFor(f: Rect, page: StudioPage, max: number): number | null {
  for (let s = 1; s <= max + 1e-9; s += 0.05) {
    if (ratioEff(f, page, s) >= FILL && cropMetrics(f, page, { stretch: s, zoom: 1 }).area >= TARGET) return Math.round(s * 100) / 100;
  }
  return null;
}

/** Abre a janela para cima e para baixo até ter a proporção pedida (altura/largura), sem sair da página. */
function expandTo(f: Rect, page: StudioPage, ratio: number): Rect {
  const need = Math.min(1, (ratio * (f.x1 - f.x0) * page.width) / page.height);
  const cy = (f.y0 + f.y1) / 2;
  let y0 = cy - need / 2, y1 = y0 + need;
  if (y0 < 0) { y1 -= y0; y0 = 0; }
  if (y1 > 1) { y0 -= y1 - 1; y1 = 1; }
  return { ...f, y0: Math.max(0, y0), y1: Math.min(1, y1) };
}

/** Corta as laterais até o recorte ter formato de tela (a faixa de maior traço fica). */
function narrowTo(r: Rows | null, f: Rect, page: StudioPage, ratio: number): Rect {
  const { w, h } = pxOf(f, page);
  const needW = h / ratio;
  const frac = Math.min(1, needW / w);
  if (frac >= 1) return f;
  const span = Math.max(4, Math.round(frac * SW));
  let x0 = Math.round((SW - span) / 2);
  if (r && SW > span) {
    let best = -Infinity;
    for (let x = 0; x + span <= SW; x += 2) {
      let sc = 0;
      for (let k = x; k < x + span; k++) {
        let s = 0, s2 = 0;
        for (let y = 0; y < r.SH; y++) { const v = r.px[y * SW + k]; s += v; s2 += v * v; }
        const m = s / r.SH;
        sc += Math.min(Math.sqrt(Math.max(0, s2 / r.SH - m * m)), 60) / 60;
      }
      if (sc > best) (best = sc), (x0 = x);
    }
  }
  const fw = f.x1 - f.x0;
  return { ...f, x0: f.x0 + (x0 / SW) * fw, x1: f.x0 + ((x0 + span) / SW) * fw };
}

export async function enforceFocus(img: string, page: StudioPage, focus: Rect, cur: { stretch?: number; zoom?: number } = {}): Promise<Enforced> {
  const zoom0 = cur.zoom ?? 1;
  let f = focus;
  let stretch = cur.stretch ?? 1;
  let changed = zoom0 < 1; // zoom < 1 deixa o recorte solto no meio da tela: volta a 1
  // 0) só a arte: balão, caixa de texto e branco liso das bordas saem
  let rows = await grayRows(img, page, f);
  if (rows) {
    const t = trimToArt(rows, f);
    if (Math.abs(t.y0 - f.y0) + Math.abs(t.y1 - f.y1) + Math.abs(t.x0 - f.x0) + Math.abs(t.x1 - f.x1) > 0.004) {
      f = t;
      changed = true;
      rows = await grayRows(img, page, f);
    }
  }
  // 1) vertical: cobre a altura da tela (recorte nunca mais largo que 16:9)
  if (ratioEff(f, page, stretch) < FILL - 0.005) {
    if (stretch > 1) { stretch = 1; changed = true; }
    if (ratioEff(f, page, 1) < FILL - 0.005) {
      const { w, h } = pxOf(f, page);
      if (h / FILL >= w * 0.65) f = narrowTo(rows, f, page, FILL); // perde até 35% da largura
      else f = expandTo(f, page, FILL); // faixa muito baixa e larga: abre a cena
      changed = true;
    }
  }
  // 2) horizontal: pelo menos a meta (40% da tela); nunca menos de 30%
  const areaOf = (r: Rect, s: number) => cropMetrics(r, page, { stretch: s, zoom: 1 }).area;
  if (areaOf(f, stretch) >= TARGET) return { focus: f, stretch, zoom: 1, changed };
  const s1 = stretchFor(f, page, QUALITY.softStretch);
  if (s1 !== null) return { focus: f, stretch: Math.max(stretch, s1), zoom: 1, changed: true };
  // 3) janela do próprio quadro, no trecho mais forte; janelas cada vez mais "em pé largo" até caber
  if (!rows) rows = await grayRows(img, page, f);
  const total = f.y1 - f.y0;
  const SH = rows?.SH ?? 100;
  const { w: wpx, h: hpx } = pxOf(f, page);
  let last: { f: Rect; s: number } | null = null;
  for (const R of [QUALITY.windowTall, 1.45, 1.3, 1.15, 1.0]) {
    const winPx = R * wpx;
    if (hpx <= winPx * 1.02) continue; // já é mais baixo que a janela
    const n = Math.max(4, Math.round((winPx / hpx) * SH));
    let i0 = 0;
    if (rows && SH > n) {
      let bestSc = -Infinity;
      const step = Math.max(1, Math.round(n * 0.06));
      for (let i = 0; i + n <= SH; i += step) {
        const sc = windowScore(rows, i, n);
        if (sc > bestSc) (bestSc = sc), (i0 = i);
      }
    }
    const y0 = f.y0 + (i0 / SH) * total;
    const win: Rect = { x0: f.x0, x1: f.x1, y0, y1: Math.min(f.y1, y0 + (n / SH) * total) };
    const s = stretchFor(win, page, QUALITY.softStretch);
    if (s !== null) return { focus: win, stretch: s, zoom: 1, changed: true };
    last = { f: win, s: stretchFor(win, page, QUALITY.maxStretch) ?? QUALITY.maxStretch };
  }
  // último recurso: esticar mais (até 1,9x) para nunca ficar abaixo do piso
  if (last) return { focus: last.f, stretch: last.s, zoom: 1, changed: true };
  const sMax = stretchFor(f, page, QUALITY.maxStretch) ?? QUALITY.maxStretch;
  return { focus: f, stretch: Math.max(stretch, sMax), zoom: 1, changed: true };
}

type View = Pick<Shot, 'pageId' | 'focus' | 'fit' | 'rotate' | 'stretch' | 'zoom' | 'motion' | 'bgBand'>;
const viewOf = (s: Shot): View => ({ pageId: s.pageId, focus: s.focus, fit: s.fit, rotate: s.rotate, stretch: s.stretch, zoom: s.zoom, motion: s.motion, bgBand: s.bgBand });

/** Mesmo trecho da mesma página (um contém o outro em boa parte): é "a mesma imagem em outro ângulo". */
function sameImage(a: View, b: View): boolean {
  if (a.pageId !== b.pageId) return false;
  const ix = Math.max(0, Math.min(a.focus.x1, b.focus.x1) - Math.max(a.focus.x0, b.focus.x0));
  const iy = Math.max(0, Math.min(a.focus.y1, b.focus.y1) - Math.max(a.focus.y0, b.focus.y0));
  const area = (r: Rect) => Math.max(1e-6, (r.x1 - r.x0) * (r.y1 - r.y0));
  return (ix * iy) / Math.min(area(a.focus), area(b.focus)) >= 0.55;
}

/** Quanto de arte limpa (sem balão/branco) o recorte tem, em pixels da página: o "mais completo" ganha. */
async function artArea(img: string, page: StudioPage, v: View): Promise<number> {
  const rows = await grayRows(img, page, v.focus);
  const f = rows ? trimToArt(rows, v.focus) : v.focus;
  return (f.x1 - f.x0) * page.width * (f.y1 - f.y0) * page.height;
}

/**
 * Várias imagens numa fala que são o MESMO quadro só em outro ângulo (mais perto, mais longe): fica uma só, a mais
 * completa, usada durante a fala toda. Imagens de quadros diferentes continuam na ordem.
 */
async function mergeViews(dir: string, pages: Map<string, StudioPage>, s: Shot): Promise<View[]> {
  const views = [viewOf(s), ...(s.extra ?? [])];
  if (views.length < 2) return views;
  const groups: View[][] = [];
  for (const v of views) {
    const g = groups.find((grp) => grp.some((x) => sameImage(x, v)));
    if (g) g.push(v); else groups.push([v]);
  }
  const out: View[] = [];
  for (const g of groups) {
    if (g.length === 1) { out.push(g[0]); continue; }
    let best = g[0], bestScore = -1;
    for (const v of g) {
      const pg = pages.get(v.pageId);
      if (!pg || v.rotate || v.fit === 'cover') continue;
      const sc = await artArea(path.join(dir, pg.file), pg, v);
      if (sc > bestScore) (bestScore = sc), (best = v);
    }
    out.push(best);
  }
  return out;
}

/** Roda as regras em todas as partes (e nas opções das dúvidas) do projeto. */
export async function enforceProject(projectId: string, ctx?: JobCtx): Promise<string> {
  const p = readProject(projectId);
  if (!p) return '';
  const locked = lockedSet(p);
  const pages = new Map(p.pages.map((x) => [x.id, x]));
  const dir = projectDir(projectId);
  const fixed = new Map<string, View[]>();
  let merged = 0;
  let i = 0;
  for (const s of p.shots) {
    i++;
    if (ctx && i % 25 === 0) ctx.progress(i / p.shots.length, `Limpando e dimensionando os recortes (${i}/${p.shots.length})`);
    const pg0 = pages.get(s.pageId);
    if (!pg0 || locked.has(s.pageId)) continue;
    // 1) imagens repetidas da mesma fala (mesmo quadro, ângulo parecido): fica só a mais completa
    const before = 1 + (s.extra?.length ?? 0);
    const views = await mergeViews(dir, pages, s);
    merged += before - views.length;
    // 2) cada imagem: só a arte, colada em cima e embaixo, nunca abaixo do piso
    const outViews: View[] = [];
    let any = views.length !== before;
    for (const v of views) {
      const pg = pages.get(v.pageId);
      if (!pg || v.rotate || v.fit === 'cover') { outViews.push(v); continue; }
      const r = await enforceFocus(path.join(dir, pg.file), pg, v.focus, v);
      if (r.changed) any = true;
      outViews.push({ ...v, focus: r.focus, stretch: r.stretch, zoom: Math.max(1, v.zoom ?? 1) });
    }
    if (any) fixed.set(s.id, outViews);
  }
  // opções das dúvidas: com a mesma regra (cada opção guarda o esticar que precisa)
  const optFix = new Map<string, { focus: Rect; stretch: number }[]>();
  for (const d of p.doubts ?? []) {
    const out: { focus: Rect; stretch: number }[] = [];
    for (const o of d.options) {
      const pg = pages.get(o.pageId);
      if (!pg) { out.push({ focus: o.focus, stretch: 1 }); continue; }
      const e = await enforceFocus(path.join(dir, pg.file), pg, o.focus, {});
      out.push({ focus: e.focus, stretch: e.stretch });
    }
    optFix.set(d.id, out);
  }
  let changed = 0;
  updateProject(projectId, (cur) => {
    for (const s of cur.shots) {
      const vs = fixed.get(s.id);
      if (!vs) continue;
      const [main, ...extra] = vs;
      Object.assign(s, { pageId: main.pageId, focus: main.focus, fit: main.fit, rotate: main.rotate, stretch: main.stretch, zoom: main.zoom, motion: main.motion, bgBand: main.bgBand });
      if (extra.length) s.extra = extra; else delete s.extra;
      changed++;
    }
    for (const d of cur.doubts ?? []) {
      const of = optFix.get(d.id);
      if (of) d.options.forEach((o, k) => { if (of[k]) { o.focus = of[k].focus; o.stretch = of[k].stretch; } });
    }
  });
  const msg = `Recortes limpos e dimensionados: ${changed} partes ajustadas, ${merged} imagem(ns) repetida(s) da mesma fala juntadas (só a arte, colados em cima e embaixo, nunca menos de ${Math.round(QUALITY.hardMinArea * 100)}% da tela, meta ${Math.round(QUALITY.minArea * 100)}%)`;
  ctx?.log(msg);
  return msg;
}
