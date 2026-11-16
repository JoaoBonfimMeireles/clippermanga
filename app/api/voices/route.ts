// Vozes de narração: GET → catálogo; GET ?sample=<id> → amostra de ~10 s (gerada uma vez e guardada em cache).
import fs from 'node:fs';
import path from 'node:path';
import { studioDir } from '@/lib/store';
import { synthesizeSpeech } from '@/lib/voice';
import { SAMPLE_TEXT, VOICES } from '@/lib/voices';

export const dynamic = 'force-dynamic';

const pending = new Map<string, Promise<number>>();

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('sample');
  if (!id) return Response.json(VOICES);
  if (!VOICES.some((v) => v.id === id)) return new Response('Voz não encontrada', { status: 404 });
  const dir = path.join(studioDir(), '_voices');
  const file = path.join(dir, `${id}.wav`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${id}.tmp.wav`);
    try {
      if (!pending.has(id)) pending.set(id, synthesizeSpeech(SAMPLE_TEXT, tmp, { voice: id }).finally(() => pending.delete(id)));
      await pending.get(id);
      if (fs.existsSync(tmp)) fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      return new Response((e as Error).message, { status: 502 });
    }
  }
  const buf = fs.readFileSync(file);
  return new Response(buf, { headers: { 'content-type': 'audio/wav', 'content-length': String(buf.length), 'cache-control': 'private, max-age=86400' } });
}
