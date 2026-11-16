'use client';
// Painel visual do consumo: qual IA mais consome (por métrica) e o quanto cada provedor já gastou da cota.
// Usa os mesmos dados de /api/usage (analytics + quota); nada fica salvo no navegador.
import { useEffect, useState } from 'react';
import type { UsageAnalytics, UsageQuota } from '@/lib/omniroute-usage-types';

const METRICS = [
  ['requests', 'Requisições'],
  ['totalTokens', 'Tokens'],
  ['cost', 'Custo (US$)'],
] as const;
type Metric = (typeof METRICS)[number][0];

const fmt = (v: number, m: Metric) =>
  m === 'cost' ? `$${v.toFixed(v < 1 ? 4 : 2)}` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} mi` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} mil` : String(Math.round(v));

const value = (r: { requests: number; promptTokens: number; completionTokens: number; totalTokens?: number; cost: number }, m: Metric) =>
  m === 'totalTokens' ? (r.totalTokens ?? r.promptTokens + r.completionTokens) : (r[m] ?? 0);

function useReport<T>(report: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`/api/usage?report=${report}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) setError(j.error ?? `HTTP ${r.status}`);
        else setData(j as T);
      })
      .catch((e) => setError(String(e)));
  }, [report]);
  return { data, error };
}

/** Cor da barra de cota pelo quanto já foi usado. */
const quotaColor = (usedPct: number) => (usedPct >= 90 ? 'bg-red-500' : usedPct >= 70 ? 'bg-amber-500' : 'bg-emerald-500');

function timeUntil(iso: string | null) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'renova a qualquer momento';
  const h = Math.floor(ms / 3.6e6);
  const d = Math.floor(h / 24);
  return `renova em ${d >= 1 ? `${d} d ${h % 24} h` : h >= 1 ? `${h} h` : `${Math.max(1, Math.round(ms / 6e4))} min`}`;
}

export function UsageOverview() {
  const analytics = useReport<UsageAnalytics>('analytics');
  const quota = useReport<UsageQuota>('quota');
  const [metric, setMetric] = useState<Metric>('requests');
  const [group, setGroup] = useState<'model' | 'provider'>('model');

  const rows = analytics.data
    ? (group === 'model' ? analytics.data.byModel.map((m) => ({ label: m.model, sub: m.provider, v: value(m, metric) })) : analytics.data.byProvider.map((p) => ({ label: p.provider, sub: '', v: value(p, metric) })))
        .filter((r) => r.v > 0)
        .sort((a, b) => b.v - a.v)
    : [];
  const total = rows.reduce((s, r) => s + r.v, 0);
  const max = rows[0]?.v ?? 0;
  const top = rows.slice(0, 10);
  const rest = rows.slice(10).reduce((s, r) => s + r.v, 0);

  // O OmniRoute devolve quotaTotal nulo e 100% restante para quem não expõe limite: isso não é "0% usado".
  const all = quota.data?.providers ?? [];
  const hasLimit = (p: (typeof all)[number]) => p.quotaTotal != null || (p.percentRemaining ?? 100) < 100 || !!p.resetAt;
  const noLimit = [...new Set(all.filter((p) => !hasLimit(p)).map((p) => p.name || p.provider))];
  const providers = all
    .filter(hasLimit)
    .map((p) => {
      const usedPct = p.quotaTotal ? (p.quotaUsed / p.quotaTotal) * 100 : 100 - (p.percentRemaining ?? 100);
      return { ...p, usedPct: Math.min(100, Math.max(0, usedPct)) };
    })
    .sort((a, b) => b.usedPct - a.usedPct);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="space-y-3 rounded border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold">Qual IA consome mais</h2>
          <select className="field w-auto text-xs" value={group} onChange={(e) => setGroup(e.target.value as 'model' | 'provider')}>
            <option value="model">por modelo</option>
            <option value="provider">por provedor</option>
          </select>
        </div>
        <div className="flex gap-1">
          {METRICS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setMetric(k)} className={`rounded px-2 py-1 text-xs ${metric === k ? 'bg-foreground text-background' : 'bg-muted'}`}>
              {label}
            </button>
          ))}
        </div>
        {analytics.error && <p className="text-xs text-red-500">{analytics.error}</p>}
        {!analytics.data && !analytics.error && <p className="text-xs text-muted-foreground">Carregando…</p>}
        {analytics.data && !rows.length && <p className="text-xs text-muted-foreground">Sem consumo registrado nessa métrica.</p>}
        <ul className="space-y-2">
          {top.map((r, i) => (
            <li key={r.label + r.sub} className="space-y-0.5">
              <div className="flex items-baseline gap-2 text-xs">
                <span className="truncate font-medium" title={r.label}>
                  {i === 0 && '🏆 '}
                  {r.label}
                </span>
                {r.sub && <span className="truncate text-muted-foreground">{r.sub}</span>}
                <span className="ml-auto whitespace-nowrap tabular-nums">
                  {fmt(r.v, metric)} <span className="text-muted-foreground">({total ? Math.round((r.v / total) * 100) : 0}%)</span>
                </span>
              </div>
              <div className="h-2 rounded bg-muted">
                <div className={`h-2 rounded ${i === 0 ? 'bg-sky-500' : 'bg-sky-500/60'}`} style={{ width: `${max ? (r.v / max) * 100 : 0}%` }} />
              </div>
            </li>
          ))}
        </ul>
        {rest > 0 && <p className="text-xs text-muted-foreground">+ {rows.length - 10} outros: {fmt(rest, metric)}</p>}
        {total > 0 && <p className="border-t pt-2 text-xs text-muted-foreground">Total: {fmt(total, metric)}</p>}
      </section>

      <section className="space-y-3 rounded border p-3">
        <h2 className="text-sm font-semibold">Quanto falta para o limite</h2>
        {quota.error && <p className="text-xs text-red-500">{quota.error}</p>}
        {!quota.data && !quota.error && <p className="text-xs text-muted-foreground">Carregando…</p>}
        {quota.data && !providers.length && <p className="text-xs text-muted-foreground">Nenhum provedor informou um limite ao OmniRoute, então não dá para medir a proximidade dele ainda.</p>}
        <ul className="space-y-3">
          {providers.map((p) => (
            <li key={p.connectionId || p.name} className="space-y-0.5">
              <div className="flex items-baseline gap-2 text-xs">
                <span className="truncate font-medium">{p.name || p.provider}</span>
                {p.name && p.name !== p.provider && <span className="truncate text-muted-foreground">{p.provider}</span>}
                <span className={`ml-auto whitespace-nowrap font-medium tabular-nums ${p.usedPct >= 90 ? 'text-red-500' : p.usedPct >= 70 ? 'text-amber-500' : ''}`}>{Math.round(p.usedPct)}% usado</span>
              </div>
              <div className="h-2 rounded bg-muted">
                <div className={`h-2 rounded ${quotaColor(p.usedPct)}`} style={{ width: `${p.usedPct}%` }} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {p.quotaTotal ? `${p.quotaUsed} de ${p.quotaTotal}` : `${Math.round(p.percentRemaining ?? 0)}% restante`}
                {p.usedPct >= 90 ? ' · quase no limite' : p.usedPct >= 70 ? ' · chegando perto' : ''}
                {p.resetAt ? ` · ${timeUntil(p.resetAt)}` : ''}
                {p.tokenStatus && !['ok', 'active', 'valid'].includes(p.tokenStatus) ? ` · ${p.tokenStatus}` : ''}
              </p>
            </li>
          ))}
        </ul>
        {noLimit.length > 0 && (
          <p className="border-t pt-2 text-[11px] text-muted-foreground">
            Sem limite informado pelo OmniRoute ({noLimit.length}): {noLimit.join(', ')}
          </p>
        )}
      </section>
    </div>
  );
}
