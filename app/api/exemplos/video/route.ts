// Serve o vídeo de um exemplo (?id=), com Range para o player.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { exemploPath, readExemplos } from '@/lib/exemplos';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const e = readExemplos().find((x) => x.id === new URL(req.url).searchParams.get('id'));
  if (!e) return new Response('Não encontrado', { status: 404 });
  const full = exemploPath(e);
  let size: number;
  try {
    size = fs.statSync(full).size;
  } catch {
    return new Response('Arquivo sumiu', { status: 404 });
  }
  const type = /\.webm$/i.test(full) ? 'video/webm' : 'video/mp4';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
  const start = m?.[1] ? Number(m[1]) : 0;
  const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (m && (start > end || start >= size)) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  const body = Readable.toWeb(fs.createReadStream(full, { start, end })) as ReadableStream;
  return new Response(body, {
    status: m ? 206 : 200,
    headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) },
  });
}
