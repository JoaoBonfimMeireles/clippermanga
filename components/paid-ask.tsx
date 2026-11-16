'use client';
// Pergunta do job quando a OmniRoute cai: "usar o Claude?" Sim (continua com o Claude, gasta o plano) ou
// Não (espera a OmniRoute voltar, sem gastar). Aparece ao lado da barra de carregamento do job.
import { useState } from 'react';
import type { JobInfo } from '@/lib/types';

export function PaidAsk({ job, projectId }: { job: JobInfo; projectId: string }) {
  const [sent, setSent] = useState(false);
  if (!job.askPaid || job.status !== 'running' || sent) return null;
  const answer = async (yes: boolean) => {
    setSent(true);
    const r = await fetch(`/api/projects/${projectId}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'paid', job: job.id, yes }) });
    if (!r.ok) setSent(false);
  };
  return (
    <span className="inline-flex items-center gap-1 rounded border border-amber-500/60 bg-amber-500/15 px-2 py-0.5 text-xs text-amber-200" onClick={(e) => e.preventDefault()}>
      ⚠ OmniRoute fora do ar. Usar o Claude (gasta o seu plano)?
      <button className="rounded bg-green-600 px-2 py-0.5 font-medium text-white hover:bg-green-500" onClick={() => answer(true)}>
        Sim
      </button>
      <button className="rounded bg-muted px-2 py-0.5 font-medium hover:bg-muted/70" onClick={() => answer(false)} title="Espera a OmniRoute voltar, sem gastar">
        Não
      </button>
    </span>
  );
}
