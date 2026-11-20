// Etapa de uma obra: quantos dos 4 passos (roteiro, edição, validação, render) já estão prontos. Mesma regra dos botões verdes do estúdio:
// um passo só conta se os anteriores também estão prontos e são mais antigos. Puro (sem acesso a disco): serve ao servidor e à tela.
type JobLike = { kind: string; status: string; startedAt?: number; endedAt?: number };
const ORDER = ['script', 'edit', 'check', 'render'];

/** 0..4 passos concluídos. */
export function stepsDone(jobs: JobLike[]): number {
  const last = (k: string) => jobs.filter((j) => j.kind === k).sort((a, b) => Number(a.status === 'running') - Number(b.status === 'running') || (a.startedAt ?? 0) - (b.startedAt ?? 0)).at(-1);
  const done = (k: string): boolean => {
    const j = last(k);
    if (j?.status !== 'done') return false;
    const prev = ORDER[ORDER.indexOf(k) - 1];
    return !prev || (done(prev) && (j.endedAt ?? 0) >= (last(prev)?.endedAt ?? 0));
  };
  return ORDER.filter(done).length;
}
