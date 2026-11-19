// Importação de capítulos: mesma estratégia do apps/web/worker/manga.ts (HTML colado → HTML direto → Chrome headless),
// guardando as páginas em data/manga-studio/<id>/pages/<capítulo>/pNNN.jpg.
// TODO: mover estas funções para um pacote compartilhado e usar nos dois apps (o worker do apps/web tem mudanças em
// andamento, por isso ainda não foi mexido).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getEnvValue, runProcess } from '@clipper/shared/server';
import { probe, runFfmpeg } from '@clipper/video-processing';
import { projectDir, updateProject } from './store';
import type { JobCtx } from './jobs';
import { addPagesToTimeline } from './timeline';
import { mapPool } from './pool';
import { stitchChapter } from './stitch';
import { needsReader, readerImagesFromHtml, readerOpenChapter } from './reader';
import type { StudioPage } from './types';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function imageUrls(html: string, base: string): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    try {
      const abs = new URL(u.replace(/&amp;/g, '&').trim(), base).toString();
      if (/^https?:/.test(abs) && !out.includes(abs)) out.push(abs);
    } catch {
      /* endereço inválido */
    }
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    // sites com lazyload (Madara/manhwatop…) põem um SVG/GIF de "carregando" em src e a imagem real em data-*:
    // procura cada atributo por ordem de prioridade (data-* antes de src) e ignora placeholders
    for (const name of ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'src']) {
      const attr = new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(m[0]);
      const v = attr?.[1].trim();
      if (v && !v.startsWith('data:') && !/\.(?:svg|gif)(?:\?|$)/i.test(v)) {
        add(v);
        break;
      }
    }
  }
  for (const m of html.matchAll(/https?:\\?\/\\?\/[^"'\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'\s<>]*)?/gi)) add(m[0].replace(/\\\//g, '/'));
  return out;
}

/** Sites no tema Madara (manhwatop.com e vários outros): só as imagens do leitor (`.wp-manga-chapter-img`), na ordem — sem capas/sugestões. */
function madaraImages(html: string, base: string): string[] {
  const tags = [...html.matchAll(/<img\b[^>]*\bwp-manga-chapter-img\b[^>]*>/gi)].map((m) => m[0]);
  return tags.length ? imageUrls(tags.join('\n'), base) : [];
}

/** As páginas do capítulo costumam estar na mesma pasta do servidor; logos e banners vêm de outros lugares. */
function chapterImages(urls: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const u of urls) {
    const dir = u.split('?')[0].replace(/\/[^/]*$/, '');
    groups.set(dir, [...(groups.get(dir) ?? []), u]);
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  return best.length >= 3 ? best : urls;
}

function findBrowser(): string | null {
  const cands = [
    getEnvValue('CHROME_PATH'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return cands.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
}

async function renderedHtml(url: string): Promise<string | null> {
  const exe = findBrowser();
  if (!exe) return null;
  // perfil no disco do sistema: no D: (exFAT) o Chrome demora muito para criar o perfil
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-chrome-'));
  try {
    const res = await runProcess(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio', `--user-data-dir=${profile}`, `--user-agent=${UA}`, '--virtual-time-budget=8000', '--dump-dom', url], { timeoutMs: 120_000, captureStdout: true });
    return res.code === 0 ? res.stdout : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function saveAsJpeg(src: string, dst: string): Promise<{ width: number; height: number }> {
  await runFfmpeg(['-i', src, '-q:v', '3', '-frames:v', '1', dst]);
  const p = await probe(dst);
  return { width: p.width, height: p.height };
}

// as páginas novas já entram na linha do tempo, na ordem cronológica dos capítulos
const addPages = (projectId: string, pages: StudioPage[]) =>
  updateProject(projectId, (p) => {
    p.pages.push(...pages);
    addPagesToTimeline(p, pages);
  });

/**
 * Acha as imagens do capítulo no link (ou no HTML colado): HTML colado → HTML do servidor → leitor no Chrome invisível
 * (lib/reader.ts: rola a página, acha o capítulo certo pelo "próximo capítulo") → --dump-dom como último recurso.
 */
async function findImages(url: string, pastedHtml: string | undefined, ctx: JobCtx, n: number | null): Promise<string[]> {
  if (pastedHtml) {
    const reader = readerImagesFromHtml(pastedHtml);
    if (reader.length) return reader;
    const madara = madaraImages(pastedHtml, url);
    if (madara.length) return madara;
    const urls = chapterImages(imageUrls(pastedHtml, url));
    if (urls.length >= 3) return urls;
  }
  if (!needsReader(url)) {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' } }).catch(() => null);
    const text = res?.ok ? await res.text() : '';
    const madara = madaraImages(text, url);
    if (madara.length) return madara;
    const urls = text ? chapterImages(imageUrls(text, url)) : [];
    if (urls.length >= 3) return urls;
  }
  const exe = findBrowser();
  if (!exe) throw new Error('Esse site monta as páginas por JavaScript: preciso do Chrome ou Edge instalado (ou cole o HTML da página).');
  ctx.progress(0.05, 'Abrindo o capítulo num navegador invisível…');
  let readerErr = '';
  try {
    const ch = await readerOpenChapter(url, n, exe, UA, ctx.log);
    if (ch.url !== url) ctx.log(`Link real: ${ch.url}`);
    if (ch.images.length) return ch.images;
  } catch (e) {
    readerErr = (e as Error).message;
    ctx.log(`Leitor: ${readerErr}`);
    if (/Não achei o link do capítulo/.test(readerErr)) throw e;
  }
  const html = await renderedHtml(url);
  const urls = html ? chapterImages(imageUrls(html, url)) : [];
  if (!urls.length && readerErr) throw new Error(readerErr);
  return urls;
}

/** `pageSel`: números das páginas a manter (1 = primeira encontrada); vazio = todas. `n`: número do capítulo, se conhecido. */
export async function importFromUrl(projectId: string, url: string, chapter: string, pastedHtml: string | undefined, ctx: JobCtx, pageSel: number[] = [], n: number | null = null): Promise<number> {
  ctx.progress(0.02, 'Procurando as páginas no link…');
  const urls = await findImages(url, pastedHtml, ctx, n);
  if (!urls.length) throw new Error('Não achei as páginas nesse link. Cole o HTML da página (F12 → copiar o elemento html) ou envie as imagens.');
  ctx.log(`${urls.length} imagens candidatas`);
  const chId = randomUUID().slice(0, 8);
  const dir = path.join(projectDir(projectId), 'pages', chId);
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const got: ({ tmpFile: string; width: number; height: number } | null)[] = new Array(urls.length).fill(null);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < urls.length) {
      const k = next++;
      try {
        // alguns sites (comix.to) servem as imagens com referrerpolicy=no-referrer: sem Referer se o normal falhar
        // poucas conexões e novas tentativas com espera: hosts atrás de Cloudflare (manhwatop) limitam o ritmo (403/429)
        let r = await fetch(urls[k], { headers: { 'user-agent': UA, referer: url, accept: 'image/*' } }).catch(() => null);
        for (let t = 1; t <= 3 && r && (r.status === 403 || r.status === 429 || r.status >= 500); t++) {
          await new Promise((res) => setTimeout(res, 2000 * t));
          r = await fetch(urls[k], { headers: { 'user-agent': UA, referer: url, accept: 'image/*' } }).catch(() => null);
        }
        if (!r?.ok) r = await fetch(urls[k], { headers: { 'user-agent': UA, accept: 'image/*' } });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length >= 25_000) {
            const raw = path.join(tmp, `raw${k}`);
            fs.writeFileSync(raw, buf);
            const tmpFile = path.join(tmp, `c${k}.jpg`);
            const dim = await saveAsJpeg(raw, tmpFile).catch(() => null);
            if (dim && dim.width >= 400 && dim.height >= 400) got[k] = { tmpFile, ...dim };
          }
        }
      } catch {
        /* imagem que falhou: segue */
      }
      ctx.progress(0.1 + (++done / urls.length) * 0.85, `Baixando páginas (${done}/${urls.length})`);
    }
  };
  await Promise.all(Array.from({ length: /manhwatop\./i.test(url) ? 3 : 12 }, worker));
  const pages: StudioPage[] = [];
  const valid = got.filter((g): g is NonNullable<typeof g> => !!g);
  // a numeração das páginas conta só as imagens válidas (logos/banners já ficaram de fora)
  const keep = pageSel.length ? pageSel.filter((n) => Number.isInteger(n) && n >= 1 && n <= valid.length).map((n) => valid[n - 1]) : valid;
  if (pageSel.length && !keep.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`O capítulo tem ${valid.length} páginas; nenhuma das escolhidas existe.`);
  }
  // emenda as imagens do site (fatiadas em pontos aleatórios) e corta só em faixa lisa: personagem nunca fica partido
  const joined = await stitchChapter(keep.map((g) => ({ file: g.tmpFile, width: g.width, height: g.height })), dir).catch((e) => {
    ctx.log(`Emenda falhou (${(e as Error).message}); mantendo as imagens como vieram`);
    return null;
  });
  if (joined?.length) {
    for (const j of joined) pages.push({ id: randomUUID().slice(0, 8), file: `pages/${chId}/${path.basename(j.file)}`, width: j.width, height: j.height, chapter });
  } else {
    for (const g of keep) {
      const file = `p${String(pages.length + 1).padStart(3, '0')}.jpg`;
      fs.renameSync(g.tmpFile, path.join(dir, file));
      pages.push({ id: randomUUID().slice(0, 8), file: `pages/${chId}/${file}`, width: g.width, height: g.height, chapter });
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!pages.length) throw new Error('As imagens desse link não puderam ser baixadas. Envie as imagens do capítulo.');
  addPages(projectId, pages);
  return pages.length;
}

export async function importFromFiles(projectId: string, files: { name: string; data: Buffer }[], chapter: string, ctx: JobCtx): Promise<number> {
  const chId = randomUUID().slice(0, 8);
  const dir = path.join(projectDir(projectId), 'pages', chId);
  fs.mkdirSync(dir, { recursive: true });
  const pages: StudioPage[] = [];
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // converte várias de uma vez (um ffmpeg por imagem); a numeração final segue a ordem dos nomes
  let done = 0;
  const conv = await mapPool(sorted, 6, async (f, i) => {
    const raw = path.join(dir, `raw_${i}${path.extname(f.name).replace(/[^.a-z0-9]/gi, '')}`);
    const tmp = path.join(dir, `c_${i}.jpg`);
    fs.writeFileSync(raw, f.data);
    const dim = await saveAsJpeg(raw, tmp).catch(() => null);
    fs.rmSync(raw, { force: true });
    ctx.progress(++done / sorted.length, `Convertendo páginas (${done}/${sorted.length})`);
    return dim ? { tmp, ...dim } : null;
  });
  const okConv = conv.filter((c): c is NonNullable<typeof c> => !!c);
  const joined = await stitchChapter(okConv.map((c) => ({ file: c.tmp, width: c.width, height: c.height })), dir, 's').catch(() => null);
  if (joined?.length) {
    for (const j of joined) pages.push({ id: randomUUID().slice(0, 8), file: `pages/${chId}/${path.basename(j.file)}`, width: j.width, height: j.height, chapter });
    for (const c of okConv) fs.rmSync(c.tmp, { force: true });
  } else {
    for (const c of okConv) {
      const file = `p${String(pages.length + 1).padStart(3, '0')}.jpg`;
      fs.renameSync(c.tmp, path.join(dir, file));
      pages.push({ id: randomUUID().slice(0, 8), file: `pages/${chId}/${file}`, width: c.width, height: c.height, chapter });
    }
  }
  if (!pages.length) throw new Error('Nenhuma imagem válida');
  addPages(projectId, pages);
  return pages.length;
}
