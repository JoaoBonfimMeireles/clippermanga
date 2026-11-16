import { createHash } from 'node:crypto';
import { deleteProject, readProjectRaw, updateProject } from '@/lib/store';
import { cancelJob, projectJobs } from '@/lib/jobs';
import { renameProject, RenameError } from '@/lib/series';
import type { Doubt, StudioProject } from '@/lib/types';
import { logDoubtAnswers, logEdits } from '@/lib/learning';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Devolve o JSON como está no disco (sem parse + stringify) e responde 304 se o navegador já tem esta versão. */
export async function GET(req: Request, { params }: Ctx) {
  const r = readProjectRaw((await params).id);
  if (!r) return new Response('Não encontrado', { status: 404 });
  const etag = `"${createHash('sha1').update(r.version).digest('hex').slice(0, 16)}"`;
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache', etag };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(r.raw, { headers });
}

/** Salva o que o editor muda (título, contexto, formato, narração, linha do tempo). Páginas e render ficam com o servidor. */
export async function PUT(req: Request, { params }: Ctx) {
  const body = (await req.json()) as Partial<StudioProject> & { doubtAnswers?: (Doubt & { manual?: boolean })[] };
  try {
    const pid = (await params).id;
    const p = updateProject(pid, (cur) => {
      // anota o que o usuário mudou na linha do tempo (a IA aprende com isso depois do render)
      if (body.shots) {
        try {
          logEdits(pid, cur.shots, body.shots);
        } catch {
          /* log é só aprendizado */
        }
      }
      if (body.doubtAnswers) {
        try {
          logDoubtAnswers(pid, body.doubtAnswers);
        } catch {
          /* log é só aprendizado */
        }
      }
      for (const k of ['title', 'context', 'format', 'narration', 'voice', 'subtitles', 'endSilence', 'endTalkPad', 'chapterContexts', 'shots', 'cutWords', 'targetMinutes', 'englishAudio', 'autoPaid', 'series', 'fullVideoUrl', 'doubts', 'lockedPages', 'lastImportUrl', 'ytTitle', 'publishedAt'] as const) {
        if (body[k] === undefined) continue;
        // guarda a data anterior para poder voltar (trocar de lugar com a atual = desfazer/refazer)
        if (k === 'publishedAt' && (body[k] || undefined) !== cur.publishedAt) cur.prevPublishedAt = cur.publishedAt;
        // string vazia = limpar o campo
        (cur as unknown as Record<string, unknown>)[k] = (k === 'ytTitle' || k === 'publishedAt') && !body[k] ? undefined : body[k];
      }
    });
    return Response.json(p);
  } catch (e) {
    return new Response((e as Error).message, { status: 404 });
  }
}

/** Renomear geral: título, memória da série e arquivo do vídeo. */
export async function PATCH(req: Request, { params }: Ctx) {
  const { title } = (await req.json().catch(() => ({}))) as { title?: string };
  try {
    return Response.json(renameProject((await params).id, title ?? ''));
  } catch (e) {
    return new Response((e as Error).message, { status: e instanceof RenameError ? e.status : 500 });
  }
}

export async function DELETE(_: Request, { params }: Ctx) {
  const id = (await params).id;
  // para o que estiver rodando, senão o processo recria arquivos na pasta apagada
  const running = projectJobs(id).filter((j) => j.status === 'running');
  running.forEach((j) => cancelJob(j.id));
  if (running.length) await new Promise((r) => setTimeout(r, 1500));
  try {
    deleteProject(id);
  } catch (e) {
    return new Response((e as Error).message, { status: 500 });
  }
  return Response.json({ ok: true });
}
