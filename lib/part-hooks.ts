// Parte pura (sem disco) dos ganchos de parte, testável: ver lib/parts.ts.
import type { Shot, StudioProject } from './types';

export const HOOK_INTRO_ID = 'hook-intro';
export const HOOK_OUTRO_ID = 'hook-outro';
const WPS = 2.3; // palavras por segundo da narração (só para estimar a duração planejada)

export const isHook = (s: Pick<Shot, 'hook'>) => !!s.hook;
export const partNumber = (p: Pick<StudioProject, 'part'>) => (p.part && Number.isFinite(p.part.number) && p.part.number > 0 ? Math.floor(p.part.number) : 0);

/**
 * Deixa a linha do tempo de acordo com o gancho: abertura na frente e fechamento no fim, cada um com a imagem da primeira/última
 * parte da história. Se a parte do gancho já existe, o texto dela (talvez editado) manda e volta para `part`; se não, nasce de `part.intro/outro`.
 * Sem número de parte, os ganchos saem. Altera `p` e devolve se mudou algo.
 */
export function syncHookShots(p: StudioProject): boolean {
  const before = JSON.stringify(p.shots) + JSON.stringify(p.part ?? null);
  const body = p.shots.filter((s) => !isHook(s));
  const old = (kind: 'intro' | 'outro') => p.shots.find((s) => s.hook === kind);
  if (!partNumber(p) || !p.part || !body.length) {
    p.shots = body;
    return before !== JSON.stringify(p.shots) + JSON.stringify(p.part ?? null);
  }
  const part = p.part;
  const make = (kind: 'intro' | 'outro', at: Shot): Shot | null => {
    const cur = old(kind);
    const text = (cur ? cur.text : part[kind])?.trim() ?? '';
    if (!text) return null;
    part[kind] = text;
    const view = { pageId: at.pageId, focus: { ...at.focus }, fit: at.fit, rotate: at.rotate, stretch: at.stretch, zoom: at.zoom, motion: at.motion, bgBand: at.bgBand };
    return { ...(cur ?? {}), ...view, id: kind === 'intro' ? HOOK_INTRO_ID : HOOK_OUTRO_ID, hook: kind, duration: Math.max(3, Math.round((text.split(/\s+/).length / WPS) * 10) / 10), text, extra: undefined, audioCuts: cur?.text === text ? cur.audioCuts : undefined };
  };
  const intro = make('intro', body[0]);
  const outro = make('outro', body[body.length - 1]);
  p.shots = [...(intro ? [intro] : []), ...body, ...(outro ? [outro] : [])];
  return before !== JSON.stringify(p.shots) + JSON.stringify(p.part);
}

