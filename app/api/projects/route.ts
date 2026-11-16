import { projectJobs } from '@/lib/jobs';
import { createProject, duplicateProject, listProjects } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** A lista da tela inicial só precisa do nome e das contagens (o projeto inteiro tem roteiro, partes, legendas...). */
export type ProjectSummary = { id: string; title: string; updatedAt: string; pages: number; shots: number; ytTitle: string; ytTitleIsCustom: boolean; publishedAt: string | null; prevPublishedAt: string | null; job: { kind: string; progress: number; message: string; startedAt?: number } | null };

export function GET() {
  return Response.json(
    listProjects().map((p): ProjectSummary => ({
      id: p.id,
      title: p.title,
      updatedAt: p.updatedAt,
      pages: p.pages.length,
      shots: p.shots.length,
      ytTitle: p.ytTitle?.trim() || p.publish?.title || '',
      ytTitleIsCustom: !!p.ytTitle?.trim(),
      publishedAt: p.publishedAt ?? null,
      prevPublishedAt: p.prevPublishedAt ?? null,
      job: (() => {
        const j = projectJobs(p.id).filter((x) => x.status === 'running').at(-1);
        return j ? { kind: j.kind, progress: j.progress, message: j.message, startedAt: j.startedAt } : null;
      })(),
    })),
  );
}

export async function POST(req: Request) {
  const { title, duplicateOf } = (await req.json().catch(() => ({}))) as { title?: string; duplicateOf?: string };
  if (duplicateOf) {
    try {
      return Response.json(duplicateProject(duplicateOf));
    } catch (e) {
      return new Response((e as Error).message, { status: 404 });
    }
  }
  return Response.json(createProject(title?.trim() || 'Novo mangá'));
}
