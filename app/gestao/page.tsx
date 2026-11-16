'use client';
// Gestão: placar de cada agente (Leitor, Cortador, Montador), auditorias do gestor com exemplos (imagem e texto)
// e propostas de regra que você aprova ou recusa.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CropThumb } from '@/components/doubts-modal';
import { pageUrl } from '@/components/preview';
import { LearnQuestions, refreshPending, useLearning } from '@/components/learn-questions';
import type { Audit, Finding, ManagedAgent, ProjectScore, Snapshot } from '@/lib/manager';

interface Data {
  projects: ProjectScore[];
  history: Snapshot[];
  audits: Audit[];
  rules: number;
  skills: Record<ManagedAgent, { name: string; count: number }>;
}
const AGENTS: ManagedAgent[] = ['leitor', 'cortador', 'montador'];
const STAGE: Record<string, string> = { edit: 'depois da edição', check: 'depois da validação', render: 'no render', audit: 'auditoria manual' };
const NAME: Record<ManagedAgent, string> = { leitor: 'Leitor', cortador: 'Cortador', montador: 'Montador' };
const ROLE: Record<ManagedAgent, string> = {
  leitor: 'Lê as páginas, desenha a caixa de cada quadro e escreve o roteiro. Nota cai quando você reescreve o texto ou precisa ABRIR um recorte (a caixa veio pequena).',
  cortador: 'Recorta a melhor parte da imagem. Nota cai quando você muda recorte, zoom ou esticar à mão, ou troca o palpite da IA numa dúvida.',
  montador: 'Escolhe a imagem de cada fala e o ritmo. Nota cai quando você troca a imagem (inclusive para repetir a da fala vizinha), duração, velocidade ou apaga/move partes.',
};
const SEV: Record<Finding['severity'], string> = { alta: 'border-red-500 text-red-300', media: 'border-amber-500 text-amber-300', baixa: 'border-sky-500 text-sky-300' };
const tone = (s: number) => (s >= 85 ? 'text-green-400' : s >= 65 ? 'text-amber-300' : 'text-red-400');

function Example({ f }: { f: Finding }) {
  const [big, setBig] = useState(false);
  return (
    <li className="flex flex-wrap gap-3 rounded border p-2 text-sm">
      {f.page && f.focus && (
        <button type="button" className={big ? 'cursor-zoom-out' : 'cursor-zoom-in'} title="Clique para ampliar" onClick={() => setBig(!big)}>
          <CropThumb src={pageUrl(f.projectId, f.page)} page={f.page} focus={f.focus} scale={big ? 3 : 1} />
        </button>
      )}
      <div className="min-w-[220px] flex-1 space-y-1">
        <p>
          <span className={`mr-2 rounded border px-1.5 py-0.5 text-xs ${SEV[f.severity]}`}>{f.severity}</span>
          <b>{NAME[f.agent]}</b> · parte {f.part}
          {f.areaPct !== undefined && <span className="text-muted-foreground"> · ocupa {f.areaPct}% da tela</span>}
        </p>
        <p className="italic text-muted-foreground">“{f.text}”</p>
        <p><span className="text-red-300">Problema:</span> {f.problem}</p>
        {f.suggestion && <p><span className="text-green-300">Melhor seria:</span> {f.suggestion}</p>}
      </div>
    </li>
  );
}

export default function Gestao() {
  const { learn, post: postLearn } = useLearning();
  const openQuestions = (learn?.questions ?? []).filter((q) => !q.answer).length;
  const [d, setD] = useState<Data | null>(null);
  // a página só ganha conteúdo depois de carregar: a âncora do header (#perguntas) rola até a seção quando ela existe
  const jumped = useRef(false);
  useEffect(() => {
    if (!d || jumped.current || location.hash !== '#perguntas') return;
    jumped.current = true; // só na primeira carga: as atualizações seguintes não puxam a tela de volta
    document.getElementById('perguntas')?.scrollIntoView();
  }, [d]);
  const [pick, setPick] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => fetch('/api/gestao').then((r) => r.json()).then((x: Data) => { setD(x); setPick((p) => p || x.projects[0]?.projectId || ''); }), []);
  useEffect(() => { load(); }, [load]);

  const audit = async () => {
    if (!pick) return;
    setMsg('Auditoria iniciada: acompanhe em "Processo em andamento" na tela inicial; recarregue aqui em ~1 min.');
    const r = await fetch(`/api/projects/${pick}/jobs`, { method: 'POST', body: JSON.stringify({ kind: 'audit' }) });
    if (!r.ok) setMsg(await r.text());
  };
  const decide = async (id: string, action: 'approve' | 'reject') => {
    await fetch('/api/gestao', { method: 'POST', body: JSON.stringify({ id, action }) });
    refreshPending();
    load();
  };
  if (!d) return <p className="text-sm text-muted-foreground">Carregando…</p>;

  const proj = d.projects.find((p) => p.projectId === pick);
  const hist = d.history.filter((h) => h.projectId === pick);
  // só compara pontos medidos com o mesmo critério (os antigos contavam mudanças do próprio app como correção sua)
  const trend = (a: ManagedAgent) => (hist.length >= 2 && hist[hist.length - 1].criteria === hist[hist.length - 2].criteria ? hist[hist.length - 1].scores[a] - hist[hist.length - 2].scores[a] : null);
  const pending = d.audits.flatMap((a) => a.proposals.filter((x) => x.status === 'pending').map((x) => ({ x, a })));

  return (
    <div className="mx-auto max-w-[1100px] space-y-8">
      <section className="space-y-2">
        <h1 className="text-xl font-semibold">Gestão dos agentes</h1>
        <p className="text-sm text-muted-foreground">
          O gestor mede o trabalho do Leitor, do Cortador e do Montador, audita uma amostra depois de cada edição com IA e propõe regras novas.
          Nada vira regra sem a sua aprovação. Hoje: {d.rules} regras aprendidas das suas correções · {AGENTS.map((a) => `${d.skills[a].count} habilidades do ${NAME[a]}`).join(' · ')}.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select className="field max-w-xs" value={pick} onChange={(e) => setPick(e.target.value)}>
            {d.projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.title} ({p.shots} partes)</option>)}
          </select>
          <button className="btn-primary" onClick={audit} disabled={!pick}>Rodar auditoria agora</button>
          <button className="btn" onClick={load}>Atualizar</button>
        </div>
        {msg && <p className="text-sm text-sky-300">{msg}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Placar {proj ? `· ${proj.title}` : ''}</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {AGENTS.map((a) => {
            const s = proj?.agents[a];
            const t = trend(a);
            return (
              <div key={a} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-baseline justify-between">
                  <b>{NAME[a]}</b>
                  <span className={`text-2xl font-semibold ${s ? tone(s.score) : ''}`}>{s ? s.score : '–'}<span className="text-sm text-muted-foreground">/100</span></span>
                </div>
                <p className="text-xs text-muted-foreground">{ROLE[a]}</p>
                {s && (
                  <>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-sky-400" style={{ width: `${s.score}%` }} /></div>
                    <p className="text-sm">Você corrigiu <b>{s.corrected}</b> de {proj!.shots} partes ({Math.round(s.correctedRate * 100)}%)</p>
                    {t !== null && <p className={`text-xs ${t >= 0 ? 'text-green-400' : 'text-red-400'}`}>{t >= 0 ? '▲' : '▼'} {Math.abs(t)} pontos desde a auditoria anterior</p>}
                    <ul className="space-y-0.5 text-xs">
                      {s.auto.map((x) => <li key={x.label} className={x.count ? 'text-amber-300' : 'text-muted-foreground'}>{x.count} · {x.label}</li>)}
                    </ul>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {hist.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-sky-300">Evolução (uma linha por medição; a que vale é a do render, depois das suas correções)</summary>
            <table className="mt-2 w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th>Quando</th><th>Etapa</th><th>Leitor</th><th>Cortador</th><th>Montador</th><th>Corrigidas à mão (corte)</th></tr></thead>
              <tbody>{hist.slice().reverse().map((h) => <tr key={h.at} className={h.criteria ? '' : 'text-muted-foreground'} title={h.criteria ? '' : 'Critério antigo: contava como correção sua o que o próprio app regravava em massa. Não compare com as linhas novas.'}><td>{new Date(h.at).toLocaleString('pt-BR')}</td><td>{h.criteria ? STAGE[h.stage ?? 'audit'] : 'critério antigo'}</td><td>{h.scores.leitor}</td><td>{h.scores.cortador}</td><td>{h.scores.montador}</td><td>{h.corrected ? `${h.corrected.cortador} de ${h.shots}` : '–'}</td></tr>)}</tbody>
            </table>
          </details>
        )}
      </section>

      <section id="perguntas" className="scroll-mt-4 space-y-3">
        <h2 className="text-lg font-medium">Perguntas da IA sobre as suas correções ({openQuestions} esperando você)</h2>
        <p className="text-xs text-muted-foreground">Responder aqui ou na aba 🧠 do editor é a mesma coisa: a resposta vale para todos os projetos e entra nos próximos prompts de edição.</p>
        <LearnQuestions learn={learn} post={postLearn} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Regras propostas pelo gestor ({pending.length} esperando você)</h2>
        {!pending.length && <p className="text-sm text-muted-foreground">Nenhuma proposta pendente. Elas aparecem quando a auditoria vê o mesmo erro em 2 ou mais partes.</p>}
        {pending.map(({ x, a }) => {
          const ex = a.findings.filter((f) => x.findingIds.includes(f.id));
          return (
            <div key={x.id} className="space-y-2 rounded-lg border border-sky-500/50 p-3">
              <p className="text-sm"><b>{NAME[x.agent]}</b> · {x.title} <span className="text-xs text-muted-foreground">(de “{a.title}”)</span></p>
              <p className="text-sm">📌 <b>Regra:</b> {x.rule}</p>
              {x.why && <p className="text-xs text-muted-foreground">Por quê: {x.why}</p>}
              {ex.length > 0 && <ul className="space-y-2">{ex.map((f) => <Example key={f.id} f={f} />)}</ul>}
              <div className="flex gap-2">
                <button className="btn-primary" onClick={() => decide(x.id, 'approve')}>✔ Aprovar (vira habilidade do {NAME[x.agent]})</button>
                <button className="btn" onClick={() => decide(x.id, 'reject')}>✖ Recusar</button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Auditorias recentes</h2>
        {!d.audits.length && (
          <div className="space-y-1 rounded-lg border p-3 text-sm text-muted-foreground">
            <p>Ainda não houve auditoria. Ela roda sozinha no fim de cada “Editar com IA”, ou no botão acima. Um exemplo do que aparece aqui:</p>
            <p className="italic">Cortador · parte 41 · ocupa 27% da tela — “Problema: o recorte pega só o balão de fala; Melhor seria: mostrar o personagem cortando o balão.” (com a imagem do recorte ao lado)</p>
          </div>
        )}
        {d.audits.map((a) => (
          <details key={a.id} className="rounded-lg border p-3" open={a === d.audits[0]}>
            <summary className="cursor-pointer text-sm"><b>{a.title}</b> · {new Date(a.at).toLocaleString('pt-BR')} · {a.sampled} partes amostradas · {a.findings.length} achados</summary>
            {a.summary && <p className="mt-2 text-sm">{a.summary}</p>}
            <ul className="mt-2 space-y-2">{a.findings.map((f) => <Example key={f.id} f={f} />)}</ul>
          </details>
        ))}
      </section>
    </div>
  );
}
