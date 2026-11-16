// Fila com N trabalhos ao mesmo tempo, na ordem. Usada onde as chamadas são independentes entre si (uma página, um lote
// de recortes, um recorte): antes rodavam uma depois da outra e eram o maior tempo da edição e da validação.
// Se um trabalho lança erro, os outros param no fim do item atual e o erro sobe.
export async function pool<T>(items: T[], n: number, fn: (item: T, index: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      if (signal?.aborted) throw new Error('cancelado');
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(n) || 1, items.length)) }, worker));
}

/** Quantos ao mesmo tempo: variável do .env (se válida) ou o padrão. */
export const concurrency = (envName: string, def: number) => {
  const v = Number(process.env[envName]);
  return Number.isFinite(v) && v >= 1 ? Math.min(16, Math.floor(v)) : def;
};
