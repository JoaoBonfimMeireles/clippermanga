'use client';
// Consumo do OmniRoute. Os dados vêm de /api/usage (back-end); são privados e não ficam salvos no navegador.
import { useEffect, useState } from 'react';
import { tablesOf } from '@/lib/omniroute-usage-types';
import { UsageOverview } from '@/components/usage-overview';
import { VoiceUsage } from '@/components/voice-usage';

const REPORTS = [
  ['analytics', 'Resumo e tendência'],
  ['history', 'Histórico (requisições, tokens, custo)'],
  ['request-logs', 'Registros por requisição'],
  ['quota', 'Cotas por provedor'],
  ['logs-export', 'Exportação de logs'],
] as const;

export default function UsagePage() {
  const [report, setReport] = useState<string>('analytics');
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError('');
    setData(null);
    fetch(`/api/usage?report=${report}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) setError(j.error ?? `HTTP ${r.status}`);
        else setData(j);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [report]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold">Consumo do OmniRoute</h1>
        <select className="field w-auto" value={report} onChange={(e) => setReport(e.target.value)}>
          {REPORTS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <a className="btn-primary" href={`/api/usage?report=${report}&format=json&download=1`}>
          JSON
        </a>
        <a className="btn-primary" href={`/api/usage?report=${report}&format=csv&download=1`}>
          CSV
        </a>
      </div>
      <UsageOverview />
      <VoiceUsage />
      <p className="text-sm text-muted-foreground">Dados privados: os logs podem conter o conteúdo das requisições.</p>
      {loading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {error && <p className="rounded border border-red-500/50 p-3 text-sm text-red-500">{error}</p>}
      {data != null &&
        tablesOf(report, data).map((t) => {
          const cols = [...new Set(t.rows.flatMap((r) => Object.keys(r)))];
          return (
            <section key={t.title} className="space-y-1">
              <h2 className="text-sm font-semibold">{t.title}</h2>
              <div className="max-h-[50vh] overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>{cols.map((c) => <th key={c} className="px-2 py-1 text-left font-medium">{c.replace(/_/g, ' ')}</th>)}</tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r, i) => (
                      <tr key={i} className="border-t">
                        {cols.map((c) => <td key={c} className="whitespace-nowrap px-2 py-1">{r[c] == null ? '—' : String(r[c])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
    </div>
  );
}
