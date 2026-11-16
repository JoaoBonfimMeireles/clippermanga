// Ordem cronológica: capítulos pelo número no nome ("Capítulo 3", "Cap. 10.5"), páginas na ordem de importação.
// Seguro para o navegador (o botão "Montar linha do tempo" usa) e para o servidor (o import monta sozinho).
import { FULL, type Shot, type StudioPage, type StudioProject } from './types';

const uid = () => Math.random().toString(36).slice(2, 10);

/** Número do capítulo no nome; sem número → fica na ordem em que foi importado. */
export function chapterNum(name: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)(?!.*\d)/.exec(name);
  return m ? Number(m[1].replace(',', '.')) : null;
}

/** Capítulos em ordem cronológica. */
export function chaptersInOrder(pages: StudioPage[]): string[] {
  const first = new Map<string, number>();
  pages.forEach((p, i) => first.has(p.chapter) || first.set(p.chapter, i));
  return [...first.keys()].sort((a, b) => {
    const na = chapterNum(a), nb = chapterNum(b);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    if (na !== null && nb === null) return -1;
    if (na === null && nb !== null) return 1;
    return first.get(a)! - first.get(b)!;
  });
}

/** Páginas em ordem cronológica (capítulo, depois a ordem dentro do capítulo). */
export function pagesInOrder(pages: StudioPage[]): StudioPage[] {
  const rank = new Map(chaptersInOrder(pages).map((c, i) => [c, i]));
  return pages.map((p, i) => ({ p, i })).sort((a, b) => rank.get(a.p.chapter)! - rank.get(b.p.chapter)! || a.i - b.i).map((x) => x.p);
}

export const newShot = (pageId: string, voice: boolean): Shot => ({ id: uid(), pageId, duration: voice ? 5 : 4, focus: { ...FULL }, motion: 'zoom-in', text: '' });

/**
 * Remonta a linha do tempo em ordem cronológica: toda página entra; partes que já existem (foco, texto,
 * várias partes da mesma página) são mantidas, só reordenadas.
 */
export function buildTimeline(p: StudioProject): Shot[] {
  const byPage = new Map<string, Shot[]>();
  for (const s of p.shots) byPage.set(s.pageId, [...(byPage.get(s.pageId) ?? []), s]);
  return pagesInOrder(p.pages).flatMap((pg) => byPage.get(pg.id) ?? [newShot(pg.id, p.narration !== 'text')]);
}

/** Depois de importar: as páginas novas entram na linha do tempo no lugar certo da ordem cronológica. */
export function addPagesToTimeline(p: StudioProject, newPages: StudioPage[]): void {
  const order = pagesInOrder(p.pages).map((x) => x.id);
  const pos = new Map(order.map((id, i) => [id, i]));
  // as partes que já existem ficam na ordem em que estão (o usuário pode ter movido); cada página nova entra depois da última parte mais antiga que ela
  const shots = [...p.shots];
  for (const pg of [...newPages].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9))) {
    const at = pos.get(pg.id) ?? 1e9;
    let i = shots.length;
    while (i > 0 && (pos.get(shots[i - 1].pageId) ?? -1) > at) i--;
    shots.splice(i, 0, newShot(pg.id, p.narration !== 'text'));
  }
  p.shots = shots;
}
