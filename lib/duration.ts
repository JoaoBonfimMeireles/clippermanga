// Duração do vídeo para leitura humana: horas e minutos em destaque, segundos no fim.
//   45 s → "45 s" · 1236 s → "20 min 36 s" · 5412 s → "1 h 30 min 12 s" · 7200 s → "2 h"
export function fmtDuration(sec: number, opts: { seconds?: boolean } = {}): string {
  const showSec = opts.seconds ?? true;
  const t = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m || (h && showSec && s)) parts.push(`${m} min`);
  if ((showSec || (!h && !m)) && (s || !parts.length)) parts.push(`${s} s`);
  return parts.join(' ');
}

/** Relógio da posição: m:ss, ou h:mm:ss a partir de 1 hora; com décimos se pedido. */
export function fmtClock(sec: number, tenths = false): string {
  const t = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  const s = tenths ? (t % 60).toFixed(1).padStart(4, '0') : String(Math.floor(t % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
