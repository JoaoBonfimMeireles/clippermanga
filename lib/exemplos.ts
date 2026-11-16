// Assets de exemplo: até 5 shorts de referência (vídeo + título + números de desempenho). Ficam em <studio>/_exemplos/.
// A IA dos shorts lê o ranking (título, duração, views, retenção) e imita o que funcionou. O vídeo em si fica
// guardado para você rever; a IA de texto só enxerga os dados. Cheio (5): apague o pior para entrar um novo.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { studioDir } from './store';
import { audioDuration } from './media';
import { extractJson } from '@clipper/editing-planner';
import { createMangaLLM } from './llm';
import { visualLessonsPrompt } from './review';
import { transcribe } from '@clipper/ai-providers';
import { getAppSettings } from '@clipper/shared/server';
import { runFfmpeg } from '@clipper/video-processing';

export const MAX_EXEMPLOS = 5;
/** Shorts que deram errado: também até 15. A IA lê o motivo e passa a evitar o mesmo erro (vale para todos os projetos). */
export const MAX_RUINS = 15;
export type ExemploKind = 'good' | 'bad';

export interface Exemplo {
  id: string;
  title: string;
  file: string; // nome do arquivo dentro de _exemplos/
  url?: string; // origem, quando baixado do YouTube
  description?: string;
  duration?: number; // segundos
  views?: number;
  likes?: number;
  retention?: number; // % média visualizada (YouTube Studio)
  subs?: number; // inscritos ganhos
  kind?: ExemploKind; // ausente = 'good' (deu certo); 'bad' = deu errado, a IA aprende o que NÃO fazer
  note?: string; // por que funcionou (good) / por que deu errado (bad)
  avoid?: string[]; // só 'bad': regras do que evitar, extraídas pela IA; entram nos prompts de shorts e edição
  transcript?: string; // fala do short (legenda automática do YouTube)
  analysis?: string; // o que a IA concluiu que funcionou (gancho, estrutura, título); entra no prompt dos shorts
  analyzedAt?: string;
  addedAt: string;
}

const dir = () => path.join(studioDir(), '_exemplos');
const indexFile = () => path.join(dir(), 'index.json');
export const isBad = (e: Exemplo) => e.kind === 'bad';
export const exemploPath = (e: Exemplo) => path.join(dir(), path.basename(e.file));

export function readExemplos(): Exemplo[] {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), 'utf8')) as Exemplo[];
  } catch {
    return [];
  }
}
function write(list: Exemplo[]) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(list, null, 2), 'utf8');
}

/** Nota de desempenho: views que ficaram até o fim (views × retenção). Sem números ainda = 0. */
export const score = (e: Exemplo) => (e.views ?? 0) * ((e.retention ?? 0) / 100);

/** Do melhor para o pior. */
export const ranked = (list = readExemplos()) => list.filter((e) => !isBad(e)).sort((a, b) => score(b) - score(a));
/** Os que deram errado, do mais recente para o mais antigo. */
export const bads = (list = readExemplos()) => list.filter(isBad).sort((a, b) => b.addedAt.localeCompare(a.addedAt));

export function weakest(list = readExemplos()): Exemplo | undefined {
  return ranked(list).at(-1);
}

function assertRoom(kind: ExemploKind) {
  if (kind === 'bad') {
    if (bads().length >= MAX_RUINS) throw new Error(`Já são ${MAX_RUINS} shorts que deram errado. Apague o mais antigo para entrar um novo.`);
    return;
  }
  const w = weakest();
  if (ranked().length >= MAX_EXEMPLOS) throw new Error(`Já são ${MAX_EXEMPLOS} exemplos. Apague o pior${w ? ` ("${w.title}")` : ''} para entrar um novo.`);
}

const clean = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Guarda um vídeo que você enviou. */
export async function addUploaded(buf: Buffer, originalName: string, title: string, kind: ExemploKind = 'good'): Promise<Exemplo> {
  assertRoom(kind);
  const id = randomUUID().slice(0, 8);
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
  const file = `${id}${ext}`;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), file), buf);
  const e: Exemplo = { id, title: clean(title, 120) || path.basename(originalName, path.extname(originalName)), file, ...(kind === 'bad' ? { kind } : {}), addedAt: new Date().toISOString() };
  try {
    e.duration = Math.round(await audioDuration(path.join(dir(), file)));
  } catch {
    /* sem duração: tudo bem */
  }
  write([...readExemplos(), e]);
  return e;
}

// ---------- download pela URL do YouTube (precisa do yt-dlp instalado) ----------
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com']);
const bin = () => process.env.YT_DLP_PATH || 'yt-dlp';

function run(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin(), args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new Error(missing ? 'yt-dlp não encontrado. Instale (winget install yt-dlp) ou defina YT_DLP_PATH no .env.' : clean(stderr || err.message, 400)));
      } else resolve(stdout);
    });
  });
}

/** Baixa o vídeo (só YouTube, sem playlist) e já traz título, descrição, duração, views e likes públicos. */
export async function addFromUrl(rawUrl: string, kind: ExemploKind = 'good'): Promise<Exemplo> {
  assertRoom(kind);
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new Error('URL inválida');
  }
  if (u.protocol !== 'https:' || !YT_HOSTS.has(u.hostname)) throw new Error('Só aceito links do YouTube (https://youtube.com/shorts/... ou youtu.be/...)');
  const id = randomUUID().slice(0, 8);
  fs.mkdirSync(dir(), { recursive: true });
  const meta = JSON.parse(await run(['--no-playlist', '--no-warnings', '-J', u.href], 60_000)) as {
    title?: string; description?: string; duration?: number; view_count?: number; like_count?: number;
  };
  // o YouTube hoje costuma só oferecer vídeo e áudio separados: baixa os dois e junta com o ffmpeg (cai para arquivo único se houver)
  await run(['--no-playlist', '--no-warnings', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '-o', path.join(dir(), `${id}.%(ext)s`), u.href], 10 * 60_000);
  const file = fs.readdirSync(dir()).find((f) => f.startsWith(`${id}.`) && !f.endsWith('.part'));
  if (!file) throw new Error('O download terminou mas o arquivo não apareceu');
  const e: Exemplo = {
    id,
    title: clean(meta.title ?? '', 120) || 'Short sem título',
    file,
    url: u.href,
    description: clean(meta.description ?? '', 600) || undefined,
    duration: meta.duration ? Math.round(meta.duration) : undefined,
    views: meta.view_count,
    likes: meta.like_count,
    ...(kind === 'bad' ? { kind } : {}),
    addedAt: new Date().toISOString(),
  };
  write([...readExemplos(), e]);
  // já lê e guarda o que funcionou; se a IA falhar, o vídeo continua salvo e dá para analisar depois
  await analyzeExemplo(e.id).catch((err) => console.warn(`[exemplos] análise falhou: ${(err as Error).message}`));
  return readExemplos().find((x) => x.id === id) ?? e;
}

/** Legenda automática do YouTube (pt) como texto corrido; vazio se o vídeo não tiver. */
async function fetchTranscript(url: string): Promise<string> {
  const tmp = path.join(dir(), `_sub_${randomUUID().slice(0, 6)}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await run(['--no-playlist', '--no-warnings', '--skip-download', '--write-auto-subs', '--write-subs', '--sub-langs', 'pt.*,pt', '--sub-format', 'vtt', '-o', path.join(tmp, 's.%(ext)s'), url], 60_000);
    const f = fs.readdirSync(tmp).find((n) => n.endsWith('.vtt'));
    if (!f) return '';
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of fs.readFileSync(path.join(tmp, f), 'utf8').split(/\r?\n/)) {
      const t = raw.replace(/<[^>]+>/g, '').trim();
      if (!t || /^(WEBVTT|Kind:|Language:)/.test(t) || /-->/.test(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return clean(out.join(' '), 3000);
  } catch {
    return '';
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Shorts quase nunca têm legenda: transcreve a fala do próprio vídeo com o Whisper local do app. */
async function whisperTranscript(video: string): Promise<string> {
  const tmp = path.join(dir(), `_tr_${randomUUID().slice(0, 6)}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const wav = path.join(tmp, 'a.wav');
    await runFfmpeg(['-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    const s = getAppSettings();
    const tr = await transcribe({ audioPath: wav, outputJson: path.join(tmp, 'tr.json'), model: s.whisperModel || 'small', device: s.whisperDevice || 'auto', language: 'pt' });
    return clean(tr.segments.map((sg) => sg.text).join(' '), 3000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const SYSTEM_ANALYSIS =`Você analisa shorts de YouTube de um canal brasileiro que resume mangás/manhwas em vídeo. Recebe título, descrição, duração, números e a fala do short. Escreva em português, bem objetivo, em tópicos curtos (máx. 1000 caracteres no total, sem negrito, cada item em uma linha), com estes itens:
- Gancho: como os primeiros segundos prendem (a frase/ação de abertura).
- Estrutura: início, meio e fim do short, e como termina.
- Título: o padrão do título que funcionou (maiúsculas, promessa, curiosidade).
- Ritmo/duração: o que a duração e o tamanho das frases indicam.
- Replicar: 2-3 regras práticas para cortes futuros.
Não invente números nem fatos que não estejam nos dados.`;

const SYSTEM_BAD = `Você analisa shorts de YouTube que DERAM ERRADO (pouca audiência/retenção) de um canal brasileiro que resume mangás/manhwas em vídeo. Recebe título, descrição, duração, números, a fala do short e a anotação do dono sobre por que não funcionou. Responda SOMENTE JSON:
{"analysis":"texto em tópicos curtos (máx. 900 caracteres, uma linha por item): Gancho fraco: ...; Estrutura: ...; Título: ...; Ritmo/duração: ...; Final: ...","avoid":["regra curta e acionável do que NÃO fazer nos próximos shorts", "... (de 2 a 5 regras)"]}
Priorize a anotação do dono (é a verdade). Não invente números nem fatos que não estejam nos dados.`;

/** A IA lê o short (título, fala, números) e guarda o que funcionou; isso entra no prompt dos próximos shorts. */
export async function analyzeExemplo(id: string): Promise<Exemplo> {
  const e = readExemplos().find((x) => x.id === id);
  if (!e) throw new Error('Exemplo não encontrado');
  let transcript = e.transcript || (e.url ? await fetchTranscript(e.url) : '');
  if (!transcript) transcript = await whisperTranscript(exemploPath(e)).catch((err) => (console.warn(`[exemplos] whisper falhou: ${(err as Error).message}`), ''));
  const data = [
    `Título: ${e.title}`,
    e.description && `Descrição: ${e.description}`,
    e.duration != null && `Duração: ${e.duration}s`,
    e.views != null && `Views: ${e.views}`,
    e.likes != null && `Likes: ${e.likes}`,
    e.retention != null && `Retenção: ${e.retention}%`,
    e.note && `Anotação do dono: ${e.note}`,
    transcript ? `Fala do short:\n${transcript}` : 'Fala do short: (indisponível; analise só pelo título, descrição e duração)',
  ].filter(Boolean).join('\n');
  // trava de gasto: aqui o Claude pode ser usado quando a OmniRoute esgotar (regra do usuário: sempre sim)
  const llm = createMangaLLM({ paidGate: { allowed: () => true, denied: () => false, ask: () => undefined } });
  let out: string;
  let avoid: string[] | undefined;
  if (isBad(e)) {
    // o gestor (Opus) conclui o que evitar
    const j = extractJson(await llm.complete({ system: SYSTEM_BAD, prompt: data, maxTokens: 1500, temperature: 0.3, tier: 'manager' })) as { analysis?: unknown; avoid?: unknown };
    out = clean(String(j.analysis ?? ''), 1600);
    avoid = (Array.isArray(j.avoid) ? j.avoid : []).map((x) => clean(String(x), 200)).filter(Boolean).slice(0, 5);
    if (!out && !avoid.length) throw new Error('A IA não devolveu a análise; tente de novo');
  } else out = clean(await llm.complete({ system: SYSTEM_ANALYSIS, prompt: data, maxTokens: 1200, temperature: 0.3, tier: 'manager' }), 1600);
  const list = readExemplos();
  const cur = list.find((x) => x.id === id);
  if (!cur) throw new Error('Exemplo apagado durante a análise');
  cur.transcript = transcript || undefined;
  cur.analysis = out;
  cur.avoid = avoid;
  cur.analyzedAt = new Date().toISOString();
  write(list);
  return cur;
}

const num = (v: unknown) => (v === '' || v == null || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Number(v)));

/** Edita título, números do YouTube Studio e a anotação. */
export function updateExemplo(id: string, patch: Partial<Record<'title' | 'note' | 'views' | 'likes' | 'retention' | 'subs', unknown>>): Exemplo {
  const list = readExemplos();
  const e = list.find((x) => x.id === id);
  if (!e) throw new Error('Exemplo não encontrado');
  if (typeof patch.title === 'string' && patch.title.trim()) e.title = clean(patch.title, 120);
  if (typeof patch.note === 'string') e.note = clean(patch.note, 600) || undefined;
  for (const k of ['views', 'likes', 'subs'] as const) if (k in patch) e[k] = num(patch[k]);
  if ('retention' in patch) e.retention = Math.min(100, num(patch.retention) ?? 0) || undefined;
  write(list);
  return e;
}

export function removeExemplo(id: string): void {
  const list = readExemplos();
  const e = list.find((x) => x.id === id);
  if (!e) return;
  fs.rmSync(exemploPath(e), { force: true });
  write(list.filter((x) => x.id !== id));
}

/** Regras do que NÃO fazer, tiradas dos shorts que deram errado (todas as obras/projetos). */
export function avoidList(): string[] {
  return [...new Set(bads().flatMap((e) => e.avoid ?? []))].slice(0, 40);
}

/** Bloco "o que evitar" para qualquer prompt de IA (shorts e edição). */
export function avoidPrompt(max = 5000): string {
  const list = bads();
  if (!list.length) return '';
  const rules = avoidList();
  const lines = list.map((e) => `- "${e.title}"${e.views != null ? ` (${e.views} views${e.retention != null ? `, ${e.retention}% de retenção` : ''})` : ''}: ${e.note || e.analysis?.slice(0, 200) || 'deu errado'}`);
  return `O QUE NÃO FAZER (shorts do canal que deram errado; nunca repita estes erros):\n${lines.join('\n')}${rules.length ? `\nRegras para evitar:\n${rules.map((r) => `- ${r}`).join('\n')}` : ''}\n\n`.slice(0, max);
}

/** Bloco para o prompt dos shorts: do melhor para o pior, para a IA imitar o topo e fugir do fim; depois o que não fazer. */
export function exemplosPrompt(max = 5000): string {
  const list = ranked().filter((e) => score(e) > 0 || e.views);
  const lines = list.map((e, i) => {
    const m = [e.views != null && `${e.views} views`, e.retention != null && `${e.retention}% de retenção`, e.subs != null && `${e.subs} inscritos`, e.duration != null && `${e.duration}s`].filter(Boolean).join(', ');
    return `${i + 1}. "${e.title}" (${m})${e.note ? ` — ${e.note}` : ''}${i < 3 && e.analysis ? `\n   O que funcionou: ${e.analysis}` : ''}`;
  });
  const good = lines.length ? `SHORTS DE REFERÊNCIA DO CANAL (do que mais performou ao que menos; imite o estilo de gancho, título e duração dos primeiros, evite o dos últimos, sem copiar o título):\n${lines.join('\n')}\n\n`.slice(0, max) : '';
  return good + avoidPrompt() + visualLessonsPrompt();
}
