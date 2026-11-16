// DELETE ?plan=1: descarta o plano de shorts parado para aprovação.
// DELETE ?short=<id>: apaga um short (sai da lista e o arquivo de vídeo é removido).
// PATCH {short, title, description, tags}: salva a legenda editada do short.
// POST {short, from, to, skip}: a IA escreve de novo a legenda do short para o trecho escolhido.
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '@clipper/shared/server';
import { projectDir, updateProject } from '@/lib/store';
import { shortCaption } from '@/lib/shorts';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, { params }: Ctx) {
  const id = (await params).id;
  if (new URL(req.url).searchParams.has('plan')) {
    // descarta o plano que esperava aprovação (nada foi gasto)
    try {
      updateProject(id, (cur) => void delete cur.shortsPlan);
    } catch (e) {
      return new Response((e as Error).message, { status: 404 });
    }
    return Response.json({ ok: true });
  }
  const shortId = new URL(req.url).searchParams.get('short') ?? '';
  let file = '';
  try {
    updateProject(id, (cur) => {
      const s = cur.shorts?.find((x) => x.id === shortId);
      if (!s) return;
      file = s.file;
      cur.shorts = cur.shorts!.filter((x) => x.id !== shortId);
    });
  } catch (e) {
    return new Response((e as Error).message, { status: 404 });
  }
  if (!file) return new Response('Short não encontrado', { status: 404 });
  const dir = projectDir(id);
  const full = path.resolve(dir, file);
  if (isInside(dir, full)) fs.rmSync(full, { force: true });
  return Response.json({ ok: true });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const id = (await params).id;
  const b = (await req.json()) as { short?: string; title?: string; description?: string; tags?: string[] | string };
  let found = false;
  try {
    updateProject(id, (cur) => {
      const s = cur.shorts?.find((x) => x.id === b.short);
      if (!s) return;
      found = true;
      if (typeof b.title === 'string') s.title = b.title.trim();
      if (typeof b.description === 'string') s.description = b.description.trim();
      if (b.tags !== undefined) s.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean);
    });
  } catch (e) {
    return new Response((e as Error).message, { status: 404 });
  }
  return found ? Response.json({ ok: true }) : new Response('Short não encontrado', { status: 404 });
}

export async function POST(req: Request, { params }: Ctx) {
  const id = (await params).id;
  const b = (await req.json()) as { short?: string; from?: number; to?: number; skip?: string[] };
  try {
    const cap = await shortCaption(id, String(b.short ?? ''), Number(b.from), Number(b.to), Array.isArray(b.skip) ? b.skip.map(String) : [], req.signal);
    return Response.json(cap);
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
