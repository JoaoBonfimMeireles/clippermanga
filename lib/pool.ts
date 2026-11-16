// Concorrência limitada para trabalho pesado fora do Node (ffmpeg/ffprobe): roda até `limit` de uma vez,
// devolvendo os resultados na ordem da entrada. Um erro para de puxar itens novos e rejeita (os que já começaram terminam).
import os from 'node:os';

export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Fila de um só: o que não pode rodar em paralelo (TTS com cota, Whisper que ocupa muita memória). */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <R>(fn: () => Promise<R>): Promise<R> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/** Partes renderizadas ao mesmo tempo. MANGA_RENDER_JOBS muda; o padrão deixa folga para o próprio x264 usar vários núcleos. */
export function renderConcurrency(nvenc: boolean): number {
  const env = Number(process.env.MANGA_RENDER_JOBS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return Math.max(1, Math.min(nvenc ? 3 : 4, Math.floor(os.cpus().length / 2)));
}

export const PROBE_CONCURRENCY = 8;

/** Fila com N trabalhos ao mesmo tempo que pode ser cancelada (jobs de IA: uma página, um lote de recortes). */
export async function pool<T>(items: readonly T[], n: number, fn: (item: T, index: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  await mapPool(items, Math.max(1, Math.floor(n) || 1), async (item, i) => {
    if (signal?.aborted) throw new Error('cancelado');
    await fn(item, i);
  });
}

/** Quantos ao mesmo tempo: variável do .env (se válida) ou o padrão. */
export const concurrency = (envName: string, def: number) => {
  const v = Number(process.env[envName]);
  return Number.isFinite(v) && v >= 1 ? Math.min(16, Math.floor(v)) : def;
};
