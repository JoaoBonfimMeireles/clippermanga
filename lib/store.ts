// Projetos em <pasta do app>/projetos/<id>/ (project.json + páginas + vídeos renderizados em videos/).
// Antes ficavam em ../videos/data/manga-studio: na primeira execução são movidos para cá (mesmo disco = instantâneo).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataPaths } from '@clipper/shared/server';
import type { StudioProject } from './types';

const OLD_DIR = path.join(dataPaths.root, 'manga-studio');
const NEW_DIR = process.env.MANGA_PROJECTS_DIR ? path.resolve(process.env.MANGA_PROJECTS_DIR) : path.join(process.cwd(), 'projetos');
const gm = globalThis as unknown as { __mangaDir?: string };

/** Move a pasta antiga para a nova (uma vez) e traz junto o último vídeo de cada projeto. Se falhar, segue usando a antiga. */
function resolveStudioDir(): string {
  if (gm.__mangaDir) return gm.__mangaDir;
  let dir = NEW_DIR;
  if (fs.existsSync(OLD_DIR) && !fs.existsSync(NEW_DIR)) {
    try {
      fs.renameSync(OLD_DIR, NEW_DIR);
      console.log(`[manga] projetos movidos para ${NEW_DIR}`);
      for (const id of fs.readdirSync(NEW_DIR)) {
        const f = path.join(NEW_DIR, id, 'project.json');
        if (!fs.existsSync(f)) continue;
        try {
          const p = JSON.parse(fs.readFileSync(f, 'utf8')) as StudioProject;
          const v = p.lastRender?.file;
          if (!v || !fs.existsSync(v) || v.startsWith(NEW_DIR)) continue;
          const to = path.join(NEW_DIR, id, 'videos', path.basename(v));
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.renameSync(v, to);
          p.lastRender!.file = to;
          fs.writeFileSync(f, JSON.stringify(p, null, 2), 'utf8');
        } catch (e) {
          console.warn(`[manga] não deu para mover o vídeo de ${id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      console.warn(`[manga] não deu para mover ${OLD_DIR} → ${NEW_DIR} (${(e as Error).message}); usando a pasta antiga por enquanto`);
      dir = OLD_DIR;
    }
  }
  return (gm.__mangaDir = dir);
}

export const studioDir = () => resolveStudioDir();
export const projectDir = (id: string) => path.join(studioDir(), path.basename(id));

export function listProjects(): StudioProject[] {
  if (!fs.existsSync(studioDir())) return [];
  return fs
    .readdirSync(studioDir())
    .map(peekProject)
    .filter((p): p is StudioProject => !!p)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------- cache do project.json ----------
// A tela consulta o projeto o tempo todo (abrir, salvar, jobs, vídeo, narração) e cada leitura relia e fazia o
// parse do arquivo inteiro (centenas de páginas/partes). Agora: um stat por chamada (O(1)); o parse só acontece
// quando o arquivo muda (mtime/tamanho). Mudança feita por fora do app também é vista, porque o stat muda.
// `obj` e `lite` são preguiçosos: gravar não faz parse de novo (só quem LÊ paga), e a lista do painel guarda só o resumo (parse só na primeira consulta depois de cada gravação).
type Cached = { key: string; raw: string; obj?: StudioProject; lite?: { fn: unknown; val: unknown } };
const g = globalThis as unknown as { __mangaProjects?: Map<string, Cached> };
const cache = (g.__mangaProjects ??= new Map());
const fileOf = (id: string) => path.join(projectDir(id), 'project.json');
const statKey = (st: fs.Stats) => `${st.mtimeMs}:${st.size}`;

function loadCached(id: string): Cached | null {
  const f = fileOf(id);
  let st: fs.Stats;
  try {
    st = fs.statSync(f);
  } catch {
    cache.delete(f);
    return null;
  }
  const key = statKey(st);
  const hit = cache.get(f);
  if (hit?.key === key) return hit;
  // gravação em andamento (no Windows o rename pode cair no plano B, que escreve direto): arquivo vazio/cortado por um instante.
  // Tenta de novo em vez de derrubar a tela com "Unexpected end of JSON input".
  let raw = '';
  let obj: StudioProject | undefined;
  for (let i = 0; i < 6 && !obj; i++) {
    try {
      raw = fs.readFileSync(f, 'utf8');
      obj = JSON.parse(raw) as StudioProject;
    } catch (e) {
      if (i === 5 || (e as NodeJS.ErrnoException).code === 'ENOENT') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
    }
  }
  const entry: Cached = { key, raw, obj };
  cache.set(f, entry);
  return entry;
}

/** Projeto para ALTERAR: cópia nova a cada chamada (sem ler o disco de novo se nada mudou). */
export function readProject(id: string): StudioProject | null {
  const c = loadCached(id);
  if (!c) return null;
  return JSON.parse(c.raw) as StudioProject;
}

/** Projeto só para LER (objeto compartilhado do cache: não altere). Mais barato que readProject. */
export function peekProject(id: string): StudioProject | null {
  try {
    const c = loadCached(id);
    if (!c) return null;
    return (c.obj ??= JSON.parse(c.raw) as StudioProject);
  } catch {
    // arquivo sendo gravado/ilegível no instante: a lista usa a última versão boa em vez de dar erro 500 na tela inicial
    return cache.get(fileOf(id))?.obj ?? null;
  }
}

/**
 * Resumo de todos os projetos (só contagens/nomes) para a lista do painel. O resumo de cada projeto é calculado UMA vez por versão do arquivo
 * e lembrado: quando um job regrava o project.json, a gravação já deixa o resumo pronto (sem reler/parsear projetos de 2 MB a cada consulta).
 */
export function listSummaries<T extends { updatedAt: string }>(fn: (p: StudioProject) => T): T[] {
  if (!fs.existsSync(studioDir())) return [];
  const out: T[] = [];
  for (const id of fs.readdirSync(studioDir())) {
    try {
      const c = loadCached(id);
      if (!c) continue;
      if (c.lite?.fn !== fn) c.lite = { fn, val: fn((c.obj ??= JSON.parse(c.raw) as StudioProject)) };
      out.push(c.lite.val as T);
    } catch {
      /* arquivo sendo gravado: some da lista só neste instante */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** JSON do projeto como está no disco + uma versão (para ETag/304), sem stringify de novo. */
export function readProjectRaw(id: string): { raw: string; version: string } | null {
  const c = loadCached(id);
  return c ? { raw: c.raw, version: c.key } : null;
}

export function writeProject(p: StudioProject): StudioProject {
  p.updatedAt = new Date().toISOString();
  fs.mkdirSync(projectDir(p.id), { recursive: true });
  const f = fileOf(p.id);
  const tmp = `${f}.${randomUUID().slice(0, 8)}.tmp`;
  const raw = JSON.stringify(p, null, 2);
  fs.writeFileSync(tmp, raw, 'utf8');
  try {
    fs.renameSync(tmp, f);
  } catch {
    // Windows: rename falha com o arquivo aberto; grava direto
    fs.writeFileSync(f, fs.readFileSync(tmp));
    fs.rmSync(tmp, { force: true });
  }
  // já deixa no cache o que acabou de gravar (cópia própria: quem chamou pode continuar mexendo em `p`)
  try {
    cache.set(f, { key: statKey(fs.statSync(f)), raw });
  } catch {
    cache.delete(f);
  }
  return p;
}

/** Aplica uma mudança em cima da versão mais nova no disco (jobs e editor gravam ao mesmo tempo). */
export function updateProject(id: string, fn: (p: StudioProject) => void): StudioProject {
  const p = readProject(id);
  if (!p) throw new Error('Projeto não encontrado');
  fn(p);
  return writeProject(p);
}

export function createProject(title: string): StudioProject {
  const ts = new Date().toISOString();
  return writeProject({ id: randomUUID(), title, context: '', format: 'horizontal', narration: 'voice', scrollEdit: true, pages: [], shots: [], lastRender: null, createdAt: ts, updatedAt: ts });
}

export function deleteProject(id: string): void {
  cache.delete(fileOf(id));
  fs.rmSync(projectDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  if (fs.existsSync(projectDir(id))) throw new Error('A pasta do projeto não pôde ser apagada (algum arquivo está em uso?)');
  forgetProject(id);
}

/** Tira o projeto excluído do que fica fora da pasta dele: memória da série e perguntas do aprendizado. */
function forgetProject(id: string): void {
  const dir = path.join(studioDir(), '_series');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : []) {
    const f = path.join(dir, name);
    try {
      const m = JSON.parse(fs.readFileSync(f, 'utf8')) as { projects?: string[]; stages?: { projectId: string }[] };
      const mine = (x: string) => x === id || x.startsWith(`${id}:`);
      if (!m.projects?.some(mine) && !m.stages?.some((s) => mine(s.projectId))) continue;
      m.projects = (m.projects ?? []).filter((x) => !mine(x));
      m.stages = m.stages?.filter((s) => !mine(s.projectId));
      if (!m.projects.length) fs.rmSync(f, { force: true }); // a memória era só dele
      else fs.writeFileSync(f, JSON.stringify(m, null, 2), 'utf8');
    } catch {
      /* arquivo de memória quebrado: não impede a exclusão */
    }
  }
  const learn = path.join(studioDir(), '_aprendizado.json');
  try {
    const l = JSON.parse(fs.readFileSync(learn, 'utf8')) as { questions?: { projectId: string }[] };
    if (l.questions?.some((q) => q.projectId === id)) {
      l.questions = l.questions.filter((q) => q.projectId !== id);
      fs.writeFileSync(learn, JSON.stringify(l, null, 2), 'utf8');
    }
  } catch {
    /* sem aprendizado ainda */
  }
}

/**
 * Duplica um projeto: páginas, linha do tempo, contexto e gravações da narração. Não copia o vídeo renderizado
 * nem o progresso salvo/caches (.progress); a cópia nasce com outro id e "(cópia)" no nome.
 */
export function duplicateProject(id: string): StudioProject {
  const src = readProject(id);
  if (!src) throw new Error('Projeto não encontrado');
  const ts = new Date().toISOString();
  const copy: StudioProject = { ...structuredClone(src), id: randomUUID(), title: `${src.title} (cópia)`, lastRender: null, createdAt: ts, updatedAt: ts };
  const from = projectDir(id);
  const to = projectDir(copy.id);
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) {
    if (entry === 'project.json' || entry === '.progress' || entry === 'videos' || entry.endsWith('.tmp')) continue;
    fs.cpSync(path.join(from, entry), path.join(to, entry), { recursive: true, filter: (f) => !f.split(/[\/]/).includes('fx') });
  }
  return writeProject(copy);
}
