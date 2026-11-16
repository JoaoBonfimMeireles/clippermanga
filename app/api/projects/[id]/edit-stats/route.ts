// O que o usuário já editou neste projeto, lido do log de edições (.progress/editlog.jsonl): por parte, quais campos mudaram.
// Mudanças em massa de uma vez só (dezenas de partes no mesmo instante) são do app (validação, encaixe), não do usuário: ficam de fora.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readProject } from '@/lib/store';
import { bulkSaves } from '@/lib/learning';

export const dynamic = 'force-dynamic';

type Entry = { at: string; kind: string; id: string; changes?: Record<string, unknown> };

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const p = readProject(id);
  if (!p) return Response.json({ edited: {} });
  let lines: Entry[] = [];
  try {
    lines = fs.readFileSync(path.join(projectDir(id), '.progress', 'editlog.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry);
  } catch {
    return Response.json({ edited: {} });
  }
  const bulk = bulkSaves(lines);
  const present = new Set(p.shots.map((s) => s.id));
  const edited: Record<string, string[]> = {};
  for (const e of lines) {
    if ((e.kind !== 'change' && e.kind !== 'add') || bulk.has(e.at) || !present.has(e.id)) continue;
    const set = new Set(edited[e.id] ?? []);
    if (e.kind === 'add') set.add('add');
    for (const k of Object.keys(e.changes ?? {})) set.add(k);
    edited[e.id] = [...set];
  }
  return Response.json({ edited });
}
