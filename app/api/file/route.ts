// Serve páginas do projeto (?project=<id>&f=pages/...) e o último vídeo (?project=<id>&video=1), com Range.
// &w=<px>: miniatura JPEG com essa largura (gerada uma vez e guardada em .progress/thumbs) para listas e linhas do tempo,
// que antes baixavam a página inteira (tiras de webtoon com vários MB) para mostrar 100 px.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { isInside } from '@clipper/shared/server';
import { runFfmpeg } from '@clipper/video-processing';
import { projectDir, peekProject } from '@/lib/store';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4' };
const THUMB_WIDTHS = [96, 160, 240, 320, 480];
const pendingThumbs = new Map<string, Promise<void>>();

/** Miniatura em cache (largura fixa, altura proporcional, no máx. 4x a largura para tiras muito longas). */
async function thumbOf(dir: string, full: string, w: number): Promise<string> {
  const st = fs.statSync(full);
  const key = createHash('sha1').update(`${path.relative(dir, full)}|${st.size}|${st.mtimeMs}|${w}`).digest('hex').slice(0, 20);
  const out = path.join(dir, '.progress', 'thumbs', `${key}.jpg`);
  if (fs.existsSync(out)) return out;
  if (!pendingThumbs.has(out)) {
    const job = (async () => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const tmp = `${out}.${process.pid}.tmp.jpg`;
      // corta o topo da tira (a miniatura é sempre object-cover) para não gerar imagens enormes
      await runFfmpeg(['-i', full, '-vf', `scale=${w}:-2:flags=bilinear,crop=iw:'min(ih,iw*4)':0:0`, '-frames:v', '1', '-q:v', '5', tmp]);
      fs.renameSync(tmp, out);
    })().finally(() => pendingThumbs.delete(out));
    pendingThumbs.set(out, job);
  }
  await pendingThumbs.get(out);
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('project') ?? '';
  const isVideo = url.searchParams.has('video');
  let full = '';
  if (isVideo) full = peekProject(id)?.lastRender?.file ?? '';
  else {
    const dir = projectDir(id);
    full = path.resolve(dir, url.searchParams.get('f') ?? '');
    if (!isInside(dir, full)) full = '';
  }
  let st: fs.Stats | null = null;
  try {
    st = full ? fs.statSync(full) : null;
  } catch {
    st = null;
  }
  if (!st?.isFile()) return new Response('Não encontrado', { status: 404 });

  // miniatura: só para imagens das páginas
  const w = Number(url.searchParams.get('w'));
  if (!isVideo && w > 0 && /\.(jpe?g|png|webp)$/i.test(full)) {
    const width = THUMB_WIDTHS.find((x) => x >= w) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
    try {
      full = await thumbOf(projectDir(id), full, width);
      st = fs.statSync(full);
    } catch {
      /* sem ffmpeg/imagem estranha: serve a original */
    }
  }

  const size = st.size;
  // páginas (pages/<pasta nova por importação>/) e miniaturas nunca mudam no mesmo caminho: cache longo.
  // O resto (ex.: publish/refs/ref_1.jpg, sobrescrito) revalida pelo ETag. O vídeo já vem com &v=<data do render>.
  const immutable = !isVideo && /^pages\//.test(url.searchParams.get('f') ?? '');
  const etag = `"${size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers: Record<string, string> = {
    'content-type': TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': immutable ? 'private, max-age=31536000, immutable' : isVideo ? 'private, max-age=3600' : 'private, no-cache',
    etag,
    'last-modified': st.mtime.toUTCString(),
  };
  if (url.searchParams.has('download')) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(path.basename(full))}"`;
  const range = req.headers.get('range');
  if (!range && req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const m = /bytes=(\d*)-(\d*)/.exec(range ?? '');
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(full, { start, end })) as unknown as ReadableStream, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(full)) as unknown as ReadableStream, { headers: { ...headers, 'content-length': String(size) } });
}
