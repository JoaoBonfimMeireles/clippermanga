// Leitor genérico para sites de mangá que montam as páginas por JavaScript (comix.to e parecidos):
// abre o capítulo num Chrome invisível controlado pelo DevTools Protocol, rola todos os contêineres até as imagens
// "preguiçosas" carregarem e lê, da página já montada: as imagens grandes (na ordem), o número do capítulo e o link do
// próximo capítulo (syncData do comix, <link rel=next>, botões "Next/Próximo", ou um link com o número seguinte).
// Muitos sites têm um id variável na URL de cada capítulo (comix: 1674342-chapter-1, 1674478-chapter-2…) — trocar só
// o número não serve. Por isso guardamos, por mangá, número → URL real de tudo o que aparece nas páginas visitadas e,
// se preciso, seguimos o "próximo capítulo" a partir do capítulo conhecido mais próximo.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Sites cujo HTML do servidor nunca traz as páginas: vão direto para o leitor. */
export const needsReader = (url: string) => /^https?:\/\/(?:www\.)?(?:comix\.to|mangafire\.to)\//i.test(url);

/** Número do capítulo pela URL (chapter-12, capitulo-12, ch-12.5, /c12/…). */
export function chapterNum(url: string): number {
  const path = url.split(/[?#]/)[0].split('/').slice(3).join('/');
  const m = [...path.matchAll(/(?:chapter|chap|cap[ií]tulo|episode|ch|ep|c)[-_/.]?(\d+(?:[.-]\d)?)(?=[/?#._-]|$)/gi)].at(-1);
  return m ? Number(m[1].replace('-', '.')) : NaN;
}
/** Chave do mangá: a URL sem o último trecho (ex.: https://comix.to/title/8j2em-nome). */
const mangaKey = (url: string) => {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/\/$/, '').split('/');
    parts.pop();
    return u.origin + parts.join('/').replace(/^(\/title\/[a-z0-9]+)-[^/]*/i, '$1');
  } catch {
    return url;
  }
};

const g = globalThis as unknown as { __readerUrls?: Map<string, Map<number, string>> };
const known = (g.__readerUrls ??= new Map());
function learn(url: string, n = chapterNum(url)) {
  if (!url || !Number.isFinite(n)) return;
  const k = mangaKey(url);
  if (!known.has(k)) known.set(k, new Map());
  known.get(k)!.set(n, url);
}

/** Imagens do leitor do comix no HTML colado (copiado do navegador), na ordem. */
export function readerImagesFromHtml(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*\brpage-page__img\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1]?.replace(/&amp;/g, '&');
    if (src && /^https?:/.test(src) && !out.includes(src)) out.push(src);
  }
  return out;
}

// ---------- Chrome invisível via DevTools Protocol ----------

class Cdp {
  private id = 0;
  private wait = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  private ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      const w = msg.id && this.wait.get(msg.id);
      if (!w) return;
      this.wait.delete(msg.id);
      if (msg.error) w.err(new Error(`Chrome: ${msg.error.message}`));
      else w.ok(msg.result);
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((ok, err) => {
      this.wait.set(id, { ok, err });
      try {
        this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (e) {
        this.wait.delete(id);
        return err(e as Error);
      }
      setTimeout(() => this.wait.has(id) && (this.wait.delete(id), err(new Error(`Chrome não respondeu (${method})`))), 90_000);
    });
  }
}

type Session = { proc: ChildProcess; profile: string; cdp: Cdp; ws: WebSocket; sid: string; idle?: NodeJS.Timeout };
let session: Promise<Session> | null = null;
let queue: Promise<unknown> = Promise.resolve(); // uma aba só: um capítulo por vez

async function openSession(exe: string, ua: string): Promise<Session> {
  // perfil no disco do sistema: no D: (exFAT) o Chrome demora muito para criar o perfil
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-reader-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--user-agent=${ua}`, '--window-size=1000,1400', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = '';
  for (let i = 0; i < 150 && !port; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (fs.existsSync(portFile)) port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  }
  if (!port) {
    proc.kill();
    throw new Error('Não consegui abrir o Chrome invisível.');
  }
  const ver = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((ok, err) => (ws.addEventListener('open', ok), ws.addEventListener('error', () => err(new Error('Falha ao conectar no Chrome')))));
  const cdp = new Cdp(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { proc, profile, cdp, ws, sid: sessionId };
}

function closeSession() {
  const s = session;
  session = null;
  s?.then((x) => {
    try {
      x.ws.close();
    } catch {}
    x.proc.kill();
    setTimeout(() => fs.rmSync(x.profile, { recursive: true, force: true, maxRetries: 3 }), 1500);
  }).catch(() => {});
}

// roda dentro da página: rola tudo até as imagens pararem de aparecer e lê imagens, número e próximo capítulo
const SCRAPE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const srcOf = (i) => { const s = i.currentSrc || i.src || i.dataset.src || i.dataset.lazySrc || i.dataset.original || i.dataset.url || ''; return s.startsWith('data:') ? '' : s; };
  const big = (i) => Math.max(i.naturalWidth, Number(i.getAttribute('width')) || 0, i.getBoundingClientRect().width) >= 350;
  const pick = () => {
    const comix = [...document.querySelectorAll('img.rpage-page__img')];
    const list = comix.length ? comix : [...document.images].filter(big);
    return [...new Set(list.map(srcOf).filter(Boolean))];
  };
  for (let i = 0; i < 60 && pick().length < 2; i++) await sleep(250);
  const scrollers = () => [document.scrollingElement, ...[...document.querySelectorAll('body *')].filter((e) => { const c = getComputedStyle(e).overflowY; return /auto|scroll/.test(c) && e.scrollHeight > e.clientHeight + 200; })];
  let last = -1, stable = 0;
  for (let pass = 0; pass < 6 && stable < 2; pass++) {
    for (const m of scrollers()) {
      for (let y = 0; y <= m.scrollHeight; y += 700) { m.scrollTop = y; m.dispatchEvent(new Event('scroll')); await sleep(120); }
    }
    const comixTotal = document.querySelectorAll('.rpage-page').length;
    for (let i = 0; i < 12 && comixTotal && pick().length < comixTotal; i++) await sleep(250);
    await sleep(800);
    const n = pick().length;
    stable = n === last && (!comixTotal || n >= comixTotal) ? stable + 1 : 0;
    last = n;
  }
  let sync = {};
  try { sync = JSON.parse(document.getElementById('syncData')?.textContent || '{}'); } catch {}
  const links = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: (a.textContent + ' ' + (a.title || '') + ' ' + (a.getAttribute('aria-label') || '') + ' ' + a.className).trim() }));
  const nextA = links.find((l) => /\\b(next|pr[oó]xim|siguiente|seguinte)/i.test(l.text) && /chap|cap|ch|ep/i.test(l.href));
  const t = /(?:ch(?:apter)?|cap[ií]tulo|episode)\\.?\\s*(\\d+(?:\\.\\d+)?)/i.exec(document.title);
  return JSON.stringify({
    url: location.href,
    total: document.querySelectorAll('.rpage-page').length,
    images: pick(),
    next: sync.next_chapter_url || document.querySelector('link[rel=next]')?.href || document.querySelector('a[rel=next]')?.href || nextA?.href || '',
    number: sync.number ?? (t ? Number(t[1]) : null),
    links: links.map((l) => l.href),
  });
})()`;

// clica no botão "próximo capítulo" (aria-label, título ou texto) e devolve a nova URL, ou '' se nada mudou
const NEXT_BY_CLICK = `(async () => {
  const start = location.href;
  const label = (e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.title || '') + ' ' + e.textContent).trim();
  const els = [...document.querySelectorAll('button, a, [role=button]')];
  const btn = els.find((e) => /next\\s*chap|pr[oó]ximo\\s*cap|cap[ií]tulo\\s*seguinte|siguiente\\s*cap/i.test(label(e)))
    || els.find((e) => /^(next|pr[oó]ximo|seguinte|siguiente)\\b/i.test(label(e)) && !/page|p[aá]gina|image|imagem/i.test(label(e)));
  if (!btn) return '';
  btn.click();
  for (let i = 0; i < 40 && location.href === start; i++) await new Promise((r) => setTimeout(r, 200));
  return location.href === start ? '' : location.href;
})()`;

export interface ReaderChapter {
  url: string;
  number: number;
  images: string[];
  next: string;
}

async function scrape(url: string, exe: string, ua: string): Promise<ReaderChapter> {
  session ??= openSession(exe, ua);
  let s: Session;
  try {
    s = await session;
  } catch (e) {
    session = null;
    throw e;
  }
  clearTimeout(s.idle);
  try {
    const ev = (expression: string, awaitPromise = false) => s.cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, s.sid);
    // marca o documento atual: só lê depois que o novo (sem a marca) terminar de carregar
    await ev('window.__readerOld = 1');
    await s.cdp.send('Page.navigate', { url }, s.sid);
    for (let i = 0; i < 160; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const r = await ev('!window.__readerOld && document.readyState === "complete"').catch(() => null);
      if (r?.result?.value) break;
    }
    const r = await ev(SCRAPE, true);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    const data = JSON.parse(r.result.value) as { url: string; total: number; images: string[]; next: string; number: number | null; links: string[] };
    const number = data.number !== null && Number.isFinite(Number(data.number)) ? Number(data.number) : chapterNum(data.url);
    if (!data.next) {
      // sem link de próximo: muitos leitores só têm um botão — clica e vê para onde a página vai
      const nx = await ev(NEXT_BY_CLICK, true).catch(() => null);
      const href = String(nx?.result?.value ?? '');
      if (href && href !== data.url) data.next = href;
    }
    for (const l of data.links) if (mangaKey(l) === mangaKey(data.url)) learn(l);
    learn(data.url, number);
    if (data.next) learn(data.next);
    if (data.total && data.images.length < data.total) throw new Error(`O leitor carregou só ${data.images.length} de ${data.total} páginas`);
    return { url: data.url, number, images: data.images, next: data.next };
  } finally {
    // fecha o Chrome se ninguém usar por 30 s
    s.idle = setTimeout(closeSession, 30_000);
  }
}

/** Abre o capítulo no Chrome invisível e devolve as imagens + número + link do próximo (um por vez). */
// abre a lista de capítulos do leitor e vai para o capítulo N (link direto ou clique); devolve a URL ou ''
const GOTO = (n: number) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const start = location.href;
  const label = (e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.title || '') + ' ' + e.textContent).trim();
  const opener = [...document.querySelectorAll('button, a, [role=button]')].find((e) => /chapter\\s*list|chapters|lista\\s*de\\s*cap|cap[ií]tulos/i.test(label(e)) && !e.href);
  if (opener) { opener.click(); await sleep(1500); }
  const re = /(?:^|[^\\w.])(?:ch(?:apter)?|cap(?:[ií]tulo)?|ep(?:isode)?)\\.?\\s*0*${n}(?![\\d.])/i;
  const find = () => {
    const cands = [...document.querySelectorAll('body *')].filter((e) => e.offsetParent !== null && re.test(e.textContent || ''));
    // o menor elemento que bate (o item, não a lista inteira)
    return cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)))[0];
  };
  let item = find();
  const scrollers = [...document.querySelectorAll('body *')].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 50);
  for (let i = 0; i < 80 && !item; i++) {
    for (const s of scrollers) { s.scrollTop += 600; s.dispatchEvent(new Event('scroll')); }
    await sleep(200);
    item = find();
  }
  if (!item) return '';
  item = item.closest('li, a, button, [role=option], [role=button]') || item;
  const a = item.closest('a[href]') || item.querySelector('a[href]');
  if (a && a.href !== start) return a.href;
  (item.querySelector('button, [role=button]') || item).click();
  for (let i = 0; i < 40 && location.href === start; i++) await sleep(200);
  return location.href === start ? '' : location.href;
})()`;

function readerGoto(n: number): Promise<string> {
  const run = queue.then(async () => {
    const s = await session;
    if (!s) return '';
    const r = await s.cdp.send('Runtime.evaluate', { expression: GOTO(n), awaitPromise: true, returnByValue: true }, s.sid);
    return String(r?.result?.value ?? '');
  });
  queue = run.catch(() => {});
  return run;
}

export function readerChapter(url: string, exe: string, ua: string): Promise<ReaderChapter> {
  const run = queue.then(() => scrape(url, exe, ua));
  queue = run.catch(() => {});
  return run;
}

/**
 * Abre o capítulo `n` a partir da URL gerada (`hint`, que pode ter o id errado): usa as URLs já aprendidas e, se a
 * página abrir outro capítulo, segue o "próximo capítulo" a partir do conhecido mais próximo (no máximo `maxHops`).
 * Sem número detectável na página, confia no link.
 */
export async function readerOpenChapter(hint: string, n: number | null, exe: string, ua: string, log: (m: string) => void, maxHops = 40): Promise<ReaderChapter> {
  const map = () => known.get(mangaKey(hint)) ?? new Map<number, string>();
  const first = await readerChapter((n !== null && map().get(n)) || hint, exe, ua);
  if (n === null || !Number.isFinite(first.number) || first.number === n) return first;
  log(`O link abriu o capítulo ${first.number}, não o ${n}: procurando o capítulo na lista do leitor…`);
  // 1º: a lista de capítulos do próprio leitor (a página do capítulo errado ainda está aberta)
  const viaList = await readerGoto(n).catch(() => '');
  if (viaList) {
    learn(viaList, n);
    const ch = await readerChapter(viaList, exe, ua);
    if (ch.number === n || !Number.isFinite(ch.number)) return ch;
  }
  // 2º: segue o "próximo capítulo" a partir do capítulo conhecido mais próximo
  log(`Procurando o capítulo ${n} pelos links de "próximo capítulo"…`);
  for (let hop = 0; hop < maxHops; hop++) {
    const exact = map().get(n);
    if (exact) {
      const ch = await readerChapter(exact, exe, ua);
      if (ch.number === n || !Number.isFinite(ch.number)) return ch;
      map().delete(n);
    }
    const below = [...map().keys()].filter((k) => k < n).sort((a, b) => b - a)[0];
    if (below === undefined) break;
    const ch = await readerChapter(map().get(below)!, exe, ua);
    const nn = chapterNum(ch.next);
    if (!ch.next || !(nn > below)) break;
    if (ch.number === n) return ch;
  }
  throw new Error(`Não achei o link do capítulo ${n} (o link gerado abriu o capítulo ${first.number})`);
}
