// Texto para o YouTube que depende do render: minutagem dos capítulos (vira "capítulos" clicáveis no player).
// Roda no navegador e no servidor.
import type { StudioProject } from './types';
import { shotDurations } from './sig';

/** 75 → "1:15"; 3725 → "1:02:05" (formato que o YouTube entende como capítulo). */
export const tc = (sec: number) => {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

/** "⏱ Capítulos:\n0:00 Abertura\n0:06 Capítulo 3 – ..." a partir dos tempos do último render. */
export function chaptersText(p: StudioProject): string {
  const dur = shotDurations(p);
  const chapterOf = new Map(p.pages.map((x) => [x.id, x.chapter]));
  const marks: { t: number; ch: string }[] = [];
  let t = 0;
  p.shots.forEach((s, i) => {
    const ch = chapterOf.get(s.pageId) ?? '';
    if (ch && ch !== marks[marks.length - 1]?.ch) marks.push({ t: marks.length ? t : 0, ch });
    t += dur[i];
  });
  // o YouTube só mostra capítulos com pelo menos 10 s: os curtos ficam de fora
  const ok = marks.filter((m, k) => k === 0 || (marks[k + 1]?.t ?? t) - m.t >= 10);
  if (ok.length < 3) return ''; // o YouTube exige pelo menos 3 capítulos
  // resumo curto do capítulo: a primeira frase, cortada numa palavra inteira
  const blurb = (ch: string) => {
    const f = p.chapterContexts?.[ch]?.split(/[.!?]/)[0].trim() ?? '';
    if (!f) return '';
    return ` – ${f.length <= 70 ? f : `${f.slice(0, f.lastIndexOf(' ', 70)).replace(/[,;:]$/, '')}…`}`;
  };
  const isIntro = (ch: string) => /^(imagens|abertura)$/i.test(ch);
  return `⏱ Capítulos:\n${ok.map((m) => (isIntro(m.ch) ? `${tc(m.t)} Abertura` : `${tc(m.t)} ${m.ch}${blurb(m.ch)}`)).join('\n')}`;
}

/** Descrição completa do vídeo principal: a da IA (ou uma padrão) + a minutagem. */
export function fullDescription(p: StudioProject): string {
  const head = p.publish?.description?.trim() || `${p.series || p.title}: a história narrada em português, capítulo por capítulo. Se curtiu, deixa o like, comenta o que achou e se inscreve para não perder os próximos capítulos!`;
  // sem minutagem: o usuário não quer a lista de capítulos na descrição
  return head;
}
