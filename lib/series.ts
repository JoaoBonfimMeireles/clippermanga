// Memória da série: o que a IA já criou nos vídeos anteriores da mesma obra (resumos dos capítulos, como chama o
// protagonista e os personagens, termos, tom e onde a história parou). Fica em projetos/_series/<chave>.json e é
// usada pelo próximo projeto da mesma série: o vídeo dos capítulos 7-12 já começa sabendo tudo dos 1-6.
// A série é o campo "Série" do projeto ou, vazio, o título sem números de capítulo ("Solo Swordmaster 7-12" → "solo swordmaster").
import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider } from '@clipper/ai-providers';
import { extractJson } from '@clipper/editing-planner';
import { projectJobs } from './jobs';
import { listProjects, peekProject, studioDir, updateProject } from './store';
import type { StudioProject } from './types';

export interface SeriesMemory {
  key: string;
  title: string;
  /** "Bíblia" da série escrita pela IA: personagens, apelidos, termos, tom e a história até aqui. */
  bible: string;
  /** Resumo de cada capítulo já feito (nome do capítulo → resumo), de qualquer projeto da série. */
  chapters: Record<string, string>;
  /** Uma parte da bíblia por projeto/etapa (cada uma até STAGE_CHARS): as partes se somam, em ordem. */
  stages?: { projectId: string; title: string; bible: string }[];
  /** Ordem em que os capítulos entraram na memória. */
  order: string[];
  /** Últimas frases narradas no vídeo mais recente (para o próximo retomar dali). */
  lastNarration: string;
  /** Projetos que contribuíram. */
  projects: string[];
  updatedAt: string;
}

export function seriesKey(p: Pick<StudioProject, 'title' | 'series'>): string {
  return (p.series?.trim() || p.title)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(c[oó]pia\)/g, '')
    .replace(/\b(cap(itulo)?s?|chapters?|ch|parte|part|ep(isodio)?|vol(ume)?)\b\.?/g, ' ')
    .replace(/\d+(\.\d+)?(\s*(-|a|ao|até|to)\s*\d+(\.\d+)?)?/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'sem-nome';
}

const fileOf = (key: string) => path.join(studioDir(), '_series', `${key}.json`);

export function readSeries(p: Pick<StudioProject, 'title' | 'series'> & { id?: string }): SeriesMemory | null {
  try {
    return JSON.parse(fs.readFileSync(fileOf(seriesKey(p)), 'utf8')) as SeriesMemory;
  } catch {
    return seedFromProjects(p);
  }
}

/** Série sem memória gravada ainda: monta uma a partir dos projetos antigos da mesma série (feitos antes da memória existir). */
function seedFromProjects(p: Pick<StudioProject, 'title' | 'series'> & { id?: string }): SeriesMemory | null {
  const key = seriesKey(p);
  const others = listProjects()
    .filter((o) => o.id !== p.id && seriesKey(o) === key && Object.keys(o.chapterContexts ?? {}).length)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!others.length) return null;
  const m: SeriesMemory = { key, title: p.series?.trim() || p.title, bible: '', chapters: {}, order: [], lastNarration: '', projects: [], updatedAt: '' };
  for (const o of others) {
    for (const [ch, sum] of Object.entries(o.chapterContexts ?? {})) {
      m.chapters[ch] = sum;
      if (!m.order.includes(ch)) m.order.push(ch);
    }
    m.projects.push(o.id);
    const text = (o.shots.length ? o.shots.map((s) => s.text) : Object.values(o.pageScript ?? {})).filter(Boolean).join(' ');
    if (text) m.lastNarration = text.slice(-600);
  }
  // sem a bíblia da IA: usa os resumos dos capítulos como memória (a bíblia é escrita no próximo roteiro)
  m.bible = `História até aqui, capítulo a capítulo: ${m.order.slice(-15).map((c) => `${c}: ${m.chapters[c]}`).join(' | ')}`;
  writeSeries(m);
  return m;
}

function writeSeries(m: SeriesMemory) {
  const f = fileOf(m.key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  m.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(m, null, 2), 'utf8');
}

/** Cada etapa (projeto) da série guarda até 5.000 caracteres (~800 palavras); o prompt leva todas as etapas somadas. */
export const STAGE_CHARS = 5000;

/** Partes da bíblia por etapa. Memória antiga (uma bíblia só) vira a primeira etapa. */
function stagesOf(m: SeriesMemory): NonNullable<SeriesMemory['stages']> {
  if (m.stages) return m.stages;
  if (m.bible && !m.bible.startsWith('História até aqui, capítulo a capítulo:')) return [{ projectId: m.projects[0] ?? 'antigo', title: m.title, bible: m.bible }];
  return [];
}

/**
 * Texto de memória para colocar no prompt (vazio se a série ainda não tem nada de outros projetos).
 * `max` limita o total (os prompts de leitura usam pouco); o padrão leva todas as etapas, cada uma com até 5.000 caracteres.
 */
/** Etapa atual do projeto: continuar um projeto (capítulos protegidos) abre uma etapa nova, sem apagar a anterior. */
const stageIdOf = (p: Pick<StudioProject, 'id' | 'lockedPages'>) => (p.lockedPages?.length ? `${p.id}:${p.lockedPages.length}` : p.id);

export function seriesPrompt(p: StudioProject, max = 200_000): string {
  const m = readSeries(p);
  if (!m) return '';
  // só vale como memória o que veio de OUTRO projeto da série (o próprio projeto já tem seus resumos)
  const parts = stagesOf(m).filter((s) => s.projectId !== stageIdOf(p));
  let text = parts.map((s) => s.bible.slice(0, STAGE_CHARS)).join('\n\n');
  if (!text && m.bible && m.projects.some((id) => id !== p.id)) text = m.bible.slice(0, STAGE_CHARS); // memória montada só com resumos
  if (!text) return '';
  if (text.length > max) text = text.slice(0, max);
  return `MEMÓRIA DA SÉRIE (o que eu já contei nos vídeos anteriores, etapa por etapa; mantenha os mesmos nomes, apelidos, termos e o mesmo jeito de falar, e siga a história a partir daí): ${text}\n`;
}

const SYSTEM_BIBLE = `Você mantém a MEMÓRIA de uma série de vídeos narrados de mangá (narrados em primeira pessoa pelo protagonista, em português do Brasil).
Recebe a memória anterior (pode estar vazia), os resumos dos capítulos novos e trechos da narração do vídeo novo.
Recebe também a memória das etapas anteriores. Escreva SÓ a memória desta etapa nova (não repita as anteriores), em até 800 palavras (máximo 4.800 caracteres), com:
- Protagonista: nome e como a narração se refere a ele/si mesmo.
- Personagens: nome, apelido usado na narração e papel/relação (os principais).
- Termos, poderes, lugares e grupos importantes, com o nome que a narração usa.
- Tom e piadas recorrentes do narrador.
- História desta etapa: arcos, lutas e viradas em ordem, cada um com começo, meio e fim, terminando em onde parou (o gancho).
Personagens que já estão nas etapas anteriores: só cite de novo se mudou algo (novo apelido, nova relação, morte).
Não invente nada.
Responda SOMENTE JSON: {"bible":"..."}`;

/** Grava na memória da série o que este projeto criou (resumos, fim da narração e a bíblia atualizada pela IA). */
export async function updateSeriesMemory(p: StudioProject, llm: LLMProvider, log: (m: string) => void): Promise<void> {
  const key = seriesKey(p);
  const m: SeriesMemory = readSeries(p) ?? { key, title: p.series?.trim() || p.title, bible: '', chapters: {}, order: [], lastNarration: '', projects: [], updatedAt: '' };
  const newChapters: string[] = [];
  for (const [ch, sum] of Object.entries(p.chapterContexts ?? {})) {
    if (m.chapters[ch] !== sum) newChapters.push(ch);
    m.chapters[ch] = sum;
    if (!m.order.includes(ch)) m.order.push(ch);
  }
  if (!m.projects.includes(p.id)) m.projects.push(p.id);
  const narration = p.shots.length ? p.shots.map((s) => s.text).filter(Boolean) : Object.values(p.pageScript ?? {});
  const full = narration.join(' ');
  if (full) m.lastNarration = full.slice(-600);
  // nada de novo para a bíblia (nenhum capítulo novo/alterado e a etapa deste projeto já foi escrita pela IA): não gasta IA
  const stages = [...stagesOf(m)];
  const stageId = stageIdOf(p);
  const mine = stages.findIndex((s) => s.projectId === stageId);
  if (!newChapters.length && mine >= 0) {
    m.stages = stages;
    writeSeries(m);
    log(`Memória da série "${m.title}": nenhum capítulo novo, resumo mantido (sem gastar IA)`);
    return;
  }
  try {
    // contexto: tudo o que as etapas ANTERIORES já registraram (a nova etapa só escreve o que é dela)
    const before = stages.filter((s) => s.projectId !== stageId).map((s, i) => `Etapa ${i + 1}: ${s.bible}`).join('\n\n');
    const raw = await llm.complete({
      system: SYSTEM_BIBLE,
      prompt:
        `Série: ${m.title}\nMemória das etapas anteriores (não repita, só continue): ${before || '(vazia, esta é a primeira etapa)'}\n` +
        `Capítulos desta etapa:\n${(newChapters.length ? newChapters : Object.keys(p.chapterContexts ?? {})).map((c) => `- ${c}: ${m.chapters[c]}`).join('\n')}\n` +
        (full ? `Começo da narração: "${full.slice(0, 2500)}"\nFim da narração: "${full.slice(-2500)}"` : ''),
      maxTokens: 3500,
      temperature: 0.3,
      tier: 'small', // resumir/organizar: não precisa do modelo grande
    });
    const bible = String((extractJson(raw) as { bible?: string }).bible ?? '').trim().slice(0, STAGE_CHARS);
    if (bible) {
      const stage = { projectId: stageId, title: p.title, bible };
      if (mine >= 0) stages[mine] = stage;
      else stages.push(stage);
      m.stages = stages;
      m.bible = bible;
    }
    log(`Memória da série "${m.title}" atualizada: etapa ${stages.findIndex((s) => s.projectId === p.id) + 1} de ${stages.length}, ${bible.length} caracteres (${m.order.length} capítulo(s) no total)`);
  } catch (e) {
    log(`Memória da série: a IA não atualizou o resumo (${(e as Error).message.slice(0, 150)}); resumos dos capítulos salvos mesmo assim`);
  }
  writeSeries(m);
}

const safeFileName = (s: string) => s.replace(/[<>:"/\|?*\x00-\x1f]/g, '').trim().slice(0, 60) || 'manga';

/**
 * Renomeia o projeto por inteiro: título, campo "Série" (se preenchido), memória da série (arquivo, chave e nomes)
 * e o arquivo do último vídeo. Assim um projeto novo com o nome antigo nasce sem herdar nada deste.
 * Se outro projeto ainda usa a mesma memória, ela é copiada (a original continua com ele) em vez de movida.
 */
export function renameProject(id: string, newTitle: string): { project: StudioProject; note?: string } {
  const title = newTitle.trim();
  if (!title) throw new RenameError('O nome não pode ficar vazio', 400);
  const p = peekProject(id);
  if (!p) throw new RenameError('Projeto não encontrado', 404);
  if (projectJobs(id).some((j) => j.status === 'running')) throw new RenameError('Este projeto tem um processo rodando. Espere terminar ou cancele antes de renomear.', 409);

  const series = p.series?.trim() ? title : p.series;
  const oldKey = seriesKey(p);
  const newKey = seriesKey({ title, series });
  const oldFile = fileOf(oldKey);
  const hasMemory = fs.existsSync(oldFile);
  let note: string | undefined;

  if (newKey === oldKey) {
    if (hasMemory) note = 'O novo nome só difere em números ou capítulos, então a memória da série continua a mesma. Um projeto novo com o nome antigo vai herdá-la.';
  } else if (hasMemory) {
    if (fs.existsSync(fileOf(newKey))) throw new RenameError(`Já existe uma memória de série com esse nome ("${newKey}"). Escolha outro nome.`, 409);
    const m = JSON.parse(fs.readFileSync(oldFile, 'utf8')) as SeriesMemory;
    m.key = newKey;
    m.title = series?.trim() || title;
    m.stages = m.stages?.map((s) => (s.projectId === id ? { ...s, title } : s));
    writeSeries(m);
    if (listProjects().some((o) => o.id !== id && seriesKey(o) === oldKey)) note = 'Outro projeto ainda usa a memória do nome antigo, então ela foi copiada e a original continua com ele.';
    else fs.rmSync(oldFile, { force: true });
  }

  const project = updateProject(id, (cur) => {
    cur.title = title;
    cur.series = series;
    const file = cur.lastRender?.file;
    const oldBase = safeFileName(p.title);
    if (!file || !path.basename(file).startsWith(`${oldBase}_`) || !fs.existsSync(file)) return;
    const to = path.join(path.dirname(file), safeFileName(title) + path.basename(file).slice(oldBase.length));
    try {
      if (!fs.existsSync(to)) {
        fs.renameSync(file, to);
        cur.lastRender!.file = to;
      }
    } catch (e) {
      note = [note, `O arquivo do vídeo manteve o nome antigo (${(e as Error).message}).`].filter(Boolean).join(' ');
    }
  });
  return { project, note };
}

export class RenameError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
