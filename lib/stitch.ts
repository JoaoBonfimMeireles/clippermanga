// REGRA FIXA: os sites de webtoon entregam o capítulo em imagens fatiadas em pontos aleatórios (um personagem vira 2 ou 3 imagens).
// Aqui as imagens do capítulo são emendadas numa tira só e cortadas de novo SÓ em faixa lisa (sarjeta/fundo uniforme), em páginas
// bem altas: nenhum personagem, cabelo ou balão fica partido ao meio. Sem IA: tudo medido nos pixels.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { probe, runFfmpeg } from '@clipper/video-processing';

const SW = 120; // largura da imagem reduzida usada para achar as faixas lisas
const FLAT_STD = 8; // linha "lisa": quase sem variação de tom
const MAX_RATIO = 6; // página emendada: altura máxima = 6x a largura (o JPEG não passa de 65 535 px)
const MIN_RATIO = 2.5; // e não corta antes de 2,5x a largura, se houver faixa lisa depois

export interface StitchIn {
  file: string; // caminho absoluto
  width: number;
  height: number;
}
export interface StitchOut {
  file: string; // caminho absoluto (gravado em outDir)
  width: number;
  height: number;
}

/** Desvio de tom de cada linha da imagem reduzida (baixo = linha lisa). */
async function rowDev(file: string, hScaled: number, W: number): Promise<number[]> {
  const H = Math.max(2, Math.min(4000, Math.round((SW * hScaled) / W)));
  const raw = path.join(os.tmpdir(), `manga-stitch-${randomUUID().slice(0, 8)}.gray`);
  try {
    await runFfmpeg(['-i', file, '-vf', `scale=${SW}:${H},format=gray`, '-f', 'rawvideo', '-frames:v', '1', raw]);
    const px = fs.readFileSync(raw);
    const out: number[] = [];
    for (let r = 0; r < H && (r + 1) * SW <= px.length; r++) {
      let s = 0;
      let s2 = 0;
      for (let c = 0; c < SW; c++) {
        const v = px[r * SW + c];
        s += v;
        s2 += v * v;
      }
      const m = s / SW;
      out.push(Math.sqrt(Math.max(0, s2 / SW - m * m)));
    }
    return out.length ? out : new Array(H).fill(255);
  } catch {
    return new Array(H).fill(255); // não leu: nenhuma faixa lisa (o corte cai na posição ideal)
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

/**
 * Emenda as imagens (na ordem) e devolve a tira cortada em páginas altas, cada corte numa faixa lisa.
 * Arquivos de saída: <outDir>/<prefix>001.jpg, 002…
 */
export async function stitchChapter(inputs: StitchIn[], outDir: string, prefix = 'p'): Promise<StitchOut[]> {
  if (!inputs.length) return [];
  // largura comum = a mais frequente; as outras imagens são escaladas para ela
  const count = new Map<number, number>();
  for (const i of inputs) count.set(i.width, (count.get(i.width) ?? 0) + 1);
  const W = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const hs = inputs.map((i) => Math.max(1, Math.round((i.height * W) / i.width)));
  const tops: number[] = [];
  let total = 0;
  for (const h of hs) (tops.push(total), (total += h));

  // perfil de "lisura" da tira inteira, uma entrada por linha reduzida (y em px da tira emendada)
  const dev: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < inputs.length; k++) {
    const d = await rowDev(inputs[k].file, hs[k], W);
    d.forEach((v, r) => (dev.push(v), ys.push(tops[k] + ((r + 0.5) * hs[k]) / d.length)));
  }

  // onde cortar: a faixa lisa mais perto do tamanho ideal, entre o mínimo e o máximo
  const cuts: number[] = [0];
  const maxH = W * MAX_RATIO;
  const minH = W * MIN_RATIO;
  const ideal = W * ((MAX_RATIO + MIN_RATIO) / 2);
  while (total - cuts[cuts.length - 1] > maxH) {
    const from = cuts[cuts.length - 1];
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < ys.length; i++) {
      const h = ys[i] - from;
      if (h < minH) continue;
      if (h > maxH) break;
      // lisa: vale pela distância do tamanho ideal; não lisa: só se não houver nenhuma lisa (penalidade grande)
      const score = Math.abs(h - ideal) + (dev[i] < FLAT_STD ? 0 : 1e6 + dev[i] * 1000);
      if (score < bestScore) (best = i), (bestScore = score);
    }
    const c = best >= 0 ? Math.round(ys[best]) : Math.round(from + ideal);
    cuts.push(c - (c % 2)); // altura par: o JPEG/yuv420 arredonda ímpar para baixo e o tamanho gravado ficaria errado
  }
  cuts.push(total - (total % 2));

  fs.mkdirSync(outDir, { recursive: true });
  const out: StitchOut[] = [];
  for (let n = 0; n + 1 < cuts.length; n++) {
    const a = cuts[n];
    const b = cuts[n + 1];
    if (b - a < 8) continue;
    const dst = path.join(outDir, `${prefix}${String(out.length + 1).padStart(3, '0')}.jpg`);
    const args: string[] = ['-y'];
    const filters: string[] = [];
    const labels: string[] = [];
    for (let k = 0; k < inputs.length; k++) {
      const y0 = Math.max(a, tops[k]);
      const y1 = Math.min(b, tops[k] + hs[k]);
      if (y1 - y0 < 1) continue;
      args.push('-i', inputs[k].file);
      const idx = labels.length;
      filters.push(`[${idx}:v]scale=${W}:${hs[k]},crop=${W}:${y1 - y0}:0:${y0 - tops[k]}[c${idx}]`);
      labels.push(`[c${idx}]`);
    }
    const graph = labels.length > 1 ? `${filters.join(';')};${labels.join('')}vstack=inputs=${labels.length}[o]` : `${filters[0].replace(/\[c0\]$/, '[o]')}`;
    await runFfmpeg([...args, '-filter_complex', graph, '-map', '[o]', '-q:v', '3', '-frames:v', '1', dst]);
    // tamanho REAL do arquivo gravado (não o calculado): é o que o resto do app usa para recortar
    const real = await probe(dst).catch(() => null);
    out.push({ file: dst, width: real?.width ?? W, height: real?.height ?? b - a });
  }
  return out;
}
