// Capítulos prontos: ao importar mais capítulos num projeto já renderizado, tudo o que entrou no último render fica
// protegido. Roteiro, edição e validação trabalham só nas páginas novas e a história continua de onde parou.
import type { Shot, StudioProject } from './types';

export const lockedSet = (p: Pick<StudioProject, 'lockedPages'>) => new Set(p.lockedPages ?? []);
export const isLockedShot = (locked: Set<string>, s: Pick<Shot, 'pageId'>) => locked.has(s.pageId);

/** Protege as páginas de tudo o que já foi renderizado (até a última parte que entrou no render). */
export function lockRendered(p: StudioProject): void {
  const done = new Set((p.lastRender?.segments ?? []).map((s) => s.id));
  if (!done.size) return;
  let last = -1;
  p.shots.forEach((s, i) => {
    if (done.has(s.id)) last = i;
  });
  if (last < 0) return;
  p.lockedPages = [...new Set([...(p.lockedPages ?? []), ...p.shots.slice(0, last + 1).map((s) => s.pageId)])];
}
