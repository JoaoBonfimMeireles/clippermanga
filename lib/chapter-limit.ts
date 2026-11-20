// "Usar X capítulos": de tudo o que foi baixado, só os X primeiros (por ordem de capítulo) passam pelo fluxo. O resto fica
// estacionado (project.parked, o mesmo mecanismo do modo teste): sai de pages/shots, então roteiro, edição com IA, validação e
// render nem veem. Aumentar o número traz capítulos de volta; "Criar próxima parte" leva os estacionados para a parte seguinte.
import fs from 'node:fs';
import path from 'node:path';
import { parkChapters } from './cut-profiles';
import { syncHookShots } from './parts';
import { createProject, projectDir, readProject, updateProject, writeProject } from './store';
import { addPagesToTimeline, chaptersInOrder } from './timeline';
import type { StudioPage, StudioProject } from './types';

const dirOf = (pg: StudioPage) => pg.file.split('/')[1] ?? '';

/** Todos os capítulos baixados (usados + estacionados), em ordem cronológica. */
export const allChapters = (p: StudioProject) => chaptersInOrder([...p.pages, ...(p.parked ?? []).flatMap((x) => x.pages)]);

/** Aplica o limite no projeto (em memória). `n` vazio/maior que o total = usar todos. Devolve o limite efetivo. */
export function applyChapterLimit(p: StudioProject, n: number | undefined): number {
  const all = allChapters(p);
  const want = n === undefined || !Number.isFinite(n) ? all.length : Math.max(1, Math.min(all.length, Math.floor(n)));
  const keep = new Set(all.slice(0, want));
  // estacionados que passam a entrar: voltam às páginas e à linha do tempo
  const back = (p.parked ?? []).filter((x) => keep.has(x.chapter));
  if (back.length) {
    p.parked = (p.parked ?? []).filter((x) => !keep.has(x.chapter));
    if (!p.parked.length) p.parked = undefined;
    const pages = back.flatMap((x) => x.pages);
    p.pages.push(...pages);
    addPagesToTimeline(p, pages);
  }
  // usados que passam a esperar
  parkChapters(p, chaptersInOrder(p.pages).filter((c) => !keep.has(c)));
  p.chapterLimit = want < all.length ? want : undefined;
  return want;
}

/**
 * Cria a próxima parte: um projeto novo com os capítulos estacionados deste (as pastas de imagens são movidas, não baixadas de novo),
 * mesma série/formato/voz/contexto. Este projeto passa a ser a "parte N" (1 se ainda não tinha número) e o novo a "parte N+1".
 */
export function createNextPart(id: string): StudioProject {
  const src = readProject(id);
  if (!src) throw new Error('Projeto não encontrado');
  if (!src.parked?.length) throw new Error('Não há capítulos de sobra para a próxima parte: use menos capítulos que o total baixado.');
  if (src.test) throw new Error('Termine o modo teste antes de criar a próxima parte.');
  const moved = src.parked;
  const n = src.part?.number || 1;
  const next = createProject(`${src.title.replace(/\s*parte\s*\d+\s*$/i, '').trim()} parte ${n + 1}`);
  const from = projectDir(id);
  const to = projectDir(next.id);
  const dirs = [...new Set(moved.flatMap((x) => x.pages.map(dirOf)).filter(Boolean))];
  // pastas ainda usadas pelos capítulos que ficam aqui não podem sair
  const still = new Set(src.pages.map(dirOf));
  for (const d of dirs) {
    const a = path.join(from, 'pages', d);
    const b = path.join(to, 'pages', d);
    if (!fs.existsSync(a)) continue;
    fs.mkdirSync(path.dirname(b), { recursive: true });
    if (still.has(d)) fs.cpSync(a, b, { recursive: true });
    else {
      try {
        fs.renameSync(a, b);
      } catch {
        fs.cpSync(a, b, { recursive: true });
        fs.rmSync(a, { recursive: true, force: true });
      }
    }
  }
  for (const f of ['characters.json', 'page-notes.json', 'page-hashes.json']) if (fs.existsSync(path.join(from, f))) fs.cpSync(path.join(from, f), path.join(to, f));
  const pages = moved.flatMap((x) => x.pages);
  next.pages = pages;
  Object.assign(next, {
    context: src.context,
    format: src.format,
    narration: src.narration,
    series: src.series,
    voice: src.voice,
    subtitles: src.subtitles,
    endSilence: src.endSilence,
    endTalkPad: src.endTalkPad,
    englishAudio: src.englishAudio,
    autoPaid: src.autoPaid,
    lastImportUrl: src.lastImportUrl,
    ytTitle: src.ytTitle,
    part: { number: n + 1, recapUrl: src.part?.recapUrl },
    chapterContexts: src.chapterContexts && Object.fromEntries(moved.map((x) => [x.chapter, src.chapterContexts![x.chapter]]).filter(([, v]) => v)),
  });
  addPagesToTimeline(next, pages);
  writeProject(next);
  updateProject(id, (cur) => {
    cur.parked = undefined;
    cur.chapterLimit = undefined;
    if (!cur.part?.number) cur.part = { number: 1 };
    syncHookShots(cur);
  });
  return readProject(next.id)!;
}
