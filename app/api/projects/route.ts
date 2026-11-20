import { projectJobs } from '@/lib/jobs';
import { stepsDone } from '@/lib/stage';
import { seriesKey } from '@/lib/series';
import type { StudioProject } from '@/lib/types';
import { createProject, duplicateProject, listSummaries, updateProject } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** A lista da tela inicial só precisa do nome e das contagens (o projeto inteiro tem roteiro, partes, legendas...). */
export type ProjectSummary = { id: string; title: string; updatedAt: string; pages: number; shots: number; ytTitle: string; ytTitleIsCustom: boolean; seriesKey: string; seriesName: string; part: number; partLabel: string; publishedAt: string | null; steps: number; prevPublishedAt: string | null; joined: { url: string; duration: number; labels: string[]; at: string } | null; job: { kind: string; progress: number; message: string; startedAt?: number } | null };

const summarize = (p: StudioProject): Omit<ProjectSummary, 'job' | 'steps'> => ({
  id: p.id,
  title: p.title,
  updatedAt: p.updatedAt,
  pages: p.pages.length,
  shots: p.shots.length,
  ytTitle: p.ytTitle?.trim() || p.publish?.title || '',
  ytTitleIsCustom: !!p.ytTitle?.trim(),
  seriesKey: seriesKey(p),
  seriesName: p.series?.trim() || p.title,
  part: p.part?.number ?? 0,
  partLabel: p.partLabel?.trim() ?? '',
  publishedAt: p.publishedAt ?? null,
  prevPublishedAt: p.prevPublishedAt ?? null,
  joined: p.joined ? { url: `/api/file?project=${p.id}&f=${encodeURIComponent(p.joined.file.replace(/\\/g, '/').split(`${p.id}/`).pop() ?? '')}`, duration: p.joined.duration, labels: p.joined.labels ?? p.joined.parts.map((n) => `Parte ${n}`), at: p.joined.at } : null,
});

export function GET() {
  return Response.json(
    listSummaries(summarize).map((s): ProjectSummary => ({
      ...s,
      steps: stepsDone(projectJobs(s.id)),
      job: (() => {
        const j = projectJobs(s.id).filter((x) => x.status === 'running').at(-1);
        return j ? { kind: j.kind, progress: j.progress, message: j.message, startedAt: j.startedAt } : null;
      })(),
    })),
  );
}

export async function POST(req: Request) {
  const { title, duplicateOf, series, part } = (await req.json().catch(() => ({}))) as { title?: string; duplicateOf?: string; series?: string; part?: number };
  if (duplicateOf) {
    try {
      return Response.json(duplicateProject(duplicateOf));
    } catch (e) {
      return new Response((e as Error).message, { status: 404 });
    }
  }
  const p = createProject(title?.trim() || 'Novo mangá');
  if (series?.trim()) {
    // parte nova dentro de uma obra: já nasce com o nome da série e o número da parte
    return Response.json(updateProject(p.id, (cur) => {
      cur.series = series.trim();
      if (part && part > 0) cur.part = { number: Math.floor(part) };
    }));
  }
  return Response.json(p);
}
