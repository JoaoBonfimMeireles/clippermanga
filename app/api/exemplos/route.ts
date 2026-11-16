// Assets de exemplo (lib/exemplos.ts).
// GET lista (do melhor ao pior, e os que deram errado em `bad`) · POST multipart {file, title?, kind?} envia vídeo, ou JSON {url, kind?} baixa do YouTube (kind 'bad' = deu errado)
// PATCH {id, title?, views?, likes?, retention?, subs?, note?} · DELETE ?id=
import { addFromUrl, analyzeExemplo, addUploaded, bads, MAX_EXEMPLOS, MAX_RUINS, ranked, removeExemplo, score, updateExemplo, weakest, type ExemploKind } from '@/lib/exemplos';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const state = () => {
  const list = ranked();
  return {
    max: MAX_EXEMPLOS,
    weakest: list.length >= MAX_EXEMPLOS ? weakest(list)?.id : undefined,
    items: list.map((e) => ({ ...e, score: Math.round(score(e)) })),
    maxBad: MAX_RUINS,
    bad: bads().map((e) => ({ ...e, score: 0 })),
  };
};
const kindOf = (v: unknown): ExemploKind => (v === 'bad' ? 'bad' : 'good');
const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: 400 });

export async function GET() {
  return Response.json(state());
}

export async function POST(req: Request) {
  try {
    if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      const f = await req.formData();
      const file = f.get('file');
      if (!(file instanceof File)) throw new Error('Envie um arquivo de vídeo');
      if (!/^video\//.test(file.type) && !/\.(mp4|mov|webm|mkv)$/i.test(file.name)) throw new Error('O arquivo precisa ser um vídeo (mp4, mov, webm, mkv)');
      await addUploaded(Buffer.from(await file.arrayBuffer()), file.name, String(f.get('title') ?? ''), kindOf(f.get('kind')));
    } else {
      const b = (await req.json()) as { url?: string; analyze?: string; kind?: string };
      if (b.analyze) {
        await analyzeExemplo(b.analyze);
        return Response.json(state());
      }
      await addFromUrl(String(b.url ?? ''), kindOf(b.kind));
    }
    return Response.json(state());
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const { id, ...patch } = (await req.json()) as { id: string } & Record<string, unknown>;
    updateExemplo(id, patch);
    return Response.json(state());
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  removeExemplo(new URL(req.url).searchParams.get('id') ?? '');
  return Response.json(state());
}
