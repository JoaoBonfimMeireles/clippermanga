// Progresso salvo em disco para jobs longos (até 24 h): se o servidor reiniciar no meio, rodar de novo
// reaproveita o que já foi feito em vez de começar do zero. Um arquivo por projeto e por tipo de trabalho.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './store';

/** 14 dias: dá tempo de o limite do plano renovar sem perder o que já foi feito. */
export const CHECKPOINT_TTL_MS = 14 * 24 * 3600_000;

interface Entry<T> {
  at: number;
  value: T;
}

const fileFor = (projectId: string, name: string) => path.join(projectDir(projectId), '.progress', `${name.replace(/[^\w.-]/g, '_')}.json`);

/** Itens salvos e ainda válidos (menos de 24 h). `version` invalida o salvo quando a lógica/prompt muda. */
export function loadCheckpoint<T>(projectId: string, name: string, version: string): Map<string, T> {
  const out = new Map<string, T>();
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(projectId, name), 'utf8')) as { version: string; items: Record<string, Entry<T>> };
    if (data.version !== version) return out;
    const now = Date.now();
    for (const [k, e] of Object.entries(data.items)) if (now - e.at < CHECKPOINT_TTL_MS) out.set(k, e.value);
  } catch {
    /* sem progresso salvo */
  }
  return out;
}

/** Grava um item já concluído (gravação atômica, para não corromper se o processo cair no meio). */
export function saveCheckpoint<T>(projectId: string, name: string, version: string, key: string, value: T): void {
  const f = fileFor(projectId, name);
  let data: { version: string; items: Record<string, Entry<T>> } = { version, items: {} };
  try {
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (cur.version === version) data = cur;
  } catch {
    /* primeiro item */
  }
  const now = Date.now();
  for (const [k, e] of Object.entries(data.items)) if (now - e.at >= CHECKPOINT_TTL_MS) delete data.items[k];
  data.items[key] = { at: now, value };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  try {
    fs.renameSync(tmp, f);
  } catch {
    fs.writeFileSync(f, fs.readFileSync(tmp));
    fs.rmSync(tmp, { force: true });
  }
}

/** Apaga o progresso salvo (quando o trabalho termina e o resultado já foi aplicado ao projeto). */
export function clearCheckpoint(projectId: string, name: string): void {
  fs.rmSync(fileFor(projectId, name), { force: true });
}
