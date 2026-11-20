'use client';
// "Usar X de Y capítulos" ao lado do nome do projeto: só os X primeiros capítulos baixados passam pelo roteiro, edição com IA,
// validação e render. Os demais ficam guardados (estacionados) e vão para a próxima parte ou voltam ao aumentar o número.
import { useEffect, useState } from 'react';
import type { StudioProject } from '@/lib/types';

export function ChapterLimitControl({ id, p, busy, onChanged }: { id: string; p: StudioProject; busy: boolean; onChanged: () => void }) {
  const used = new Set(p.pages.map((x) => x.chapter)).size;
  const parked = p.parked?.length ?? 0;
  const total = used + parked;
  const [draft, setDraft] = useState(String(used));
  const [err, setErr] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => setDraft(String(used)), [used]);
  if (total < 2 || p.test) return null;

  const apply = async (n: number) => {
    if (n === used || !Number.isFinite(n)) return setDraft(String(used));
    setWorking(true);
    setErr('');
    const r = await fetch(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify({ chapterLimit: Math.max(1, Math.min(total, Math.round(n))) }) }).catch(() => null);
    if (!r?.ok) setErr((await r?.text()) || 'Não consegui mudar.');
    setWorking(false);
    onChanged();
  };
  const nextPart = async () => {
    if (!confirm(`Criar a próxima parte com os ${parked} capítulo(s) que sobraram? Eles saem deste projeto (as imagens são movidas, não baixadas de novo).`)) return;
    setWorking(true);
    setErr('');
    const r = await fetch(`/api/projects/${id}/next-part`, { method: 'POST' }).catch(() => null);
    if (r?.ok) {
      const j = (await r.json()) as { id: string };
      window.location.href = `/p/${j.id}`;
      return;
    }
    setErr((await r?.text()) || 'Não consegui criar a próxima parte.');
    setWorking(false);
  };

  return (
    <div className="flex items-center gap-2 text-sm" title="Quantos dos capítulos baixados entram nos processos (roteiro, edição com IA, validação e render), pela ordem dos capítulos. Os que sobram ficam guardados: aumente o número para trazê-los de volta ou crie a próxima parte com eles.">
      <span>Usar</span>
      <input
        type="number"
        min={1}
        max={total}
        className="field w-16"
        value={draft}
        disabled={busy || working}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void apply(Number(draft))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span>de {total} capítulos</span>
      {parked > 0 && (
        <button type="button" className="btn" disabled={busy || working} onClick={nextPart} title={`Cria a próxima parte já com os ${parked} capítulo(s) que não estão sendo usados aqui.`}>
          ➕ Próxima parte ({parked})
        </button>
      )}
      {err && <span className="text-xs text-red-500">{err}</span>}
    </div>
  );
}
