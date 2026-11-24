// Enquadramento compartilhado entre a prévia (navegador) e o render (FFmpeg), para a prévia bater com o vídeo.
// Modelo: o FOCO (frações da página) é recortado na resolução original e posto na tela:
//  - fit "contain": o recorte inteiro aparece, centralizado; as sobras viram o próprio recorte desfocado (laterais).
//  - fit "cover":   o recorte preenche a tela toda ("tela aumentada", para ação); o excesso fica de fora.
// Movimento: zoom-in/zoom-out = aproximação/afastamento LEVE da câmera (sensação de vida);
// pan = percorre o recorte quando ele é mais alto/largo que a tela (cover); static = parado.
import type { Motion, Rect, Shot } from './types';

export interface Box { x: number; y: number; w: number; h: number } // frações da tela (podem passar de 0..1)
export type Fit = 'contain' | 'cover';
/**
 * Ajustes do recorte: girar (0/90/180/270, sentido horário), esticar na horizontal (sem limite prático: o usuário
 * puxa até achar bom) e aproximar (escala do recorte na tela, além do encaixe).
 */
export interface Adjust { rotate?: number; stretch?: number; zoom?: number; /** pan ao contrário: de baixo para cima (scroll up) */ reverse?: boolean; /** trecho [início, fim] (0..1) do movimento contínuo de uma imagem reaproveitada em várias partes seguidas */ span?: [number, number] }
/** Limites só para não travar o render com valores absurdos. */
export const STRETCH_RANGE = [0.25, 6] as const;
export const ZOOM_RANGE = [0.3, 5] as const;

/** Ângulo normalizado em 0, 90, 180 ou 270. */
export const normRotate = (r?: number) => ((((Math.round((r ?? 0) / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;

/** Tamanho do recorte já girado e esticado (o que de fato vai para a tela). */
export function effSize(c: { w: number; h: number }, adj: Adjust = {}) {
  const deg = normRotate(adj.rotate);
  const rot = deg === 90 || deg === 270; // de lado: troca largura e altura
  const s = Math.min(STRETCH_RANGE[1], Math.max(STRETCH_RANGE[0], adj.stretch ?? 1));
  return { w: (rot ? c.h : c.w) * s, h: rot ? c.w : c.h, rot, s, deg };
}

export const zoomOf = (adj: Adjust = {}) => Math.min(ZOOM_RANGE[1], Math.max(ZOOM_RANGE[0], adj.zoom ?? 1));

/** Filtro FFmpeg que gira o recorte como a prévia (sentido horário). */
export function rotateFilter(adj: Adjust = {}): string {
  const deg = normRotate(adj.rotate);
  return deg === 90 ? ',transpose=1' : deg === 270 ? ',transpose=2' : deg === 180 ? ',hflip,vflip' : '';
}

/** Quanto a câmera aproxima nos movimentos leves (7%). */
export const PUSH = 0.07;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const ease = (t: number) => t * t * (3 - 2 * t);
/** Scroll/pan: quase constante (60% linear), com entrada e saída leves (40% suavizado). Mesma conta no filtro do FFmpeg (lib/render.ts). */
export const panK = (t: number) => { const u = clamp(t, 0, 1); return 0.6 * u + 0.4 * ease(u); };

export function cleanRect(r: Rect): Rect {
  const x0 = clamp(Math.min(r.x0, r.x1), 0, 1), x1 = clamp(Math.max(r.x0, r.x1), 0, 1);
  const y0 = clamp(Math.min(r.y0, r.y1), 0, 1), y1 = clamp(Math.max(r.y0, r.y1), 0, 1);
  return { x0, y0, x1: Math.max(x1, x0 + 0.02), y1: Math.max(y1, y0 + 0.02) };
}

/** Recorte em pixels da página. */
export function cropPx(focus: Rect, pw: number, ph: number) {
  const r = cleanRect(focus);
  const x = Math.round(r.x0 * pw), y = Math.round(r.y0 * ph);
  const w = Math.max(16, Math.min(pw - x, Math.round((r.x1 - r.x0) * pw)));
  const h = Math.max(16, Math.min(ph - y, Math.round((r.y1 - r.y0) * ph)));
  return { x, y, w: w - (w % 2), h: h - (h % 2) };
}

/** Tamanho do recorte na tela (frações) para o encaixe pedido. */
function contentSize(cw: number, ch: number, fit: Fit, aspect: number) {
  const ca = cw / ch;
  const wide = ca > aspect; // mais largo que a tela
  if ((fit === 'contain') === wide) return { w: 1, h: aspect / ca };
  return { w: ca / aspect, h: 1 };
}

/** O pan só faz sentido quando o recorte em "cover" sobra bastante para um lado. */
export function isPan(focus: Rect, motion: Motion, fit: Fit | undefined, pw: number, ph: number, aspect: number, adj: Adjust = {}): boolean {
  if (motion !== 'pan' || fit !== 'cover') return false;
  const c = effSize(cropPx(focus, pw, ph), adj);
  const s = contentSize(c.w, c.h, 'cover', aspect);
  return Math.max(s.w, s.h) > 1.15;
}

/** Quadro no instante t (0..1): onde o recorte fica na tela e a janela da câmera sobre a tela. */
export function frameAt(focus: Rect, motion: Motion, fit: Fit | undefined, pw: number, ph: number, aspect: number, t: number, adj: Adjust = {}): { content: Box; cam: Box } {
  const c = effSize(cropPx(focus, pw, ph), adj);
  const f: Fit = fit ?? 'contain';
  const s = contentSize(c.w, c.h, f, aspect);
  // imagem reaproveitada: o movimento é um só e cada parte percorre a sua fatia (sem recomeçar do zero)
  const tt = adj.span ? adj.span[0] + (adj.span[1] - adj.span[0]) * clamp(t, 0, 1) : t;
  const k = ease(clamp(tt, 0, 1));
  const whole: Box = { x: 0, y: 0, w: 1, h: 1 };
  if (isPan(focus, motion, f, pw, ph, aspect, adj)) {
    // percorre do começo (topo/esquerda) ao fim (base/direita)
    const pk = adj.reverse ? 1 - panK(t) : panK(t);
    const content = s.h > 1 ? { x: 0, y: -(s.h - 1) * pk, ...s } : { x: -(s.w - 1) * pk, y: 0, ...s };
    return { content, cam: whole };
  }
  // aproximar: o recorte cresce (ou diminui) a partir do centro da tela; o que sobra fica fora
  const zf = zoomOf(adj);
  const sw = s.w * zf, sh = s.h * zf;
  const content: Box = { x: (1 - sw) / 2, y: (1 - sh) / 2, w: sw, h: sh };
  const z = motion === 'zoom-in' ? PUSH * k : motion === 'zoom-out' || motion === 'pan' ? PUSH * (1 - k) : 0;
  const side = 1 - z;
  return { content, cam: { x: (1 - side) / 2, y: (1 - side) / 2, w: side, h: side } };
}

/**
 * Ocupar o máximo da tela: recorte mais estreito que a tela ganha esticar (até 1.35) e, se ainda faltar,
 * aproximar (até 1.25); recorte mais largo ganha um aproximar leve (até 1.15). Valores testados à mão sem deformar.
 */
export function autoFill(cw: number, ch: number, aspect: number): { stretch: number; zoom: number } {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const r = cw / ch;
  if (r >= aspect) return { stretch: 1, zoom: r2(Math.min(1.15, r / aspect)) };
  const stretch = r2(Math.min(1.35, aspect / r));
  const rs = r * stretch;
  return { stretch, zoom: rs >= aspect ? 1 : r2(Math.min(1.25, aspect / rs)) };
}

/** Faixa do recorte usada no fundo desfocado (frações da altura do recorte): sem o texto do meio. */
export const BG_BAND = 0.35;
export function bgBandRange(band?: 'top' | 'bottom' | 'full'): [number, number] {
  return band === 'full' ? [0, 1] : band === 'bottom' ? [1 - BG_BAND, 1] : [0, BG_BAND];
}

/**
 * CONTINUIDADE: a mesma imagem (página + recorte + ajustes) em partes ou imagens extras SEGUIDAS é um movimento só. Com m usos, o
 * primeiro percorre 0..1/m do zoom, o segundo 1/m..2/m e assim por diante, todos com o movimento (aproximar/afastar) do primeiro:
 * a câmera continua de onde parou, sem recomeçar nem dar sensação de corte, e o total nunca passa do zoom de uma imagem só.
 * Chave do resultado: `${índice da parte}:${índice da imagem dentro da parte (0 = principal)}`.
 */
export function continuityMap(shots: Shot[]): Map<string, { span: [number, number]; motion: Motion }> {
  const out = new Map<string, { span: [number, number]; motion: Motion }>();
  const views = shots.flatMap((s, i) => [s, ...(s.extra ?? [])].map((v, k) => ({ i, k, v })));
  const close = (a: number, b: number) => Math.abs(a - b) < 0.02;
  const same = (a: (typeof views)[number]['v'], b: (typeof views)[number]['v']) =>
    a.pageId === b.pageId && close(a.focus.x0, b.focus.x0) && close(a.focus.x1, b.focus.x1) && close(a.focus.y0, b.focus.y0) && close(a.focus.y1, b.focus.y1) &&
    (a.rotate ?? 0) === (b.rotate ?? 0) && Math.abs((a.stretch ?? 1) - (b.stretch ?? 1)) < 0.01 && Math.abs((a.zoom ?? 1) - (b.zoom ?? 1)) < 0.01 && (a.fit ?? 'contain') === (b.fit ?? 'contain');
  const still = (v: (typeof views)[number]['v']) => v.motion !== 'pan' && !v.scroll;
  for (let a = 0; a < views.length; ) {
    let b = a + 1;
    while (b < views.length && still(views[a].v) && still(views[b].v) && same(views[a].v, views[b].v)) b++;
    const m = b - a;
    if (m > 1) for (let j = 0; j < m; j++) out.set(`${views[a + j].i}:${views[a + j].k}`, { span: [j / m, (j + 1) / m], motion: views[a].v.motion });
    a = b;
  }
  return out;
}
