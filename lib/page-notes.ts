// "Ver uma vez, escrever muitas": a IA de visão olha cada página UMA vez e devolve uma descrição compacta em texto
// (acontecimentos, falas traduzidas e resumidas, personagens e os quadros com a caixa de cada um, tipo, impacto e giro).
// Fica em disco (<projeto>/page-notes.json, com cache por página): resumo do capítulo, roteiro, edição e memória da
// série trabalham só com esse texto. Se a IA cair no Claude, ele não recebe imagem nenhuma nessas etapas.
// As imagens vão reduzidas (lado maior 768 px, preto e branco, JPEG: ~40% menos tokens que 1024 px colorido, com o
// texto dos balões ainda legível); tiras altas de webtoon são fatiadas nas sarjetas. Páginas sem conteúdo (em branco,
// logo e créditos do fim do capítulo) são puladas antes, sem gastar IA. As caixas voltam em frações da imagem enviada e são convertidas para frações da página original.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { claudeLimits, imageFromFile, type LLMImage, type LLMProvider } from '@clipper/ai-providers';
import { extractJson } from '@clipper/editing-planner';
import { runFfmpeg } from '@clipper/video-processing';
import { isClaude } from './ai-meter';
import { cleanRect } from './camera';
import { projectDir } from './store';
import { skillsPrompt } from './skills';
import { framingPrompt } from './learning';
import type { JobCtx } from './jobs';
import type { Rect, StudioPage, StudioProject } from './types';

/** Muda quando o prompt/formato das notas muda: as notas antigas são refeitas. */
export const NOTES_VERSION = 'notes-v1';

export type PanelKind = 'action' | 'reaction' | 'dialogue' | 'scene';
export interface PanelNote {
  /** Caixa justa do conteúdo do quadro (frações da página original). */
  box: Rect;
  /** Caixa menor só do essencial (rosto, golpe), quando ele ocupa só parte de um quadro grande. */
  focus?: Rect;
  what: string;
  kind: PanelKind;
  impact: number;
  rotate: 0 | 90 | -90;
}
export interface PageNote {
  v: string;
  /** Arquivo da página quando a nota foi feita (trocou a imagem → refaz). */
  file: string;
  events: string;
  dialogue: string;
  characters: string[];
  panels: PanelNote[];
  /** Página sem conteúdo (em branco ou quase lisa), pulada sem IA. */
  empty?: boolean;
  /** Nomes já revisados (descrições genéricas trocadas pelos nomes da ficha). */
  namesFixed?: boolean;
}

const NOTES_SYSTEM = `Você lê páginas de mangá/manhwa/webtoon para um canal brasileiro de resumos narrados. Você só DESCREVE; outra etapa escreve a narração e monta o vídeo usando apenas o que você escrever (ela não vê as imagens). Seja fiel e compacto.

NOMES: use sempre o NOME CURTO do personagem, só o nome próprio sem sobrenome (ex.: "Seo Joo-heon" → "Joo-heon"; veja a ficha de personagens no pedido) em vez de "um homem", "uma mulher", "o rapaz". Reconheça pela aparência descrita na ficha. Para o protagonista, "o protagonista" também vale. Só use descrição genérica se o personagem for realmente desconhecido. Quem já está na ficha NUNCA vira "rapaz de cabelo claro", "mulher loira", "alguém" ou "fala não identificada": compare a aparência com a ficha e use o nome. Os personagens marcados como "deste capítulo" são os mais prováveis.

QUEM FALA: cada balão pertence a quem o rabicho (ponta) do balão aponta; balão sem rabicho ou caixa retangular = narração/pensamento de quem está em foco. Não dê a fala a quem está de boca fechada, de costas ou fora do quadro sem motivo. Numa conversa, as falas costumam alternar entre os dois lados: confira se faz sentido quem responde a quem. Uma relíquia/criatura que fala não é o seu dono. Use o "contexto anterior" do pedido para saber quem estava na cena.

FIDELIDADE: descreva só o que está desenhado. Não invente golpe, batida, explosão ou ferimento que não aparece; contato próximo de rostos é beijo/abraço, não ataque. Se a cena for ambígua, diga que é ambígua em vez de adivinhar.

Para cada PÁGINA (pode vir em várias imagens, fatias de cima para baixo da mesma tira):
- "events": o que acontece, em ordem, em 1 a 2 frases curtas (quem faz o quê, viradas, revelações, golpes, emoção). Não repita o que já está nos quadros: dê o sentido da página.
- "dialogue": as falas e narrações que importam para a trama, TRADUZIDAS para português do Brasil em estilo telegráfico e curto ("Fulano: ..."; "Narração: ..."), mantendo informação, tom e revelações. Pule cumprimentos, hesitações ("Ugh...", "O-o quê?!"), repetições, onomatopeias, créditos e avisos. UMA fala por linha, separadas por \\n (nunca ";" ou "|"), sempre "Nome: texto". Vazio se não houver.
- "characters": nomes (ou descrição curta, se não tiver nome) de quem aparece.
- "panels": os quadros com conteúdo, na ordem de leitura. Cada um:
  "img": número da imagem em que ele está;
  "box": [x0,y0,x1,y1] em frações 0..1 DESSA imagem (x da esquerda, y do topo). A caixa é O QUADRO INTEIRO, de borda a borda: toda a largura e toda a altura do quadro desenhado, com personagem INTEIRO (da cabeça aos pés quando aparece assim), arma e criatura inteiras. Essa caixa vira o recorte do vídeo: caixa pequena = imagem ampliada e sem a cena. NUNCA devolva um pedaço (rosto, mão, faixa) de dentro de um quadro maior e NUNCA corte cabeça, corpo ou arma ao meio. Tire só sarjetas, margens, marca d'água e créditos. Balão que faz parte da cena fica dentro; nunca devolva um quadro que seja só balão/caixa de texto (o texto dele vai em "dialogue"). Só divida um quadro quando a altura passa de 1,9 vezes a largura: em trechos que cobrem toda a largura, cada um com uma sub-cena completa;
  "focus": opcional e RARO, só em quadros de impacto 8+ [x0,y0,x1,y1] só do essencial (rosto, reação) quando ele ocupa bem menos da metade do quadro; o focus mostra o rosto/personagem INTEIRO e nunca corta cabeça, corpo ou arma;
  "what": o que o quadro mostra em até 10 palavras (quem, ação/expressão);
  "kind": "action" (luta, golpe, corrida, explosão, poder), "reaction" (rosto, surpresa, emoção), "dialogue" (conversa) ou "scene" (lugar ou personagem novo);
  "impact": 1 a 10, o quanto o momento importa para a história (9-10 clímax/virada/revelação/golpe decisivo/morte/primeira aparição importante; 6-8 ação forte, emoção marcante, informação da trama; 3-5 transição, contexto; 1-2 enchimento). Seja criterioso: nem tudo é 8+;
  "rotate": 90 ou -90 se o quadro foi desenhado de lado (90 = o que está à ESQUERDA vai para cima; -90 = o que está à DIREITA vai para cima), senão 0.
- Desenhos colados ou sobrepostos que mostram o MESMO momento (golpe e quem apanha, quem fala e quem ouve) são UM quadro, com uma caixa só.
- Pule transições, logos, créditos, avisos e páginas sem história (devolva "panels": []).
- PROPAGANDA DA SCAN (regra rígida, vale para o INÍCIO e o RODAPÉ de cada capítulo e para qualquer ponto da tira): "SUPPORT US", "REZO SCANS", "Produce by Rezo Team", rezoscan.org, "Reminder", "read at mgeko", Discord, Ko-fi, Patreon, links e nomes de site/grupo, mascote da scan, "junte-se/recrutamos", créditos de tradução/edição, capas e títulos de divulgação, anúncios de OUTRAS obras, marca d'água (ex.: bilibili) NUNCA são quadros de história, mesmo quando dividem a mesma tira com um quadro real, mesmo com personagem desenhado ou balão ("Okay!") perto deles. Liste só o quadro de história de verdade; se a tira inteira for isso, "panels": []. Não descreva a propaganda em "what"; em "events" escreva só "página de divulgação da scan, sem história".
- NÃO liste quadros de enchimento (impacto 1-2: objeto solto, fundo, repetição sem ação nova). No MÁXIMO 8 quadros por página: junte os parecidos e fique com os que mais importam.
- JSON compacto: sem espaços extras, números com no máximo 2 casas decimais.

FICHA: em "newCharacters", liste quem teve o NOME revelado nestas páginas (fala, apresentação, legenda) e ainda não está na ficha, com a aparência para reconhecer depois (cabelo, roupa, traço marcante; até 15 palavras). Se alguém da ficha ganhou informação nova (cargo, apelido), pode repetir com a aparência atualizada. Vazio se nada novo.

Responda SOMENTE JSON:
{"pages":[{"page":1,"events":"...","dialogue":"...","characters":["..."],"panels":[{"img":1,"box":[0.05,0.02,0.95,0.31],"what":"...","kind":"action","impact":7,"rotate":0}]}],"newCharacters":[{"name":"...","look":"..."}]}`;

// ---- ficha de personagens (nome + aparência), cresce durante a leitura e vai em cada pedido ----
export interface CharacterEntry {
  name: string;
  look: string;
}
const castFile = (projectId: string) => path.join(projectDir(projectId), 'characters.json');
export function readCast(projectId: string): CharacterEntry[] {
  try {
    const v = JSON.parse(fs.readFileSync(castFile(projectId), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function writeCast(projectId: string, cast: CharacterEntry[]) {
  fs.writeFileSync(castFile(projectId), JSON.stringify(cast, null, 1));
}
const GENERIC_NAME = /^(um|uma|o|a|os|as)\s|homem|mulher|rapaz|garota|menino|menina|desconhecid|protagonista|narra/i;
/** Junta os personagens novos na ficha (mesmo nome: atualiza a aparência). Devolve quantos entraram. */
function mergeCast(cast: CharacterEntry[], add: unknown): number {
  let n = 0;
  for (const c of Array.isArray(add) ? add : []) {
    const name = String(c?.name ?? '').trim().slice(0, 40);
    const look = String(c?.look ?? '').trim().slice(0, 140);
    if (!name || GENERIC_NAME.test(name)) continue;
    const old = cast.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (old) {
      if (look) old.look = look;
    } else {
      cast.push({ name, look });
      n++;
    }
  }
  return n;
}
/**
 * Nome curto (só o nome próprio, sem sobrenome): "Seo Joo-heon" → "Joo-heon" (coreano/chinês: sobrenome curto vem
 * antes); "John Smith" → "John".
 */
export function shortName(full: string): string {
  const t = full.trim().split(/\s+/);
  if (t.length < 2) return full.trim();
  return t[0].replace(/-/g, '').length <= 3 ? t.slice(1).join(' ') : t[0];
}
/** Ficha no pedido; `recent` = nomes que já apareceram neste capítulo (vão primeiro, marcados). */
const castText = (cast: CharacterEntry[], recent: Set<string> = new Set()) => {
  if (!cast.length) return 'Ficha de personagens: vazia por enquanto.\n';
  const line = (c: CharacterEntry) => `- ${shortName(c.name)} (${c.name}): ${c.look}`;
  const hot = cast.filter((c) => recent.has(shortName(c.name)) || recent.has(c.name));
  const rest = cast.filter((c) => !hot.includes(c)).slice(-Math.max(20, 80 - hot.length));
  return `Ficha de personagens (use o NOME CURTO, antes do parêntese; nome completo e aparência só para reconhecer):\n${hot.length ? `Deste capítulo:\n${hot.map(line).join('\n')}\nOutros:\n` : ''}${rest.map(line).join('\n')}\n`;
};
/** Falas: uma por linha, mesmo que a IA mande lista, ";" ou "|". */
function normDialogue(d: unknown): string {
  let s = Array.isArray(d) ? d.map(String).join('\n') : String(d ?? '');
  s = s.trim();
  if (!s.includes('\n')) s = s.split(/\s*(?:;|\s\|\s|\s\/\s)\s*(?=[^:;|]{1,40}:)/).join('\n');
  if (!s.includes('\n')) s = s.split(/(?<=[.!?…~])\s+(?=[A-ZÀ-Ú][^:.!?\n]{0,35}:\s)/).join('\n');
  return s.split('\n').map((l) => l.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).join('\n');
}
/** Nome completo → nome curto em todos os campos da nota. Devolve true se mudou algo. */
function shortenNote(n: PageNote, cast: CharacterEntry[]): boolean {
  const before = JSON.stringify(n);
  n.events = shortenNames(n.events, cast);
  n.dialogue = shortenNames(n.dialogue, cast);
  n.characters = [...new Set(n.characters.map((c) => shortenNames(c, cast)))];
  for (const q of n.panels) q.what = shortenNames(q.what, cast);
  return JSON.stringify(n) !== before;
}
/** Troca nomes completos da ficha pelo nome curto num texto. */
function shortenNames(s: string, cast: CharacterEntry[]): string {
  for (const c of cast) {
    const sh = shortName(c.name);
    if (sh !== c.name) s = s.replace(new RegExp(esc(c.name), 'gi'), sh);
  }
  return s;
}

/** Uso do plano do Claude (janela de 5 h), para mostrar no progresso e travar antes de esgotar. */
const STOP_5H = () => Number(process.env.MANGA_CLAUDE_STOP_5H) || 0.95;
function claudeUsageTag(): string {
  const l = claudeLimits();
  if (!l || l.fiveHour == null || Date.now() - l.at > 15 * 60_000) return '';
  const reset = l.fiveHourResetsAt ? `, renova ${new Date(l.fiveHourResetsAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : '';
  return ` · Claude 5h: ${Math.round(l.fiveHour * 100)}%${reset}`;
}

const MAX_SIDE = 768; // página comum: lado maior (mais baixo que isso as falas pequenas começam a sair erradas)
const SLICE_W = 720; // fatias de tira alta: largura máxima
const SLICE_H = 768; // e altura máxima
const TALL = 2.0; // altura/largura acima disso: fatia

/** Propaganda/créditos da scan: nunca vira recorte (rodapé e início de capítulo). */
export const PROMO_RE = /patreon|ko-?fi|discord|support us|apoie|scans?|scanlat|divulga[cç]|an[uú]ncio|publicidade|recrut|cr[eé]ditos|marca d.[aá]gua|watermark|bilibili|tela de suporte|logo d|banner|capa de (divulga|t[ií]tulo)|outras obras|outros t[ií]tulos/i;
/** Descarta quadros de propaganda; se a página inteira foi lida como divulgação, nenhum quadro fica. */
export function stripPromo<T extends { events: string; panels: PanelNote[] }>(n: T): T {
  const page = PROMO_RE.test(n.events);
  const panels = page ? [] : n.panels.filter((q) => !PROMO_RE.test(q.what));
  return panels.length === n.panels.length ? n : { ...n, panels };
}

const notesFile = (projectId: string) => path.join(projectDir(projectId), 'page-notes.json');

export function readNotes(projectId: string): Record<string, PageNote> {
  try {
    const all = JSON.parse(fs.readFileSync(notesFile(projectId), 'utf8')) as Record<string, PageNote>;
    return Object.fromEntries(Object.entries(all).filter(([, n]) => n?.v === NOTES_VERSION).map(([k, n]) => [k, stripPromo(n)]));
  } catch {
    return {};
  }
}

function writeNotes(projectId: string, notes: Record<string, PageNote>) {
  const f = notesFile(projectId);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notes));
  try {
    fs.renameSync(tmp, f);
  } catch {
    fs.writeFileSync(f, fs.readFileSync(tmp));
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Quanto da página tem "tinta" (0..1): reduzida a 64x96 em cinza, a fração de pontos longe da cor do fundo.
 * Medido no Tomb Raider King: logo + créditos do fim do capítulo ficam em 8–12%; páginas com quadro de história, 15%+.
 */
async function inkRatio(img: string): Promise<number> {
  const SW = 64, SH = 96;
  const raw = path.join(os.tmpdir(), `manga-blank-${randomUUID().slice(0, 8)}.gray`);
  try {
    await runFfmpeg(['-i', img, '-vf', `scale=${SW}:${SH},format=gray`, '-f', 'rawvideo', '-frames:v', '1', raw]);
    const px = fs.readFileSync(raw);
    if (px.length < SW * SH) return 1;
    // cor do fundo = a mais comum
    const hist = new Array(256).fill(0);
    for (let i = 0; i < SW * SH; i++) hist[px[i]]++;
    const bg = hist.indexOf(Math.max(...hist));
    let ink = 0;
    for (let i = 0; i < SW * SH; i++) if (Math.abs(px[i] - bg) > 40) ink++;
    return ink / (SW * SH);
  } catch {
    return 1; // na dúvida, não pula (vai para a IA)
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

/**
 * "Impressão digital" da página (dHash 16x16 = 256 bits): cada bit diz se o pixel é mais claro que o vizinho da direita.
 * Páginas quase iguais (créditos, avisos, propaganda repetidos em todo capítulo) ficam a poucos bits de distância.
 */
async function pageHash(img: string): Promise<string | null> {
  const W = 17, H = 16;
  const raw = path.join(os.tmpdir(), `manga-hash-${randomUUID().slice(0, 8)}.gray`);
  try {
    await runFfmpeg(['-i', img, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-frames:v', '1', raw]);
    const px = fs.readFileSync(raw);
    if (px.length < W * H) return null;
    const bits = Buffer.alloc(32);
    for (let y = 0; y < H; y++) for (let x = 0; x < 16; x++) if (px[y * W + x] > px[y * W + x + 1]) bits[(y * 16 + x) >> 3] |= 1 << (x & 7);
    return bits.toString('hex');
  } catch {
    return null;
  } finally {
    fs.rmSync(raw, { force: true });
  }
}
const POP = Array.from({ length: 256 }, (_, i) => i.toString(2).replace(/0/g, '').length);
function hamming(a: Buffer, b: Buffer): number {
  let d = 0;
  for (let i = 0; i < 32; i++) d += POP[a[i] ^ b[i]];
  return d;
}

/** Linhas "calmas" (sarjeta, fundo liso) da página, para fatiar tiras altas sem cortar quadro no meio. */
async function sliceRows(img: string, pg: StudioPage): Promise<[number, number][]> {
  const sliceH = pg.width * 1.5;
  const n = Math.ceil(pg.height / sliceH);
  const SW = 120;
  const SH = Math.max(n * 8, Math.round((pg.height / pg.width) * SW));
  const raw = path.join(os.tmpdir(), `manga-rows-${randomUUID().slice(0, 8)}.gray`);
  let dev: (y: number) => number = () => 0;
  try {
    await runFfmpeg(['-i', img, '-vf', `scale=${SW}:${SH},format=gray`, '-f', 'rawvideo', '-frames:v', '1', raw]);
    const px = fs.readFileSync(raw);
    if (px.length >= SW * SH)
      dev = (y) => {
        let m = 0;
        for (let x = 0; x < SW; x++) m += px[y * SW + x];
        m /= SW;
        let v = 0;
        for (let x = 0; x < SW; x++) v += (px[y * SW + x] - m) ** 2;
        return Math.sqrt(v / SW);
      };
  } catch {
    /* sem ffmpeg/leitura: corta nas posições ideais */
  } finally {
    fs.rmSync(raw, { force: true });
  }
  const cuts = [0];
  for (let k = 1; k < n; k++) {
    const ideal = Math.round((k * SH) / n);
    const span = Math.round(SH / n / 4);
    let best = ideal, bestDev = Infinity;
    for (let y = Math.max(cuts[k - 1] + 4, ideal - span); y <= Math.min(SH - 4, ideal + span); y++) {
      const d = dev(y);
      if (d < bestDev - 0.5) (best = y), (bestDev = d);
    }
    cuts.push(best);
  }
  cuts.push(SH);
  return cuts.slice(1).map((c, k) => [Math.round((cuts[k] / SH) * pg.height), Math.round((c / SH) * pg.height)]);
}

interface Part {
  page: number; // índice da página no lote (1..)
  y0: number; // faixa da página original (px)
  y1: number;
  /** Tamanho da imagem enviada (px), para converter caixas que voltem em px. */
  w: number;
  h: number;
  image: LLMImage;
}

/** Imagens reduzidas de uma página: uma só, ou fatias de cima para baixo se for uma tira alta. */
async function pageParts(p: StudioProject, pg: StudioPage, n: number, tmp: string): Promise<Part[]> {
  const file = path.join(projectDir(p.id), pg.file);
  const rows: [number, number][] = pg.height / pg.width > TALL ? await sliceRows(file, pg) : [[0, pg.height]];
  const out: Part[] = [];
  for (const [k, [y0, y1]] of rows.entries()) {
    const h = y1 - y0;
    const tall = rows.length > 1;
    const s = Math.min(1, tall ? Math.min(SLICE_W / pg.width, SLICE_H / h) : MAX_SIDE / Math.max(pg.width, h));
    const w2 = Math.max(16, Math.round((pg.width * s) / 2) * 2), h2 = Math.max(16, Math.round((h * s) / 2) * 2);
    const f = path.join(tmp, `${pg.id}_${k}.jpg`);
    await runFfmpeg(['-y', '-i', file, '-vf', `crop=${pg.width}:${h}:0:${y0},scale=${w2}:${h2},format=gray`, '-q:v', '5', '-frames:v', '1', f]);
    out.push({ page: n, y0, y1, w: w2, h: h2, image: imageFromFile(f) });
  }
  return out;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** Caixa [x0,y0,x1,y1] da IA (frações da imagem enviada; às vezes vem em px ou 0..100) → frações da página. */
function toPageRect(raw: unknown, part: Part, pg: StudioPage): Rect | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  let [x0, y0, x1, y1] = raw.map(num);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  if (Math.max(x0, x1, y0, y1) > 1.5) {
    // px da imagem enviada (acima de 100) ou porcentagem
    const big = Math.max(x0, x1, y0, y1) > 100;
    const sx = big ? part.w : 100, sy = big ? part.h : 100;
    [x0, x1, y0, y1] = [x0 / sx, x1 / sx, y0 / sy, y1 / sy];
  }
  const fy = (y: number) => (part.y0 + Math.min(1, Math.max(0, y)) * (part.y1 - part.y0)) / pg.height;
  const r = cleanRect({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: fy(Math.min(y0, y1)), y1: fy(Math.max(y0, y1)) });
  if ((r.x1 - r.x0) * pg.width < 60 || (r.y1 - r.y0) * pg.height < 60) return null;
  return r;
}

const KINDS: PanelKind[] = ['action', 'reaction', 'dialogue', 'scene'];

/** parts = todas as imagens do pedido; pageNo = número da página no lote. */
function parsePage(raw: any, parts: Part[], pageNo: number, pg: StudioPage): PageNote {
  const mine = parts.filter((x) => x.page === pageNo);
  const panels: PanelNote[] = [];
  for (const q of Array.isArray(raw?.panels) ? raw.panels : []) {
    // "img" é o número da imagem no pedido inteiro; sem ele (ou de outra página), usa a primeira imagem desta página
    const byImg = parts[Number(q?.img) - 1];
    const part = byImg?.page === pageNo ? byImg : mine[0];
    const box = toPageRect(q?.box, part, pg);
    if (!box) continue;
    const focus = toPageRect(q?.focus, part, pg) ?? undefined;
    const rot = Number(q?.rotate);
    panels.push({
      box,
      focus: focus && (focus.x1 - focus.x0) * (focus.y1 - focus.y0) < (box.x1 - box.x0) * (box.y1 - box.y0) * 0.6 ? focus : undefined,
      what: String(q?.what ?? '').trim().slice(0, 160),
      kind: KINDS.find((k) => k === q?.kind) ?? 'scene',
      impact: Math.round(Math.min(10, Math.max(1, Number(q?.impact) || 5))),
      rotate: rot === 90 || rot === -90 ? rot : 0,
    });
  }
  // no máximo 8 quadros: fica com os de maior impacto
  if (panels.length > 8) panels.splice(0, panels.length, ...[...panels].sort((a, b) => b.impact - a.impact).slice(0, 8));
  // fatias: ordem de leitura = de cima para baixo
  panels.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  return stripPromo({
    v: NOTES_VERSION,
    file: pg.file,
    events: String(raw?.events ?? '').trim().slice(0, 600),
    dialogue: normDialogue(raw?.dialogue).slice(0, 900),
    characters: (Array.isArray(raw?.characters) ? raw.characters : []).map((c: unknown) => String(c).trim()).filter(Boolean).slice(0, 8),
    panels,
  });
}

/**
 * Garante a nota de cada página (só faz as que faltam). Várias páginas por chamada (mais quando a IA atual é o
 * Claude, para diluir o prompt fixo). Devolve as notas de todas as páginas pedidas que ficaram prontas.
 */
export async function ensurePageNotes(p: StudioProject, pages: StudioPage[], llm: LLMProvider, ctx: JobCtx): Promise<Record<string, PageNote>> {
  const notes = readNotes(p.id);
  const todo = pages.filter((pg) => notes[pg.id]?.file !== pg.file);
  const have = pages.length - todo.length;
  if (!todo.length) {
    ctx.log(`Leitura das páginas: ${pages.length} já lidas antes (sem gastar IA)`);
    await fixNamesInNotes(p, llm, ctx);
    return Object.assign(notes, readNotes(p.id));
  }
  // páginas sem conteúdo (em branco, quase lisas): marcadas como vazias sem gastar IA
  let blank = 0;
  for (let k = 0; k < todo.length; k += 6) {
    if (ctx.signal?.aborted) throw new Error('Cancelado');
    const chunk = todo.slice(k, k + 6);
    const res = await Promise.all(chunk.map((pg) => inkRatio(path.join(projectDir(p.id), pg.file))));
    chunk.forEach((pg, j) => {
      // quase em branco em qualquer lugar; ou pouca tinta nas 3 últimas páginas do capítulo (logo e créditos)
      const ofCh = p.pages.filter((x) => x.chapter === pg.chapter);
      const nearEnd = ofCh.length - ofCh.indexOf(pg) <= 3;
      // formato fora do padrão do capítulo: em webtoon (páginas em pé, bem altas), uma página quase quadrada ou deitada
      // (ex.: 800x600) é aviso/créditos da scan, não história
      const asp = ofCh.map((x) => x.height / x.width).sort((a, b) => a - b);
      const medAsp = asp[asp.length >> 1] ?? 0;
      const oddShape = ofCh.length >= 3 && medAsp > 2 && pg.height / pg.width < 1.3;
      if (!(res[j] < 0.03 || (nearEnd && res[j] < 0.12) || oddShape)) return;
      notes[pg.id] = { v: NOTES_VERSION, file: pg.file, events: '', dialogue: '', characters: [], panels: [], empty: true };
      blank++;
    });
    if (todo.length > 30) ctx.progress((k / todo.length) * 0.05, `Procurando páginas em branco (${Math.min(k + 6, todo.length)}/${todo.length})`);
  }
  if (blank) {
    writeNotes(p.id, notes);
    ctx.log(`${blank} página(s) sem história (em branco, logo ou créditos do fim do capítulo) puladas sem gastar IA`);
    todo.splice(0, todo.length, ...todo.filter((pg) => !notes[pg.id]?.empty || notes[pg.id]?.file !== pg.file));
    if (!todo.length) return notes;
  }
  // páginas REPETIDAS em 3+ capítulos (créditos, avisos, propaganda): puladas sem IA (comparação de imagem)
  {
    const hFile = path.join(projectDir(p.id), 'page-hashes.json');
    let hashes: Record<string, string> = {};
    try {
      hashes = JSON.parse(fs.readFileSync(hFile, 'utf8'));
    } catch {
      /* primeira vez */
    }
    const key = (pg: StudioPage) => `${pg.id}:${pg.file}`;
    const missing = p.pages.filter((pg) => !hashes[key(pg)]);
    for (let k = 0; k < missing.length; k += 8) {
      if (ctx.signal?.aborted) throw new Error('Cancelado');
      const chunk = missing.slice(k, k + 8);
      const hs = await Promise.all(chunk.map((pg) => pageHash(path.join(projectDir(p.id), pg.file))));
      chunk.forEach((pg, j) => hs[j] && (hashes[key(pg)] = hs[j]!));
      if (missing.length > 30) ctx.progress(0.05, `Procurando páginas repetidas (${Math.min(k + 8, missing.length)}/${missing.length})`);
    }
    if (missing.length) fs.writeFileSync(hFile, JSON.stringify(hashes));
    const all = p.pages.map((pg) => ({ pg, h: hashes[key(pg)] ? Buffer.from(hashes[key(pg)], 'hex') : null }));
    let repeated = 0;
    for (const pg of todo) {
      const me = all.find((x) => x.pg === pg)?.h;
      if (!me) continue;
      const chs = new Set<string>();
      for (const o of all) if (o.h && hamming(me, o.h) <= 12) chs.add(o.pg.chapter);
      // 3+ capítulos; em projeto pequeno (2 capítulos), basta aparecer igual nos dois
      const nChapters = new Set(p.pages.map((x) => x.chapter)).size;
      if (chs.size < Math.max(2, Math.min(3, nChapters))) continue;
      notes[pg.id] = { v: NOTES_VERSION, file: pg.file, events: '', dialogue: '', characters: [], panels: [], empty: true };
      repeated++;
    }
    if (repeated) {
      writeNotes(p.id, notes);
      ctx.log(`${repeated} página(s) repetida(s) em vários capítulos (créditos, avisos, propaganda) puladas sem gastar IA`);
      todo.splice(0, todo.length, ...todo.filter((pg) => !notes[pg.id]?.empty));
      if (!todo.length) return notes;
    }
  }
  if (!llm.supportsImages) throw new Error(`O provedor ${llm.name} não aceita imagens; a leitura das páginas precisa ver as imagens`);
  // antes de ler: revisa os nomes das notas antigas (só texto) — assim a ficha já começa preenchida
  await fixNamesInNotes(p, llm, ctx);
  Object.assign(notes, readNotes(p.id));
  // teste de consumo: MANGA_NOTES_LIMIT=50 no .env lê só as próximas N páginas desta vez
  const limit = Number(process.env.MANGA_NOTES_LIMIT) || 0;
  if (limit > 0 && todo.length > limit) {
    todo.splice(limit);
    ctx.log(`Teste: lendo só ${limit} página(s) desta vez (MANGA_NOTES_LIMIT)`);
  }
  ctx.log(`Lendo ${todo.length} página(s) com a IA de visão${have ? ` (${have} já lidas antes)` : ''}: cada página é vista uma vez só${claudeUsageTag()}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-notes-'));
  let failed = 0;
  // lote: até 5 páginas / 7 imagens por chamada (prompt fixo diluído; menos chamadas = limites rendem mais).
  // Os lotes são planejados antes (nº de fatias calculado pelo formato da página) e rodam em paralelo.
  const [maxPages, maxImgs] = [5, 7];
  const cast = readCast(p.id);
  const sliceCount = (pg: StudioPage) => (pg.height / pg.width > TALL ? Math.ceil(pg.height / (pg.width * 1.5)) : 1);
  const batches: StudioPage[][] = [];
  let cur: StudioPage[] = [];
  let imgs = 0;
  for (const pg of todo) {
    const n = sliceCount(pg);
    if (cur.length && (cur.length >= maxPages || imgs + n > maxImgs)) {
      batches.push(cur);
      cur = [];
      imgs = 0;
    }
    cur.push(pg);
    imgs += n;
  }
  if (cur.length) batches.push(cur);
  const CONCURRENCY = Math.max(1, Number(process.env.NOTES_CONCURRENCY) || 8);
  ctx.log(`Leitura em paralelo: ${batches.length} lote(s), ${CONCURRENCY} ao mesmo tempo`);
  let next = 0;
  let done = 0;
  // trava do plano: com o Claude perto do limite de 5 h, espera a janela renovar em vez de esgotar o plano
  const waitClaudeWindow = async () => {
    for (;;) {
      const l = claudeLimits();
      if (!isClaude(llm) || !l || l.fiveHour == null || l.fiveHour < STOP_5H()) return;
      const until = Math.max(Date.now() + 60_000, l.fiveHourResetsAt ?? Date.now() + 10 * 60_000);
      ctx.progress(done / todo.length, `Pausado: Claude em ${Math.round(l.fiveHour * 100)}% do limite de 5 h; volta às ${new Date(until).toLocaleTimeString('pt-BR')}`);
      await new Promise<void>((ok, fail) => {
        const t = setTimeout(ok, Math.min(until - Date.now(), 10 * 60_000));
        ctx.signal?.addEventListener('abort', () => (clearTimeout(t), fail(new Error('Cancelado'))), { once: true });
      });
      if (Date.now() >= until) return; // janela renovou: a próxima chamada traz o número novo
    }
  };
  // contexto de continuidade (texto barato): capítulo = pasta da página
  const chapterOf = (pg: StudioPage) => path.dirname(pg.file);
  const earlier = (pg: StudioPage) => {
    const i = p.pages.indexOf(pg);
    return p.pages.slice(Math.max(0, i - 40), i).filter((x) => chapterOf(x) === chapterOf(pg));
  };
  const chapterNames = (pg: StudioPage) => new Set(earlier(pg).flatMap((x) => notes[x.id]?.characters ?? []));
  const prevContext = (pg: StudioPage) => {
    const prev = earlier(pg).reverse().find((x) => notes[x.id] && !notes[x.id].empty);
    const n = prev && notes[prev.id];
    if (!n) return '';
    const lastLines = n.dialogue.split('\n').slice(-4).join(' / ');
    return `Contexto anterior (página antes destas): ${n.events}${lastLines ? ` Últimas falas: ${lastLines}` : ''}\n`;
  };
  const readBatch = async (batch: StudioPage[]) => {
      await waitClaudeWindow();
      const parts: Part[] = [];
      for (const [k, pg] of batch.entries()) parts.push(...(await pageParts(p, pg, k + 1, tmp)));
      const legend = parts
        .map((x, k) => {
          const total = parts.filter((y) => y.page === x.page);
          return `Imagem ${k + 1} = página ${x.page}${total.length > 1 ? ` (fatia ${total.indexOf(x) + 1} de ${total.length}, de cima para baixo)` : ''}`;
        })
        .join('\n');
      let got: any[] | null = null;
      for (let attempt = 1; attempt <= 2 && !got; attempt++) {
        try {
          const raw = await llm.complete({
            system: NOTES_SYSTEM + skillsPrompt('leitor') + framingPrompt(),
            prompt: `${p.context ? `Obra: ${p.context.slice(0, 2000)}\n` : ''}${castText(cast, chapterNames(batch[0]))}${prevContext(batch[0])}${batch.length} página(s), ${parts.length} imagem(ns):\n${legend}`,
            images: parts.map((x) => x.image),
            tier: 'small', // no Claude: Haiku (escolha do usuário: Haiku em tudo)
            maxTokens: (700 + batch.length * 900) * attempt,
            temperature: 0.2,
            signal: ctx.signal,
          });
          const out = extractJson(raw) as { pages?: any[]; newCharacters?: unknown };
          got = Array.isArray(out.pages) ? out.pages : null;
          if (!got) throw new Error('resposta sem "pages"');
          const added = mergeCast(cast, out.newCharacters);
          if (added) {
            writeCast(p.id, cast);
            ctx.log(`Ficha de personagens: +${added} (${cast.slice(-added).map((c) => c.name).join(', ')}); ${cast.length} no total`);
          }
        } catch (e) {
          if (ctx.signal?.aborted) throw e;
          if (attempt === 2) {
            failed += batch.length;
            ctx.log(`Leitura das páginas ${batch.map((x) => p.pages.indexOf(x) + 1).join(', ')} falhou: ${(e as Error).message.slice(0, 200)}`);
          }
        }
      }
      if (got)
        batch.forEach((pg, k) => {
          const raw = got!.find((x) => Number(x?.page) === k + 1) ?? (got!.length === batch.length ? got![k] : null);
          if (!raw) return void failed++;
          notes[pg.id] = parsePage(raw, parts, k + 1, pg);
          shortenNote(notes[pg.id], cast);
        });
      // escrita síncrona: os lotes paralelos não se atropelam no arquivo, e o progresso fica salvo a cada lote
      if (got) writeNotes(p.id, notes);
      done += batch.length;
      ctx.progress(done / todo.length, `Lendo páginas (${done}/${todo.length})${claudeUsageTag()}`);
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
        while (next < batches.length) {
          if (ctx.signal?.aborted) throw new Error('Cancelado');
          await readBatch(batches[next++]);
        }
      }),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failed) ctx.log(`Leitura: ${failed} página(s) sem descrição (rode de novo para completar)`);
  ctx.log(`Leitura terminada${claudeUsageTag()}`);
  // depois de ler: revisa os nomes das páginas novas (as primeiras saíram com a ficha ainda pequena)
  await fixNamesInNotes(p, llm, ctx);
  // modo teste: para aqui (não segue para o roteiro, que também gastaria IA)
  if (limit > 0) throw new Error(`Teste concluído: ${todo.length} página(s) lidas${claudeUsageTag()}`);
  return Object.assign(notes, readNotes(p.id));
}

const NAMES_SYSTEM = `Você revisa descrições em texto de páginas de mangá (já lidas por outra IA) para trocar referências GENÉRICAS a personagens ("um homem", "a mulher de terno", "o rapaz loiro") pelo NOME CURTO certo: só o nome próprio, sem sobrenome (ex.: "Seo Joo-heon" → "Joo-heon"), como aparece antes do parêntese na ficha. Em "newCharacters", o "name" é o nome COMPLETO.
Use a ficha de personagens e as próprias falas (quem é chamado pelo nome, quem se apresenta, contexto das páginas vizinhas). Só troque quando tiver segurança razoável; na dúvida, não troque. "o protagonista" pode ficar como está, mas se o nome dele for conhecido, prefira o nome.
Responda SOMENTE JSON:
{"newCharacters":[{"name":"...","look":"aparência/papel em até 15 palavras"}],"fixes":[{"page":12,"from":"trecho genérico exato como aparece no texto","to":"Nome"}]}
"from" precisa ser o trecho EXATO do texto da página (ex.: "Um homem de terno", "o homem"). Não repita trocas iguais na mesma página.`;

const GENERIC_TEXT = /\b(um|uma|o|a)\s+(homem|mulher|rapaz|garota|garoto|menino|menina|jovem|velho|idosa?|figura|sujeito|guerreir[oa]|soldado|criatura)\b/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Troca "um homem"/"uma mulher" pelos nomes nas notas já lidas, SÓ pelo texto (sem reenviar imagens).
 * Capítulo por capítulo, em ordem, para a ficha crescer com a história. Notas revisadas ficam marcadas.
 */
export async function fixNamesInNotes(p: StudioProject, llm: LLMProvider, ctx: JobCtx): Promise<void> {
  const notes = readNotes(p.id);
  const cast = readCast(p.id);
  // nomes completos já escritos → nome curto (sem IA)
  let shortened = 0;
  for (const n of Object.values(notes)) if (!n.empty && shortenNote(n, cast)) shortened++;
  if (shortened) {
    writeNotes(p.id, notes);
    ctx.log(`Nomes encurtados (só o nome próprio) em ${shortened} página(s)`);
  }
  const chapters = [...new Set(p.pages.map((x) => x.chapter))];
  const pending = chapters.filter((ch) => p.pages.some((pg) => pg.chapter === ch && notes[pg.id] && !notes[pg.id].empty && !notes[pg.id].namesFixed));
  if (!pending.length) return;
  ctx.log(`Revisando nomes (só texto, sem imagens) em ${pending.length} capítulo(s)`);
  let fixed = 0;
  for (const [ci, ch] of pending.entries()) {
    if (ctx.signal?.aborted) throw new Error('Cancelado');
    const pages = p.pages.filter((pg) => pg.chapter === ch && notes[pg.id] && !notes[pg.id].empty);
    const todo = pages.filter((pg) => !notes[pg.id].namesFixed);
    const textOf = (n: PageNote) => [n.events, n.dialogue, n.characters.join(', '), ...n.panels.map((q) => q.what)].join(' ');
    // capítulo sem nada genérico e sem nomes novos prováveis: só marca (não gasta IA)
    const needs = todo.some((pg) => GENERIC_TEXT.test(textOf(notes[pg.id])));
    if (needs) {
      const body = pages
        .map((pg) => {
          const n = notes[pg.id];
          return `[página ${p.pages.indexOf(pg) + 1}] acontece: ${n.events} | falas: ${n.dialogue || '-'} | personagens: ${n.characters.join(', ')} | quadros: ${n.panels.map((q) => q.what).join('; ')}`;
        })
        .join('\n');
      try {
        const raw = await llm.complete({
          system: NAMES_SYSTEM,
          tier: 'small', // só texto: no Claude vai para o Haiku (gasta bem menos do plano)
          prompt: `${p.context ? `Obra: ${p.context.slice(0, 2000)}\n` : ''}${castText(cast)}\n${ch}:\n${body}`,
          maxTokens: 2500,
          temperature: 0.1,
          signal: ctx.signal,
        });
        const out = extractJson(raw) as { newCharacters?: unknown; fixes?: any[] };
        if (mergeCast(cast, out.newCharacters)) writeCast(p.id, cast);
        for (const f of Array.isArray(out.fixes) ? out.fixes : []) {
          const pg = p.pages[Number(f?.page) - 1];
          const from = String(f?.from ?? '').trim();
          const to = String(f?.to ?? '').trim();
          const n = pg && notes[pg.id];
          if (!n || !from || !to || from.length < 3 || from.toLowerCase() === to.toLowerCase()) continue;
          const re = new RegExp(esc(from), 'gi');
          const before = textOf(n);
          n.events = n.events.replace(re, to);
          n.dialogue = n.dialogue.replace(re, to);
          n.characters = [...new Set(n.characters.map((c) => c.replace(re, to)))];
          for (const q of n.panels) q.what = q.what.replace(re, to);
          shortenNote(n, cast);
          if (textOf(n) !== before) fixed++;
        }
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`Nomes de ${ch}: falhou (${(e as Error).message.slice(0, 160)}); fica para a próxima`);
        continue;
      }
    }
    for (const pg of todo) notes[pg.id].namesFixed = true;
    writeNotes(p.id, notes);
    ctx.progress((ci + 1) / pending.length, `Revisando nomes (${ci + 1}/${pending.length} capítulos, ${fixed} trocas, ficha: ${cast.length})${claudeUsageTag()}`);
  }
  ctx.log(`Nomes revisados: ${fixed} trocas; ficha com ${cast.length} personagem(ns)`);
}

const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const inter = (a: Rect, b: Rect) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

/** Quadros da nota que aparecem num recorte (40%+ do quadro dentro do foco). */
export const panelsIn = (note: PageNote, focus: Rect) => note.panels.filter((q) => inter(q.box, focus) >= area(q.box) * 0.4);

/** Texto compacto da página para os prompts (sem imagem). */
export function pageText(note: PageNote): string {
  return [
    note.events && `acontece: ${note.events}`,
    note.dialogue && `falas: ${note.dialogue}`,
    note.characters.length ? `personagens: ${note.characters.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}
