'use client';
// Uso do plano do Claude no header: última hora, janela de 5 h e últimas 24 h, tudo em %.
import { useEffect, useState } from 'react';
import type { ClaudeUsageSummary } from '@/lib/claude-usage';

const fmt = (v: number | null) => (v == null ? '–' : `${v < 10 ? v.toFixed(1).replace('.0', '') : Math.round(v)}%`);
const tone = (v: number | null) => (v != null && v >= 90 ? 'text-red-500' : v != null && v >= 70 ? 'text-amber-500' : 'text-foreground');

export function ClaudeUsageBadge() {
  const [u, setU] = useState<ClaudeUsageSummary | null>(null);
  useEffect(() => {
    let off = false;
    const load = () =>
      fetch('/api/claude-usage', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => !off && setU(j))
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      off = true;
      clearInterval(t);
    };
  }, []);
  if (!u) return null;
  const reset = u.fiveHourResetsAt ? Math.max(0, Math.round((u.fiveHourResetsAt - Date.now()) / 6e4)) : null;
  const title =
    `Claude (plano): 1 h = quanto da janela de 5 h foi gasto na última hora; 5 h = quanto da janela atual já foi usado${reset != null ? ` (renova em ${Math.floor(reset / 60)} h ${reset % 60} min)` : ''}; ` +
    `24 h = quanto do limite semanal foi gasto nas últimas 24 h (semana toda: ${fmt(u.sevenDay)}). Atualiza quando o app chama o Claude.`;
  return (
    <div className="ml-4 flex items-center gap-3 rounded border px-2 py-0.5 text-xs text-muted-foreground" title={title}>
      <span className="font-medium text-foreground">Claude</span>
      <span>
        1 h <b className={`tabular-nums ${tone(u.lastHour)}`}>{fmt(u.lastHour)}</b>
      </span>
      <span>
        5 h <b className={`tabular-nums ${tone(u.fiveHour)}`}>{fmt(u.fiveHour)}</b>
      </span>
      <span>
        24 h <b className={`tabular-nums ${tone(u.last24h)}`}>{fmt(u.last24h)}</b>
      </span>
    </div>
  );
}
