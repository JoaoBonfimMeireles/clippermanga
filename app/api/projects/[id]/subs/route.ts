// Legendas da publicação. GET ?f=pt|zh|txt baixa a legenda .srt (pt-BR / chinês) ou o texto completo da IA (.txt).
// POST {kind: 'zh'} traduz para chinês; {kind: 'burn'} gera o vídeo final com a legenda chinesa queimada.
import { startJob } from '@/lib/jobs';
import { peekProject } from '@/lib/store';
import { burnZh, fullTranscript, srtPt, srtZh, translateZh } from '@/lib/subs';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const id = (await params).id;
  const p = peekProject(id);
  if (!p) return new Response('Projeto não encontrado', { status: 404 });
  const f = new URL(req.url).searchParams.get('f') ?? 'pt';
  const base = p.title.replace(/[^\w\- ]+/g, '').trim() || 'video';
  try {
    const [body, name, type] =
      f === 'zh' ? [srtZh(id), `${base}.zh-Hans.srt`, 'application/x-subrip'] : f === 'txt' ? [fullTranscript(id), `${base} - textos da IA.txt`, 'text/plain'] : [srtPt(id), `${base}.pt-BR.srt`, 'application/x-subrip'];
    return new Response('﻿' + body, { headers: { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}` } });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}

export async function POST(req: Request, { params }: Ctx) {
  const id = (await params).id;
  if (!peekProject(id)?.lastRender) return new Response('Renderize o vídeo antes', { status: 400 });
  const { kind } = (await req.json()) as { kind?: string };
  if (kind === 'zh') return Response.json(startJob('subs', id, (ctx, signal) => translateZh(id, ctx, signal)));
  if (kind === 'burn') return Response.json(startJob('subs', id, (ctx, signal) => burnZh(id, ctx, signal)));
  return new Response('Tipo inválido', { status: 400 });
}
