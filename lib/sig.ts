// Assinatura do que vai para o vídeo (linha do tempo, voz, legenda, palavras cortadas). O render guarda a
// assinatura do que usou; se a atual for diferente, o vídeo está desatualizado em relação às edições.
// Roda no navegador e no servidor (sem node:crypto).
import type { Shot, ShortInfo, StudioProject } from './types';

export function renderSig(p: Pick<StudioProject, 'shots' | 'narration' | 'voice' | 'subtitles' | 'cutWords' | 'format'>): string {
  const data = JSON.stringify({
    shots: p.shots.map((s) => ({ ...s, newImage: undefined, kind: undefined, impact: undefined })),
    narration: p.narration,
    voice: p.voice ?? null,
    subtitles: !!p.subtitles,
    cutWords: p.cutWords ?? [],
    format: p.format,
  });
  // FNV-1a 32 bits, duas passadas com sementes diferentes (64 bits no total)
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193 + 2);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** O último render tem todas as edições atuais? */
export const renderUpToDate = (p: StudioProject) => !!p.lastRender?.sig && p.lastRender.sig === renderSig(p);

/** Onde o short está hoje na linha do tempo (pelos ids das partes; se sumiram, pelas posições salvas). */
export function shortRange(shots: Shot[], s: ShortInfo): [number, number] {
  const a = s.fromId ? shots.findIndex((x) => x.id === s.fromId) : -1;
  const b = s.toId ? shots.findIndex((x) => x.id === s.toId) : -1;
  const n = shots.length - 1;
  const from = a >= 0 ? a : Math.min(s.from, n);
  const to = b >= from ? b : Math.min(Math.max(from, s.to), n);
  return [from, to];
}

/** Duração de cada parte no vídeo: a real do último render; partes novas usam a pedida. */
export function shotDurations(p: Pick<StudioProject, 'shots' | 'lastRender'>): number[] {
  const segs = new Map((p.lastRender?.segments ?? []).map((g) => [g.id, g.dur]));
  return p.shots.map((s) => segs.get(s.id) ?? s.duration / (s.speed ?? 1));
}
