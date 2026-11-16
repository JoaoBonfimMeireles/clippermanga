// "Como estava e como ficou" de uma parte que o usuário ajustou (pergunta do aprendizado): lê o log de edições do projeto
// (.progress/editlog.jsonl) e devolve, por campo, o valor da primeira e da última mudança, mais a página para desenhar.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readProject } from '@/lib/store';

export const dynamic = 'force-dynamic';

type Entry = { at: string; kind: string; id: string; part: number; text?: string; note?: string; changes?: Record<string, [unknown, unknown]> };

export async function GET(req: Request) {
  const u = new URL(req.url);
  const projectId = u.searchParams.get('project') ?? '';
  const part = Number(u.searchParams.get('part'));
  const p = projectId ? readProject(projectId) : null;
  if (!p || !Number.isFinite(part)) return Response.json(null);
  let lines: Entry[] = [];
  try {
    lines = fs.readFileSync(path.join(projectDir(projectId), '.progress', 'editlog.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry);
  } catch {
    return Response.json(null);
  }
  // a parte pode ter mudado de número depois: acha pelo número que ela tinha no log e segue pelo id da parte
  const hit = [...lines].reverse().find((e) => e.part === part && (e.kind === 'change' || e.kind === 'remove' || e.kind === 'add'));
  if (!hit) return Response.json(null);
  const mine = lines.filter((e) => e.id === hit.id);
  const changes: Record<string, [unknown, unknown]> = {};
  for (const e of mine) for (const [k, [a, b]] of Object.entries(e.changes ?? {})) changes[k] = [k in changes ? changes[k][0] : a, b];
  const kinds = [...new Set(mine.map((e) => e.kind))];
  const notes = mine.map((e) => e.note).filter(Boolean);
  const shot = p.shots.find((s) => s.id === hit.id);
  // página de antes e de depois (a parte pode ter trocado de imagem)
  const pageIds = { before: String(changes.pageId?.[0] ?? shot?.pageId ?? ''), after: String(changes.pageId?.[1] ?? shot?.pageId ?? '') };
  const pageOf = (id: string) => p.pages.find((x) => x.id === id) ?? null;
  const diff = Object.entries(changes).filter(([, [a, b]]) => JSON.stringify(a) !== JSON.stringify(b));
  return Response.json({
    shotId: hit.id,
    text: hit.text ?? shot?.text ?? '',
    kinds,
    notes,
    pageBefore: pageOf(pageIds.before),
    pageAfter: pageOf(pageIds.after),
    changes: Object.fromEntries(diff),
  });
}
