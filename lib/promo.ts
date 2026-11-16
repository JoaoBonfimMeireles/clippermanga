// Propaganda da scan (Support Us, Discord, Ko-fi, Patreon, anúncios de outras obras, mascote): NÃO é história e nunca pode
// virar recorte. A IA de visão às vezes lê isso como "conversa", então aqui a detecção é por PIXELS, sem IA: modelos
// (lib/promo-templates/*.png, recortes do anúncio que se repete no fim dos capítulos) são procurados em cada página.
// Achou: o trecho do modelo (e, no bloco "Support us", tudo dali para baixo até o fim da página) é propaganda.
// Para outra scan: salve um recorte do anúncio dela em lib/promo-templates/ (nome com "support" = o resto da página
// abaixo dele também é propaganda).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runFfmpeg } from '@clipper/video-processing';
import type { Rect, StudioPage } from './types';

export interface AdRange {
  y0: number;
  y1: number;
}

const W = 100; // largura de comparação
const MAX_DIFF = 16; // diferença média (0-255) por pixel para considerar o mesmo desenho
const DIR = path.join(process.cwd(), 'lib', 'promo-templates');

async function gray(file: string, w: number, h: number): Promise<Uint8Array | null> {
  const raw = path.join(os.tmpdir(), `manga-promo-${randomUUID().slice(0, 8)}.gray`);
  try {
    await runFfmpeg(['-i', file, '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-frames:v', '1', raw]);
    const b = fs.readFileSync(raw);
    return b.length >= w * h ? new Uint8Array(b.buffer, b.byteOffset, w * h) : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

/** Tamanho de uma imagem PNG/JPEG pelo cabeçalho. */
function imageSize(file: string): { w: number; h: number } | null {
  try {
    const b = fs.readFileSync(file);
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    for (let i = 2; i < b.length - 9; ) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  } catch {
    /* ignora */
  }
  return null;
}

interface Tpl {
  name: string;
  h: number;
  px: Uint8Array;
}
let tpls: Promise<Tpl[]> | null = null;
function templates(): Promise<Tpl[]> {
  tpls ??= (async () => {
    const out: Tpl[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(DIR).filter((f) => /\.(png|jpe?g)$/i.test(f));
    } catch {
      /* sem modelos */
    }
    for (const f of files) {
      const full = path.join(DIR, f);
      const size = imageSize(full);
      if (!size) continue;
      const h = Math.max(8, Math.round((size.h / size.w) * W));
      const px = await gray(full, W, h);
      if (px) out.push({ name: f, h, px });
    }
    return out;
  })();
  return tpls;
}

const cache = new Map<string, AdRange[]>();

/**
 * Faixas (em fração da altura da página) que são propaganda da scan. Procura cada modelo deslizando na página reduzida
 * (também parcialmente cortado no topo ou no fim da tira).
 */
export async function findPromo(img: string, page: StudioPage): Promise<AdRange[]> {
  const hit = cache.get(img);
  if (hit) return hit;
  const ads: AdRange[] = [];
  const ts = await templates();
  if (ts.length) {
    const H = Math.max(8, Math.round((page.height / page.width) * W));
    const px = await gray(img, W, H);
    if (px) {
      const rowMean = (y: number) => {
        let s = 0;
        for (let x = 0; x < W; x++) s += px[y * W + x];
        return s / W;
      };
      for (const t of ts) {
        const minOv = Math.ceil(t.h * 0.4);
        let best = Infinity,
          bestAt = 0;
        for (let at = -(t.h - minOv); at <= H - minOv; at++) {
          const a = Math.max(0, at),
            b = Math.min(H, at + t.h);
          const n = (b - a) * W;
          const limit = best * n;
          let sad = 0;
          for (let y = a; y < b && sad < limit; y++) {
            const po = y * W,
              to = (y - at) * W;
            for (let x = 0; x < W; x++) sad += Math.abs(px[po + x] - t.px[to + x]);
          }
          const d = sad / n;
          if (d < best) {
            best = d;
            bestAt = at;
          }
        }
        if (best > MAX_DIFF) continue;
        // modelo "header" (cabeçalho do capítulo): tudo do topo da página até o fim dele é propaganda
        if (/header/i.test(t.name)) {
          let y1 = Math.min(H, bestAt + t.h);
          while (y1 < H && rowMean(y1) > 245) y1++; // faixa branca colada embaixo faz parte do cabeçalho
          ads.push({ y0: 0, y1: y1 / H });
          continue;
        }
        let y0 = Math.max(0, bestAt);
        // depois do anúncio só vêm outros anúncios e logos (footer): dali até o fim da página é propaganda
        const y1 = H;
        while (y0 > 0 && rowMean(y0 - 1) > 200) y0--; // balão/faixa clara colada em cima faz parte do aviso
        ads.push({ y0: y0 / H, y1: y1 / H });
      }
    }
  }
  ads.sort((a, b) => a.y0 - b.y0);
  const merged: AdRange[] = [];
  for (const a of ads) {
    const l = merged[merged.length - 1];
    if (l && a.y0 <= l.y1 + 0.01) l.y1 = Math.max(l.y1, a.y1);
    else merged.push({ ...a });
  }
  cache.set(img, merged);
  return merged;
}

/** Tira de uma caixa a parte que é propaganda; null se não sobra quase nada. */
export function avoidAds(r: Rect, ads: AdRange[]): Rect | null {
  let { y0, y1 } = r;
  const h = y1 - y0;
  if (h <= 0) return null;
  for (const a of ads) {
    if (a.y1 <= y0 || a.y0 >= y1) continue;
    if (a.y0 <= y0 + h * 0.15 && a.y1 >= y1 - h * 0.15) return null; // propaganda cobre quase tudo
    if (a.y0 > y0) y1 = Math.min(y1, a.y0);
    else y0 = Math.max(y0, a.y1);
  }
  if (y1 - y0 < Math.max(0.012, h * 0.3)) return null;
  return { ...r, y0, y1 };
}

type Block = { y0: number; y1: number };
const SIG = 16;
const REPEAT_DIFF = 6; // bem mais rígido que MAX_DIFF: balões parecidos em fundo branco não são a mesma imagem

/** Miniatura 16x16 de uma faixa da página; null se a faixa é quase lisa (fundo ou quadro escuro não identificam nada). */
function blockSig(px: Uint8Array, H: number, b: Block): Uint8Array | null {
  const a = Math.floor(b.y0 * H), z = Math.max(a + 1, Math.ceil(b.y1 * H));
  const out = new Uint8Array(SIG * SIG);
  let sum = 0, sum2 = 0;
  for (let j = 0; j < SIG; j++)
    for (let i = 0; i < SIG; i++) {
      const y = Math.min(H - 1, a + Math.floor(((j + 0.5) / SIG) * (z - a)));
      const x = Math.min(W - 1, Math.floor(((i + 0.5) / SIG) * W));
      const v = px[y * W + x];
      out[j * SIG + i] = v;
      sum += v;
      sum2 += v * v;
    }
  const n = SIG * SIG;
  return sum2 / n - (sum / n) ** 2 < 15 * 15 ? null : out;
}

/**
 * Logo da obra, créditos e rodapés de qualquer scan, sem modelo cadastrado: o primeiro ou o último bloco de uma página
 * que se repete quase igual em 3 capítulos ou mais não é história. Devolve as faixas por arquivo de imagem.
 */
export async function findRepeatedEnds(items: { img: string; page: StudioPage; blocks: Block[] }[]): Promise<Map<string, AdRange[]>> {
  const ends: { img: string; chapter: string; b: Block; ar: number; sig: Uint8Array }[] = [];
  for (const it of items) {
    if (!it.blocks.length) continue;
    const H = Math.max(8, Math.round((it.page.height / it.page.width) * W));
    const px = await gray(it.img, W, H);
    if (!px) continue;
    for (const b of new Set([it.blocks[0], it.blocks[it.blocks.length - 1]])) {
      const sig = blockSig(px, H, b);
      if (sig) ends.push({ img: it.img, chapter: String(it.page.chapter), b, ar: ((b.y1 - b.y0) * it.page.height) / it.page.width, sig });
    }
  }
  const out = new Map<string, AdRange[]>();
  for (const e of ends) {
    const chapters = new Set([e.chapter]);
    for (const o of ends) {
      if (o === e || chapters.has(o.chapter) || Math.abs(o.ar - e.ar) > e.ar * 0.12) continue;
      let d = 0;
      for (let k = 0; k < e.sig.length; k++) d += Math.abs(e.sig[k] - o.sig[k]);
      if (d / e.sig.length < REPEAT_DIFF) chapters.add(o.chapter);
    }
    if (chapters.size >= 3) out.set(e.img, [...(out.get(e.img) ?? []), { y0: e.b.y0, y1: e.b.y1 }]);
  }
  return out;
}
