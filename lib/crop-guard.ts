// REGRA FIXA: páginas de webtoon são tiras muito altas. Uma parte que mostra a página inteira vira uma faixa fina
// e ilegível na tela. Toda parte precisa ser o recorte de um quadro (feito pela edição com IA a partir da leitura das páginas).
import type { StudioProject } from './types';

const TALL = 2.2; // altura/largura a partir da qual a página inteira não cabe legível na tela

/** Quantas partes mostram uma página alta inteira (sem recorte). */
export function wholeTallPageShots(p: Pick<StudioProject, 'shots' | 'pages'>): number {
  const page = new Map(p.pages.map((x) => [x.id, x]));
  return p.shots.filter((s) => {
    const pg = page.get(s.pageId);
    if (!pg || pg.height / pg.width < TALL) return false;
    return s.focus.x1 - s.focus.x0 > 0.95 && s.focus.y1 - s.focus.y0 > 0.95;
  }).length;
}

/** A linha do tempo precisa passar pela edição (recortes por quadro): vazia ou com muitas páginas altas inteiras. */
export function needsPanelCrops(p: Pick<StudioProject, 'shots' | 'pages'>): boolean {
  if (!p.shots.length) return true;
  return wholeTallPageShots(p) >= Math.max(3, p.shots.length * 0.3);
}
