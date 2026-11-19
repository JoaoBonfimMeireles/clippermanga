// Os quadros que a IA de visão marca em páginas de webtoon (uma tira comprida, quase sem molduras) costumam ter a borda de cima ou de
// baixo no meio do desenho: o recorte sai com a cabeça, o corpo ou o balão cortados. Aqui cada borda interna é encostada na faixa lisa
// (calha/fundo uniforme) mais perto, medida nos pixels, quando ela está perto o bastante. Sem faixa por perto, a borda fica como está.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runFfmpeg } from '@clipper/video-processing';
import type { PageNote } from './page-notes';
import type { Rect } from './types';
import type { StudioPage } from './types';

const SW = 120;
/** Linha "lisa": quase sem variação de tom na largura inteira (calha branca/preta, fundo uniforme). */
const FLAT_STD = 8;
/** Quanto uma borda pode andar (fração da altura da página) para encostar numa faixa lisa. */
const REACH = 0.035;

/** Quais linhas (da imagem reduzida) são lisas; null se a imagem não pôde ser lida. */
async function flatRows(file: string, pg: StudioPage): Promise<{ flat: boolean[]; H: number } | null> {
  const H = Math.max(16, Math.min(2000, Math.round((SW * pg.height) / Math.max(1, pg.width))));
  const raw = path.join(os.tmpdir(), `manga-snap-${randomUUID().slice(0, 8)}.gray`);
  try {
    await runFfmpeg(['-i', file, '-vf', `scale=${SW}:${H},format=gray`, '-f', 'rawvideo', '-frames:v', '1', raw]);
    const px = fs.readFileSync(raw);
    if (px.length < SW * H) return null;
    const flat: boolean[] = [];
    for (let r = 0; r < H; r++) {
      let s = 0;
      let s2 = 0;
      for (let c = 0; c < SW; c++) {
        const v = px[r * SW + c];
        s += v;
        s2 += v * v;
      }
      const m = s / SW;
      flat.push(Math.sqrt(Math.max(0, s2 / SW - m * m)) < FLAT_STD);
    }
    return { flat, H };
  } catch {
    return null;
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

/** Encosta as bordas internas dos quadros (e do foco) da página nas faixas lisas mais próximas. Devolve quantas bordas andaram. */
export async function snapPanelEdges(file: string, pg: StudioPage, note: PageNote): Promise<number> {
  if (!note.panels.length) return 0;
  const rows = await flatRows(file, pg);
  if (!rows) return 0;
  const { flat, H } = rows;
  const at = (y: number) => Math.min(H - 1, Math.max(0, Math.round(y * H)));
  const isFlat = (y: number) => [-2, -1, 0, 1, 2].some((k) => flat[Math.min(H - 1, Math.max(0, at(y) + k))]);
  /** Faixa lisa mais perto de y (dentro de REACH); devolve o centro dela ou null. */
  const nearest = (y: number): number | null => {
    const lim = Math.round(REACH * H);
    for (let d = 1; d <= lim; d++) {
      for (const r of [at(y) - d, at(y) + d]) {
        if (r < 0 || r >= H || !flat[r]) continue;
        // centro da faixa lisa em que r cai
        let a = r;
        let b = r;
        while (a > 0 && flat[a - 1]) a--;
        while (b < H - 1 && flat[b + 1]) b++;
        return (a + b + 1) / 2 / H;
      }
    }
    return null;
  };
  /** Borda que ainda corta o desenho (sem faixa lisa por perto): abre para fora até a faixa lisa mais próxima, ou até a borda da página. */
  const WIDE = 0.3;
  const widen = (y: number, dir: -1 | 1): number => {
    const lim = Math.round(WIDE * H);
    for (let d = 1; d <= lim; d++) {
      const r = at(y) + dir * d;
      if (r < 0 || r >= H) break;
      if (!flat[r]) continue;
      let a = r;
      let b = r;
      while (a > 0 && flat[a - 1]) a--;
      while (b < H - 1 && flat[b + 1]) b++;
      return (a + b + 1) / 2 / H;
    }
    return dir < 0 ? 0 : 1;
  };
  const MAX_RATIO = 2.3; // altura/largura do recorte: acima disso a tela não lê
  let moved = 0;
  for (const q of note.panels) {
    const old = { ...q.box };
    const h0 = q.box.y1 - q.box.y0;
    if (q.box.y0 > 0.01 && !isFlat(q.box.y0)) {
      const y = nearest(q.box.y0);
      if (y !== null && q.box.y1 - y > h0 * 0.6) q.box.y0 = y;
    }
    if (q.box.y1 < 0.99 && !isFlat(q.box.y1)) {
      const y = nearest(q.box.y1);
      if (y !== null && y - q.box.y0 > h0 * 0.6) q.box.y1 = y;
    }
    // REGRA: nunca cortar o desenho no meio. Sem faixa lisa perto, é melhor mostrar mais (até a página inteira) do que partir personagem/balão.
    const ratio = (y0: number, y1: number) => ((y1 - y0) * pg.height) / Math.max(1, (q.box.x1 - q.box.x0) * pg.width);
    if (q.box.y0 > 0.01 && !isFlat(q.box.y0)) {
      const y = widen(q.box.y0, -1);
      if (ratio(y, q.box.y1) <= MAX_RATIO) q.box.y0 = y;
    }
    if (q.box.y1 < 0.99 && !isFlat(q.box.y1)) {
      const y = widen(q.box.y1, 1);
      if (ratio(q.box.y0, y) <= MAX_RATIO) q.box.y1 = y;
    }
    if (q.box.y0 !== old.y0 || q.box.y1 !== old.y1) {
      moved++;
      // o foco (rosto/personagem) continua dentro da caixa nova
      if (q.focus) {
        q.focus.y0 = Math.max(q.focus.y0, q.box.y0);
        q.focus.y1 = Math.min(q.focus.y1, q.box.y1);
        if (q.focus.y1 - q.focus.y0 < 0.02) q.focus = undefined;
      }
    }
  }
  return moved;
}

/**
 * Abre um recorte (só em cima, só embaixo ou nos dois lados) até a faixa lisa mais perto, para não cortar o desenho.
 * Sem faixa lisa dentro de 30% da página, vai até a borda da página. Devolve null se o recorte passaria de 2,3x a largura ou não mudou.
 */
export async function widenFocus(file: string, pg: StudioPage, focus: Rect, edges: 'top' | 'bottom' | 'both'): Promise<Rect | null> {
  const rows = await flatRows(file, pg);
  if (!rows) return null;
  const { flat, H } = rows;
  const at = (y: number) => Math.min(H - 1, Math.max(0, Math.round(y * H)));
  const out = { ...focus };
  const find = (y: number, dir: -1 | 1): number => {
    // sai da faixa lisa em que a borda já está (se estiver) e procura a próxima, mais para fora
    const lim = Math.round(0.3 * H);
    let r = at(y);
    while (r > 0 && r < H - 1 && flat[r] && Math.abs(r - at(y)) < lim) r += dir;
    for (let d = 0; d <= lim; d++) {
      const k = r + dir * d;
      if (k < 0 || k >= H) break;
      if (!flat[k]) continue;
      let a = k;
      let b = k;
      while (a > 0 && flat[a - 1]) a--;
      while (b < H - 1 && flat[b + 1]) b++;
      return (a + b + 1) / 2 / H;
    }
    return dir < 0 ? 0 : 1;
  };
  if (edges !== 'bottom') out.y0 = Math.min(out.y0, find(out.y0, -1));
  if (edges !== 'top') out.y1 = Math.max(out.y1, find(out.y1, 1));
  if (out.y0 === focus.y0 && out.y1 === focus.y1) return null;
  const ratio = ((out.y1 - out.y0) * pg.height) / Math.max(1, (out.x1 - out.x0) * pg.width);
  return ratio <= 2.3 ? out : null;
}
