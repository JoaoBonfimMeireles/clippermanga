// Nota de qualidade de um recorte, calculada só com geometria (sem IA, sem token). Mede o que o espectador vê:
//  - área: quanto da tela o recorte nítido ocupa (as laterais desfocadas não contam);
//  - ampliação: quantos pixels da tela cada pixel original ocupa (acima de ~1,5 fica borrado em TV/notebook);
//  - altura relativa: recorte alto demais vira uma tirinha estreita no meio da tela.
// Usada pela edição (para pedir recortes mais largos), pelo Montador (manter a imagem anterior quando a nota é ruim)
// e pelo relatório (scripts/crop-report.ts). Não depende de @clipper: roda em qualquer lugar.
import { cropPx, effSize, zoomOf } from './camera';
import type { Rect, Shot, StudioPage } from './types';

/** Limites do espectador (combinados com o usuário). */
export const QUALITY = {
  /** PISO: o recorte nítido ocupa pelo menos 40% da tela (o retângulo azul que o usuário marcou: altura toda, 40% da largura). */
  minArea: 0.4,
  /** Garantia dura: ZERO recortes abaixo de 30% da tela. */
  hardMinArea: 0.3,
  /** Esticar na horizontal: até 1,9x no máximo (o usuário aceita; só como último recurso). */
  maxStretch: 1.9,
  /** Esticar preferido: acima disso a imagem deforma; antes tenta-se a janela do quadro. */
  softStretch: 1.4,
  /** Janela preferida ao recortar um quadro alto: altura 1,6x a largura (com esticar pequeno chega ao piso). */
  windowTall: 1.6,
  /** Ampliação máxima sobre os pixels originais. */
  maxUpscale: 1.5,
  /** Altura máxima do recorte, em vezes a largura (em 16:9, acima disso não chega a 30% da tela). */
  maxTall: 1.9,
} as const;

export type Problem = 'small' | 'blurry';
export interface Screen { w: number; h: number }
export const SCREEN_HD: Screen = { w: 1920, h: 1080 };

export interface CropMetrics {
  /** Fração da tela ocupada pelo recorte (0..1). */
  area: number;
  /** Ampliação sobre os pixels originais. */
  upscale: number;
  /** Altura / largura do recorte já esticado e girado. */
  tall: number;
  /** O recorte cobre a altura inteira da tela (colado em cima e embaixo). */
  fillsHeight: boolean;
  problems: Problem[];
}

type Dim = Pick<StudioPage, 'width' | 'height'>;
type Look = Pick<Shot, 'rotate' | 'stretch' | 'zoom' | 'fit'>;

export function cropMetrics(focus: Rect, page: Dim, look: Look = {}, screen: Screen = SCREEN_HD): CropMetrics {
  const c = cropPx(focus, page.width, page.height);
  const e = effSize(c, { rotate: look.rotate, stretch: look.stretch });
  const z = zoomOf({ zoom: look.zoom });
  const fx = screen.w / e.w, fy = screen.h / e.h;
  const cover = look.fit === 'cover';
  const sc = (cover ? Math.max(fx, fy) : Math.min(fx, fy)) * z;
  const dw = Math.min(screen.w, e.w * sc), dh = Math.min(screen.h, e.h * sc);
  const area = (dw * dh) / (screen.w * screen.h);
  // o esticar alarga os pixels na horizontal: conta o pior eixo
  const upscale = sc * Math.max(1, e.s);
  const problems: Problem[] = [];
  if (area < QUALITY.minArea) problems.push('small');
  if (upscale > QUALITY.maxUpscale) problems.push('blurry');
  const fillsHeight = look.fit === 'cover' || dh >= screen.h * 0.995;
  return { area, upscale, tall: e.h / e.w, fillsHeight, problems };
}

/**
 * Recorte "apertado": mais largo que alto e ampliado mais de 2x. É o sinal do "muito próximo" que o usuário corrige abrindo
 * a cena (nas correções dele o recorte final é 1,2 a 1,6x a caixa da leitura e quase sempre mais alto). Indicador, não erro:
 * um quadro largo de página estreita cai aqui mesmo inteiro.
 */
export const isTight = (m: Pick<CropMetrics, 'tall' | 'upscale'>) => m.tall < 0.8 && m.upscale > 2;
/** Ampliação a partir da qual a fonte é pequena demais para qualquer tela (o "borrão sem sentido"). */
export const EXTREME_UPSCALE = 3;

export const judgeShot = (s: Pick<Shot, 'focus' | 'rotate' | 'stretch' | 'zoom' | 'fit'>, page: Dim, screen?: Screen) =>
  cropMetrics(s.focus, page, s, screen);

/** Altura máxima (fração da página) que um recorte desta largura pode ter sem virar tirinha. Vai no prompt da edição. */
export function maxHeightFrac(focus: Rect, page: Dim): number {
  const wpx = Math.max(16, (Math.abs(focus.x1 - focus.x0)) * page.width);
  return Math.min(1, (QUALITY.maxTall * wpx) / page.height);
}

/**
 * Quadro alto demais: divide em fatias de altura aceitável (com 4% de sobreposição) que passam em sequência
 * durante a mesma fala. É o plano B quando a IA não escolheu um trecho mais largo da cena.
 */
export function sliceTall(focus: Rect, page: Dim, maxSlices = 4): Rect[] {
  const frac = maxHeightFrac(focus, page);
  const h = focus.y1 - focus.y0;
  if (h <= frac * 1.02) return [focus];
  const n = Math.min(maxSlices, Math.ceil(h / frac));
  const sh = h / n;
  const ov = sh * 0.04;
  return Array.from({ length: n }, (_, i) => ({
    x0: focus.x0,
    x1: focus.x1,
    y0: Math.max(focus.y0, focus.y0 + i * sh - (i ? ov : 0)),
    y1: Math.min(focus.y1, focus.y0 + (i + 1) * sh + (i < n - 1 ? ov : 0)),
  }));
}

/**
 * Trava usada na edição: tira só o que borra (zoom, esticar demais, encolher na tela) sem mudar a quantidade de partes.
 * Quadro alto demais continua com o splitTall da edição. "cover" (tela cheia) não é mexido.
 */
export function softenShot<T extends Pick<Shot, 'focus' | 'rotate' | 'stretch' | 'zoom' | 'fit'>>(s: T, page: Dim, screen?: Screen): T {
  if (s.fit === 'cover') return s;
  let zoom = s.zoom ?? 1, stretch = s.stretch ?? 1;
  const at = () => cropMetrics(s.focus, page, { ...s, zoom, stretch }, screen);
  let m = at();
  if (!m.problems.includes('blurry')) return s;
  if (zoom > 1) { zoom = 1; m = at(); }
  if (m.problems.includes('blurry') && stretch > 1.2) { stretch = 1.2; m = at(); }
  // nunca encolher o recorte (zoom < 1): ele tem que cobrir a altura da tela, colado em cima e embaixo
  void m;
  return { ...s, zoom, stretch };
}

/** Conserto só por geometria: tira o zoom que borra e fatia o que é alto demais. Devolve os recortes a mostrar. */
export function fixShot(s: Shot, page: Dim, screen?: Screen): { shots: Pick<Shot, 'focus' | 'zoom' | 'stretch'>[]; changed: boolean } {
  let zoom = s.zoom ?? 1;
  let m = cropMetrics(s.focus, page, { ...s, zoom }, screen);
  if (m.problems.includes('blurry') && zoom > 1) {
    zoom = 1;
    m = cropMetrics(s.focus, page, { ...s, zoom }, screen);
  }
  if (m.problems.includes('blurry')) {
    // encolhe o recorte na tela até a ampliação cair para o limite, se ele ainda ocupar a área mínima
    const zf = Math.max(0.3, Math.floor((zoom * QUALITY.maxUpscale / m.upscale) * 100) / 100);
    const m2 = cropMetrics(s.focus, page, { ...s, zoom: zf }, screen);
    if (!m2.problems.includes('small')) {
      zoom = zf;
      m = m2;
    }
  }
  if (m.problems.includes('small') && m.tall > QUALITY.maxTall) {
    const slices = sliceTall(s.focus, page);
    if (slices.length > 1) return { shots: slices.map((focus) => ({ focus, zoom, stretch: s.stretch })), changed: true };
  }
  return { shots: [{ focus: s.focus, zoom, stretch: s.stretch }], changed: zoom !== (s.zoom ?? 1) };
}
