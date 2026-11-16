// Material de publicação (fim da etapa 3): título, descrição (pt-BR) e tags para o YouTube, e a thumbnail.
// Texto: IA de texto (createMangaLLM) com o contexto do projeto (obra, resumos dos capítulos, roteiro).
// Thumb: a IA de visão escolhe a página/recorte e o texto da thumb vendo as referências do usuário; depois
//  1) tenta um modelo de IMAGEM do OmniRoute (/v1/images/generations, lista em OMNIROUTE_IMAGE_MODELS);
//  2) sempre monta uma thumb com a página do mangá + texto (sharp), que funciona sem modelo de imagem.
// Cada etapa fica salva em lib/checkpoint.ts: rodar de novo reaproveita o que já saiu.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type SharpType from 'sharp';
// sharp fica no node_modules do monorepo ../videos (este app não tem node_modules próprio): carrega de lá em tempo de execução.
const sharp = process.getBuiltinModule('node:module').createRequire(path.join(process.env.VIDEOS_DIR ? path.resolve(process.env.VIDEOS_DIR) : path.resolve(process.cwd(), '../videos'), 'node_modules', 'x.js'))('sharp') as typeof SharpType;
import { extractJson } from '@clipper/editing-planner';
import { createMangaLLM } from './llm';
import { omniBaseUrl, omniConfigured } from './omniroute';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from './checkpoint';
import { projectDir, readProject, updateProject } from './store';
import type { JobCtx } from './jobs';
import type { PublishInfo, Rect, StudioProject } from './types';

const W = 1280;
const H = 720;
const CANDIDATES = 8;
const IMAGE_MODELS = () =>
  (process.env.OMNIROUTE_IMAGE_MODELS?.trim() || 'gemini/gemini-3.1-flash-image-preview,openrouter/google/gemini-2.5-flash-image,huggingface/black-forest-labs/FLUX.1-schnell')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const SYSTEM_META = `Você cria o material de publicação de um vídeo do YouTube que resume/narra um mangá, em português do Brasil.
Responda só JSON: {"titles": string[3], "description": string, "tags": string[]}.
- titles: EXATAMENTE 3 títulos DIFERENTES para teste A/B (ângulos diferentes do gancho: ex. poder/ação, mistério/curiosidade, personagem/conflito), SEM colchetes e sem número de capítulo (o app acrescenta). Cada um com até 85 caracteres.
- Regras de cada título: MUITO chamativo: descubra o GANCHO de interesse principal da obra (o que faz o público desse gênero clicar: harém/romance com várias garotas, dinheiro/fortuna/ficar rico/milionário, poder/força/influência/subir de nível, guerra/batalhas/exército, vingança, sobrevivência no apocalipse, etc.) e foque o título NELE, de forma bem chamativa e exagerada no bom sentido (ex.: obra sobre ter uma mansão no apocalipse e ficar rico → "Ele ficou MILIONÁRIO no fim do mundo com uma mansão secreta"). Use palavras fortes, números e MAIÚSCULAS em 1-2 palavras-chave; fiel à história, sem mentir nem prometer o que não acontece.
- description: 3 a 5 parágrafos curtos em pt-BR: gancho inicial sem spoiler do final, do que se trata o vídeo (obra e capítulos), 2 a 4 linhas com marcos da história, convite para comentar/curtir/se inscrever, e no fim 3 a 5 hashtags. Natural, sem exagero de emojis.
- tags: 15 a 25 tags curtas (nome da obra, personagens, gênero, "mangá", "resumo de mangá", "anime", variações em inglês quando comuns), sem "#", total abaixo de 480 caracteres.`;

const SYSTEM_THUMB = `Você é diretor de arte de thumbnails do YouTube para vídeos de resumo de mangá.
Recebe: o pedido do usuário, as imagens de REFERÊNCIA do estilo desejado (se houver, vêm primeiro) e depois PÁGINAS candidatas do mangá numeradas a partir de 1.
Responda só JSON: {"page": number, "focus": {"x0": n, "y0": n, "x1": n, "y1": n}, "text": string, "imagePrompt": string}.
- page: a página candidata com o quadro mais impactante para a thumb (rosto expressivo, ação, revelação).
- focus: recorte desse quadro em frações da página (0..1), preferindo região sem balões de fala, mais largo que alto se possível.
- text: 2 a 5 palavras em MAIÚSCULAS, pt-BR, que dão vontade de clicar (sem spoiler do final).
- imagePrompt: em inglês, descrição de uma thumbnail 16:9 no estilo das referências e do pedido (composição, cores, personagem, expressão, estilo mangá/anime), incluindo o texto grande "<text>" escrito na imagem.`;

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const clamp = (x: unknown, d: number) => (typeof x === 'number' && isFinite(x) ? Math.min(1, Math.max(0, x)) : d);

async function toLLMImage(file: string, maxSide = 640) {
  const buf = await sharp(file).rotate().resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return { mimeType: 'image/jpeg' as const, base64: buf.toString('base64') };
}

/** Contexto da obra para a IA: obra, resumos dos capítulos e o roteiro narrado (cortado para caber). */
function projectContext(p: StudioProject): string {
  const chapters = [...new Set(p.pages.map((x) => x.chapter))];
  const ctxs = chapters.map((c) => (p.chapterContexts?.[c] ? `- ${c}: ${p.chapterContexts[c]}` : `- ${c}`)).join('\n');
  const narr = p.shots.map((s) => s.text.trim()).filter(Boolean);
  const script = (narr.length ? narr : Object.values(p.pageScript ?? {})).join(' ').replace(/\s+/g, ' ');
  return [`Título do projeto: ${p.title}`, p.context && `Obra: ${p.context.slice(0, 1500)}`, `Capítulos:\n${ctxs}`, script && `Narração do vídeo:\n${script.slice(0, 12_000)}`, p.lastRender && `Duração: ${Math.round(p.lastRender.duration)} s`]
    .filter(Boolean)
    .join('\n\n');
}

/** Páginas candidatas: as das partes com mais impacto (ou espalhadas pela linha do tempo). */
function candidates(p: StudioProject) {
  const seen = new Set<string>();
  const ranked = [...p.shots].sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0) || (b.kind === 'action' ? 1 : 0) - (a.kind === 'action' ? 1 : 0));
  const out: { pageId: string; focus: Rect }[] = [];
  for (const s of ranked) {
    if (seen.has(s.pageId) || s.focus === undefined) continue;
    seen.add(s.pageId);
    out.push({ pageId: s.pageId, focus: s.focus });
    if (out.length >= CANDIDATES) break;
  }
  if (!out.length) for (const pg of p.pages.slice(0, CANDIDATES)) out.push({ pageId: pg.id, focus: { x0: 0, y0: 0, x1: 1, y1: 1 } });
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Quebra o texto em até 2 linhas para caber na thumb. */
function lines(text: string): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length <= 2) return [words.join(' ')];
  const half = Math.ceil(words.length / 2);
  return [words.slice(0, half).join(' '), words.slice(half).join(' ')];
}

/** Thumb montada: recorte da página em tela cheia (laterais desfocadas se for alto), escurecida embaixo, texto grande. */
async function composeThumb(pageFile: string, focus: Rect, text: string, out: string) {
  const meta = await sharp(pageFile).rotate().metadata();
  const iw = meta.width ?? W, ih = meta.height ?? H;
  const left = Math.round(focus.x0 * iw), top = Math.round(focus.y0 * ih);
  const width = Math.max(16, Math.round((focus.x1 - focus.x0) * iw)), height = Math.max(16, Math.round((focus.y1 - focus.y0) * ih));
  const crop = await sharp(pageFile).rotate().extract({ left, top, width: Math.min(width, iw - left), height: Math.min(height, ih - top) }).toBuffer();
  const bg = await sharp(crop).resize(W, H, { fit: 'cover' }).blur(28).modulate({ brightness: 0.7 }).toBuffer();
  const fg = await sharp(crop).resize(W, H, { fit: 'inside' }).toBuffer();
  const fgMeta = await sharp(fg).metadata();
  const ls = lines(text);
  const size = ls.some((l) => l.length > 14) ? 92 : 118;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  ${ls
    .map((l, i) => {
      const y = H - 60 - (ls.length - 1 - i) * (size + 6);
      return `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Impact, 'Arial Black', Arial, sans-serif" font-weight="900" font-size="${size}" fill="${i === ls.length - 1 ? '#FFD400' : '#FFFFFF'}" stroke="#000" stroke-width="10" paint-order="stroke" letter-spacing="1">${esc(l)}</text>`;
    })
    .join('\n  ')}
</svg>`;
  await sharp(bg)
    .composite([
      { input: fg, left: Math.round((W - (fgMeta.width ?? W)) / 2), top: Math.round((H - (fgMeta.height ?? H)) / 2) },
      { input: Buffer.from(svg), left: 0, top: 0 },
    ])
    .jpeg({ quality: 92 })
    .toFile(out);
}

/** Tenta os modelos de imagem do OmniRoute em ordem. Devolve o primeiro que gerar, ou o motivo de nenhum ter gerado. */
async function generateImage(prompt: string, out: string, ctx: JobCtx, signal: AbortSignal): Promise<{ model?: string; error?: string }> {
  if (!omniConfigured()) return { error: 'OmniRoute não configurado (.env)' };
  const errors: string[] = [];
  for (const model of IMAGE_MODELS()) {
    if (signal.aborted) throw signal.reason;
    ctx.log(`Thumb por IA: tentando ${model}`);
    try {
      const res = await fetch(`${omniBaseUrl()}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OMNIROUTE_API_KEY?.trim()}` },
        body: JSON.stringify({ model, prompt, n: 1, size: '1792x1024', response_format: 'b64_json' }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
      });
      const j = (await res.json().catch(() => null)) as { data?: { b64_json?: string; url?: string }[]; error?: { message?: string } } | null;
      const item = j?.data?.[0];
      let buf: Buffer | null = null;
      if (item?.b64_json) buf = Buffer.from(item.b64_json, 'base64');
      else if (item?.url?.startsWith('data:')) buf = Buffer.from(item.url.split(',')[1] ?? '', 'base64');
      else if (item?.url) buf = Buffer.from(await (await fetch(item.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
      if (!buf?.length) throw new Error(j?.error?.message?.slice(0, 160) || `HTTP ${res.status} sem imagem`);
      await sharp(buf).resize(W, H, { fit: 'cover' }).jpeg({ quality: 92 }).toFile(out);
      return { model };
    } catch (e) {
      if (signal.aborted) throw e;
      const m = `${model}: ${(e as Error).message}`;
      errors.push(m);
      ctx.log(`Thumb por IA falhou — ${m}`);
    }
  }
  return { error: errors.join(' | ') };
}

export interface PublishInput {
  prompt: string;
  /** Imagens de referência enviadas agora (nome + conteúdo). Sem nenhuma, reaproveita as da última vez. */
  refs: { name: string; data: Buffer }[];
  /** Capítulos que o vídeo cobre (ex.: "1-2"): vai entre colchetes no fim de cada título. */
  chapters?: string;
}

export async function generatePublish(projectId: string, input: PublishInput, ctx: JobCtx, signal: AbortSignal): Promise<string> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  if (!p.shots.length) throw new Error('A linha do tempo está vazia');
  const dir = projectDir(projectId);
  const pubDir = path.join(dir, 'publish');
  fs.mkdirSync(path.join(pubDir, 'refs'), { recursive: true });

  // referências: novas substituem as antigas
  let refs = p.publish?.refs ?? [];
  if (input.refs.length) {
    for (const f of fs.readdirSync(path.join(pubDir, 'refs'))) fs.rmSync(path.join(pubDir, 'refs', f), { force: true });
    refs = [];
    for (const [i, f] of input.refs.entries()) {
      const rel = `publish/refs/ref_${i + 1}.jpg`;
      await sharp(f.data).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(path.join(dir, rel));
      refs.push(rel);
    }
  }
  refs = refs.filter((r) => fs.existsSync(path.join(dir, r)));

  const context = projectContext(p);
  const version = hash(`${context}|${input.prompt}|${refs.join(',')}|${input.refs.map((r) => r.data.length).join(',')}`);
  const cp = 'publish';
  const saved = loadCheckpoint<unknown>(projectId, cp, version);
  const llm = createMangaLLM({ paidGate: ctx.paid });
  llm.onNotice = ctx.log;

  // 1) título, descrição e tags
  ctx.progress(0.05, 'Escrevendo título, descrição e tags');
  let meta = saved.get('meta') as { title: string; titles?: string[]; description: string; tags: string[] } | undefined;
  if (!meta) {
    const raw = await llm.complete({
      system: SYSTEM_META,
      prompt: `${context}${input.prompt.trim() ? `\n\nPedido do usuário (para a thumb e o tom do vídeo): ${input.prompt.trim()}` : ''}`,
      maxTokens: 2000,
      temperature: 0.6,
      signal,
    });
    const j = extractJson(raw) as { title?: unknown; titles?: unknown; description?: unknown; tags?: unknown };
    const titles = (Array.isArray(j.titles) ? j.titles : [j.title]).map((t) => String(t ?? '').replace(/\s*\[[^\]]*\]\s*$/, '').trim()).filter(Boolean).slice(0, 3);
    const tags = (Array.isArray(j.tags) ? j.tags : String(j.tags ?? '').split(','))
      .map((t) => String(t).replace(/^#/, '').trim())
      .filter(Boolean);
    const fit: string[] = [];
    for (const t of [...new Set(tags)]) if ([...fit, t].join(',').length <= 480) fit.push(t);
    meta = { title: titles[0] ?? p.title, titles, description: String(j.description ?? '').trim(), tags: fit };
    if (!meta.description) throw new Error('A IA não devolveu a descrição; rode de novo');
    saveCheckpoint(projectId, cp, version, 'meta', meta);
  }
  updateProject(projectId, (cur) => {
    // [capítulos] no fim de cada título (o app acrescenta, a IA não): 1 capítulo = [1]; vários = [1-2]
    const tag = input.chapters?.trim() ? ` [${input.chapters.trim()}]` : '';
    const cut = (t: string) => `${t.length + tag.length > 100 ? t.slice(0, 100 - tag.length).replace(/\s+\S*$/, '').trim() : t}${tag}`;
    const titles = (meta!.titles?.length ? meta!.titles : [meta!.title]).map(cut);
    cur.publish = { ...(cur.publish ?? { thumbs: [], thumbText: '', at: '' }), ...meta!, title: titles[0], titles, chapters: input.chapters?.trim() || undefined, prompt: input.prompt, refs, at: new Date().toISOString() };
  });

  // a thumb não é mais gerada aqui (sem modelo de imagem no plano): só título, descrição e tags
  clearCheckpoint(projectId, cp);
  return 'Publicação pronta: título, descrição e tags'
}
