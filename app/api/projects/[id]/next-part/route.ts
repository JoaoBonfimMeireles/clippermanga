// POST /api/projects/:id/next-part — cria a próxima parte com os capítulos baixados que não foram usados neste projeto.
import { createNextPart } from '@/lib/chapter-limit';
import { projectJobs } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (projectJobs(id).some((j) => j.status === 'running')) return new Response('Tem processo rodando neste projeto: espere terminar.', { status: 409 });
  try {
    const next = createNextPart(id);
    return Response.json({ id: next.id, title: next.title });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
