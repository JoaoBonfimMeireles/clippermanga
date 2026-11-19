import fs from 'node:fs';
import path from 'node:path';
import { seriesKey } from '@/lib/series';
import { studioDir } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** Obras (séries) criadas na mão no painel: uma obra aparece mesmo sem nenhuma parte ainda. As partes ligam pela chave da série. */
export type Obra = { key: string; name: string };
const file = () => path.join(studioDir(), '_obras.json');
const read = (): Obra[] => {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as Obra[];
  } catch {
    return [];
  }
};

export function GET() {
  return Response.json(read());
}

export async function POST(req: Request) {
  const { name } = (await req.json().catch(() => ({}))) as { name?: string };
  const n = name?.trim();
  if (!n) return new Response('Dê um nome à obra.', { status: 400 });
  const list = read();
  const key = seriesKey({ title: n, series: n });
  if (!list.some((o) => o.key === key)) {
    list.push({ key, name: n });
    fs.writeFileSync(file(), JSON.stringify(list, null, 2));
  }
  return Response.json({ key, name: n });
}

export async function DELETE(req: Request) {
  const { key } = (await req.json().catch(() => ({}))) as { key?: string };
  fs.writeFileSync(file(), JSON.stringify(read().filter((o) => o.key !== key), null, 2));
  return Response.json({ ok: true });
}
