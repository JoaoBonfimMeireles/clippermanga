// Narração gravada (microfone).
// GET                      → { fx, items } (efeitos e gravações por parte)
// GET ?shot=<id>           → áudio da parte COM os efeitos (WAV); &raw=1 → gravação original
// POST ?shot=<id>          → corpo = áudio do navegador (webm/ogg/wav); salva como a narração da parte
// PUT  { fx }              → salva os efeitos de voz
// DELETE ?shot=<id>        → apaga a gravação da parte
import fs from 'node:fs';
import path from 'node:path';
import { deleteRecording, processedRecording, readNarration, saveRecording, setVoiceFx } from '@/lib/narration';
import { projectDir, peekProject } from '@/lib/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' };

export async function GET(req: Request, { params }: Ctx) {
  const id = (await params).id;
  if (!peekProject(id)) return new Response('Projeto não encontrado', { status: 404 });
  const url = new URL(req.url);
  const shot = url.searchParams.get('shot');
  if (!shot) return Response.json(readNarration(id), { headers: { 'cache-control': 'no-store' } });
  let file: string | null = null;
  let dur = 0;
  if (url.searchParams.has('raw')) {
    const rec = readNarration(id).items[shot];
    if (rec) (file = path.join(projectDir(id), rec.file)), (dur = rec.dur);
  } else {
    try {
      // ?fx=<json>: aplica estes efeitos (ajuste ao vivo, antes de salvar); sem ele, os efeitos salvos
      let fx: object | undefined;
      try {
        fx = url.searchParams.get('fx') ? JSON.parse(url.searchParams.get('fx')!) : undefined;
      } catch {
        fx = undefined;
      }
      const out = await processedRecording(id, shot, fx);
      if (out) (file = out.file), (dur = out.dur);
    } catch (e) {
      return new Response(`Falha ao aplicar os efeitos: ${(e as Error).message}`, { status: 500 });
    }
  }
  if (!file || !fs.existsSync(file)) return new Response('Sem gravação', { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-duration': String(dur) } });
}

export async function POST(req: Request, { params }: Ctx) {
  const id = (await params).id;
  const p = peekProject(id);
  if (!p) return new Response('Projeto não encontrado', { status: 404 });
  const shot = new URL(req.url).searchParams.get('shot') ?? '';
  if (!p.shots.some((s) => s.id === shot)) return new Response('Parte não encontrada', { status: 404 });
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim();
  const data = Buffer.from(await req.arrayBuffer());
  if (data.length < 500) return new Response('Gravação vazia', { status: 400 });
  try {
    return Response.json(await saveRecording(id, shot, data, EXT[type] ?? 'webm'));
  } catch (e) {
    return new Response(`Não consegui salvar a gravação: ${(e as Error).message}`, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  const id = (await params).id;
  if (!peekProject(id)) return new Response('Projeto não encontrado', { status: 404 });
  const body = (await req.json()) as { fx?: object };
  return Response.json({ fx: setVoiceFx(id, body.fx ?? {}) });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const id = (await params).id;
  deleteRecording(id, new URL(req.url).searchParams.get('shot') ?? '');
  return new Response(null, { status: 204 });
}
