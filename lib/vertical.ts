// Parte do vídeo horizontal adaptada para a tela em pé (short): quadro encaixado, esticar no máximo 1.15.
// Usado pelo render dos shorts (servidor) e pela prévia do modal (navegador): os dois ficam iguais.
import { autoFill, cropPx, effSize } from './camera';
import type { Rect, Shot, StudioPage } from './types';

export function toVertical(s: Shot, pages: StudioPage[], aspect: number, frame?: Rect): Shot {
  const focus = frame ?? s.focus;
  const pg = pages.find((x) => x.id === s.pageId);
  // scroll em tela em pé: a faixa alta preenche a largura e rola na vertical (só se for alta o bastante; senão volta ao encaixe normal)
  if (s.scroll && pg && !frame) {
    const c = cropPx(focus, pg.width, pg.height);
    if (c.w / c.h < aspect / 1.15) return { ...s, fit: 'cover', stretch: 1, zoom: 1, motion: 'pan', newImage: undefined };
  }
  let stretch = 1, zoom = 1;
  if (pg) {
    const c = cropPx(focus, pg.width, pg.height);
    const ef = effSize({ w: c.w, h: c.h }, { rotate: s.rotate });
    ({ stretch, zoom } = autoFill(ef.w, ef.h, aspect));
    stretch = Math.min(stretch, 1.15);
    zoom = autoFill(ef.w * stretch, ef.h, aspect).zoom;
  }
  const extra = s.extra?.map((v) => ({ ...v, scroll: undefined, fit: 'contain' as const, stretch: 1, zoom: 1, motion: v.motion === 'pan' ? ('zoom-in' as const) : v.motion }));
  return { ...s, scroll: undefined, focus, fit: 'contain', stretch, zoom, motion: s.motion === 'pan' ? 'zoom-in' : s.motion, newImage: undefined, extra };
}
