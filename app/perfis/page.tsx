'use client';
// Perfis de corte: o que o gestor aprendeu em cada teste. Somente leitura, com a opção de apagar uma regra errada.
import { useCallback, useEffect, useState } from 'react';
import type { CutProfile, CutRule, GlobalProfile } from '@/lib/cut-profiles';

interface Data { global: GlobalProfile; profiles: CutProfile[] }
const TONE: Record<CutRule['confidence'], string> = { baixa: 'border-sky-500 text-sky-300', media: 'border-amber-500 text-amber-300', alta: 'border-green-500 text-green-300' };

function Rules({ profile, rules, reload }: { profile: string; rules: CutRule[]; reload: () => void }) {
  if (!rules.length) return <p className="text-sm text-muted-foreground">Nenhuma regra ainda.</p>;
  return (
    <ul className="space-y-2">
      {rules.map((r) => (
        <li key={r.id} className="space-y-1 rounded border p-2 text-sm">
          <div className="flex items-start gap-2">
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${TONE[r.confidence]}`}>{r.confidence}</span>
            <p className="flex-1">{r.text}</p>
            <button
              className="rounded border px-1.5 text-xs hover:bg-muted"
              title="Apagar esta regra"
              onClick={async () => {
                if (!confirm('Apagar esta regra?')) return;
                await fetch(`/api/perfis?profile=${encodeURIComponent(profile)}&rule=${r.id}`, { method: 'DELETE' });
                reload();
              }}
            >
              apagar
            </button>
          </div>
          <p className="text-xs text-muted-foreground">visto em {r.seen} teste(s){r.alsoIn?.length ? ` · obras: ${r.alsoIn.join(', ')}` : ''}</p>
          {!!r.evidence.length && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">de onde veio</summary>
              {r.evidence.map((e, i) => <p key={i}>{e}</p>)}
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function Perfis() {
  const [d, setD] = useState<Data | null>(null);
  const load = useCallback(async () => setD((await (await fetch('/api/perfis')).json()) as Data), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <p className="text-muted-foreground">Carregando…</p>;
  return (
    <div className="mx-auto max-w-3xl space-y-6 py-4">
      <div>
        <h1 className="text-xl font-semibold">Perfis de corte</h1>
        <p className="text-sm text-muted-foreground">O que o gestor aprendeu nos testes: como você quer os cortes e a disposição das imagens. Regras “hipótese” entram na edição com cuidado; apague as que estiverem erradas.</p>
      </div>
      <section className="space-y-2">
        <h2 className="font-medium">Globais (valem para qualquer mangá)</h2>
        <Rules profile="_global" rules={d.global.rules} reload={load} />
      </section>
      {d.profiles.map((p) => (
        <section key={p.key} className="space-y-2">
          <h2 className="font-medium">{p.title}</h2>
          <p className="text-xs text-muted-foreground">{p.tags.join(' · ') || 'sem tags'} · {p.tests.length} teste(s)</p>
          <Rules profile={p.key} rules={p.rules} reload={load} />
        </section>
      ))}
      {!d.profiles.length && <p className="text-sm text-muted-foreground">Nenhum teste finalizado ainda.</p>}
    </div>
  );
}
