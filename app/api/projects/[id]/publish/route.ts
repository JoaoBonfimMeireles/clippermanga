// Inicia o job de publicação (título, descrição e tags). Multipart: prompt (tom e o que destacar).
import { projectJobs, startJob } from '@/lib/jobs';
import { generatePublish } from '@/lib/publish';
import { peekProject } from '@/lib/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const id = (await params).id;
  if (!peekProject(id)) return new Response('Projeto não encontrado', { status: 404 });
  if (projectJobs(id).some((j) => j.kind === 'publish' && j.status === 'running')) return new Response('Já está gerando o título, a descrição e as tags: espere terminar.', { status: 409 });
  const form = await req.formData();
  const prompt = String(form.get('prompt') ?? '');
  const chapters = String(form.get('chapters') ?? '').replace(/[\[\]]/g, '').trim().slice(0, 20);
  const refs = await Promise.all(
    form
      .getAll('refs')
      .filter((f): f is File => f instanceof File && f.size > 0)
      .slice(0, 6)
      .map(async (f) => ({ name: f.name, data: Buffer.from(await f.arrayBuffer()) })),
  );
  return Response.json(startJob('publish', id, (ctx, signal) => generatePublish(id, { prompt, refs, chapters }, ctx, signal)));
}
