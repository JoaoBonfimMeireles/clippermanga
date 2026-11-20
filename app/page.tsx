'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { jobEta, type StudioProject } from '@/lib/types';

const JOB_NAMES: Record<string, string> = { import: 'Importar', script: 'Roteiro', edit: 'Edição', check: 'Validação', render: 'Render', context: 'Resumos', polish: 'Polir', publish: 'Publicação', subs: 'Legendas', shorts: 'Shorts', english: 'Inglês', restyle: 'Ajuste de estilo', audit: 'Auditoria do gestor', hooks: 'Ganchos da parte', join: 'Juntar partes' };
import type { ProjectSummary } from './api/projects/route';

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Dia da publicação + quantos dias faltam para completar uma semana (hora de mexer na obra de novo). */
function PublishedInfo({ at }: { at: string }) {
  const d = new Date(at);
  const left = 7 - Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY);
  const label = left > 1 ? `faltam ${left} dias para 1 semana` : left === 1 ? 'falta 1 dia para 1 semana' : left === 0 ? 'completa 1 semana hoje' : `passou ${-left} ${left === -1 ? 'dia' : 'dias'} de 1 semana`;
  return (
    <span className={`block truncate text-xs ${left <= 0 ? 'font-medium text-orange-400' : 'text-emerald-400'}`}>
      Publicado em {d.toLocaleDateString('pt-BR')} · {label}
    </span>
  );
}

export default function Home() {
  const router = useRouter();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [obras, setObras] = useState<{ key: string; name: string }[]>([]);
  // falha passageira do servidor (ocupado, arquivo sendo gravado) não derruba a tela: mantém o que já tinha e tenta de novo
  const load = () =>
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((l) => setList(l))
      .catch(() => {});
  const loadObras = () => fetch('/api/obras').then((r) => (r.ok ? r.json() : [])).then(setObras).catch(() => {});
  useEffect(() => {
    // atualiza o andamento dos processos ~3 s depois de a consulta anterior terminar (com o servidor ocupado ela passa de 3 s; sem isso as consultas empilham)
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (!stop) t = setTimeout(tick, 3000);
    };
    void tick();
    loadObras();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, []);
  // filtro da lista: todos | não publicados | etapa 1..4 (próximo passo a fazer) | finalizados (os 4 passos prontos)
  const [filter, setFilter] = useState('all');
  useEffect(() => { try { setFilter(localStorage.getItem('home-filter') || 'all'); } catch {} }, []);
  const pickFilter = (f: string) => { setFilter(f); try { localStorage.setItem('home-filter', f); } catch {} };
  const passes = (p: ProjectSummary) => filter === 'all' || (filter === 'unpublished' ? !p.publishedAt : filter === 'done' ? p.steps >= 4 : p.steps < 4 && p.steps + 1 === Number(filter));
  // filtro por data da última edição: qualquer | hoje | ontem | 7 dias | 30 dias
  const [when_, setWhen] = useState('any');
  useEffect(() => { try { setWhen(localStorage.getItem('home-when') || 'any'); } catch {} }, []);
  const pickWhen = (f: string) => { setWhen(f); try { localStorage.setItem('home-when', f); } catch {} };
  const daysAgo = (iso: string) => Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / DAY);
  const inWhen = (p: ProjectSummary) => when_ === 'any' || (when_ === 'today' ? daysAgo(p.updatedAt) <= 0 : when_ === 'yesterday' ? daysAgo(p.updatedAt) === 1 : daysAgo(p.updatedAt) <= Number(when_));
  const [busy, setBusy] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set()); // partes marcadas para juntar num vídeo completo
  const toggleSel = (id: string) => setSel((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const join = async (g: { name: string; items: ProjectSummary[] }) => {
    const items = g.items.filter((x) => sel.has(x.id)); // ordem do painel (número da parte; sem número, pela ordem em que aparecem)
    if (items.length < 2) return alert('Marque pelo menos duas partes desta obra.');
    const label = (x: ProjectSummary) => x.partLabel || (x.part ? `Parte ${x.part}` : x.title);
    if (!confirm(`Juntar ${items.map(label).join(' + ')} num vídeo completo?

Os ganchos das partes saem; a IA escreve só uma abertura e um fechamento novos (voz só deles). O resto reaproveita os vídeos já renderizados (cada parte precisa ter sido renderizada).`)) return;
    const last = items[items.length - 1];
    const r = await fetch(`/api/projects/${last.id}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'join', ids: items.map((x) => x.id) }) });
    if (!r.ok) return alert(await r.text());
    setSel(new Set());
    reload();
  };
  const reload = () => Promise.all([load(), loadObras()]);
  const remove = async (p: ProjectSummary) => {
    if (!confirm(`Excluir "${p.title}"?

Apaga tudo deste projeto do computador: páginas, vídeos, narração, progresso e a memória dele. Não dá para desfazer.`)) return;
    setBusy(p.id);
    const r = await fetch(`/api/projects/${p.id}`, { method: 'DELETE' });
    setBusy('');
    if (!r.ok) alert(`Não consegui excluir: ${await r.text()}`);
    reload();
  };
  const rename = async (p: ProjectSummary) => {
    const title = prompt('Novo nome do projeto (atualiza também a memória da série e o arquivo do vídeo):', p.title)?.trim();
    if (!title || title === p.title) return;
    setBusy(p.id);
    const r = await fetch(`/api/projects/${p.id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    setBusy('');
    if (!r.ok) return alert(await r.text());
    const { note } = (await r.json()) as { note?: string };
    if (note) alert(note);
    reload();
  };
  const patch = async (p: ProjectSummary, body: Record<string, string>) => {
    // atualiza a tela na hora; o servidor grava em segundo plano
    setList((l) => l && l.map((x) => (x.id === p.id ? { ...x, ...('publishedAt' in body ? { publishedAt: body.publishedAt || null, prevPublishedAt: x.publishedAt } : {}), ...('ytTitle' in body ? { ytTitle: body.ytTitle } : {}) } : x)));
    const r = await fetch(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify(body) }).catch(() => null);
    if (!r?.ok) alert(r ? await r.text() : 'Não consegui salvar.');
    reload();
  };
  // clicar no check = "publiquei um vídeo novo hoje" (reinicia os 7 dias); se foi sem querer, "voltar" restaura a data anterior
  const setPublished = (p: ProjectSummary) => patch(p, { publishedAt: new Date().toISOString() });
  const undoPublished = (p: ProjectSummary) => patch(p, { publishedAt: p.prevPublishedAt ?? '' });
  const renameYt = (p: ProjectSummary) => {
    const v = prompt('Nome da obra no YouTube (deixe vazio para voltar ao título gerado em Publicação):', p.ytTitle);
    if (v === null) return;
    patch(p, { ytTitle: v.trim() });
  };
  const duplicate = async (p: ProjectSummary) => {
    setBusy(p.id);
    await fetch('/api/projects', { method: 'POST', body: JSON.stringify({ duplicateOf: p.id }) });
    setBusy('');
    reload();
  };
  const create = async () => {
    const p = (await (await fetch('/api/projects', { method: 'POST', body: JSON.stringify({ title }) })).json()) as StudioProject;
    router.push(`/p/${p.id}`);
  };
  const renamePart = async (p: ProjectSummary) => {
    const v = prompt('Nome da parte no painel (ex.: Parte 1 e 2). Vazio = "Parte N":', p.partLabel || (p.part ? `Parte ${p.part}` : ''));
    if (v === null) return;
    await patch(p, { partLabel: v.trim() });
  };
  const createObra = async () => {
    const name = title.trim();
    if (!name) return alert('Escreva o nome da obra.');
    const r = await fetch('/api/obras', { method: 'POST', body: JSON.stringify({ name }) });
    if (!r.ok) return alert(await r.text());
    setTitle('');
    reload();
  };
  const removeObra = async (key: string) => {
    await fetch('/api/obras', { method: 'DELETE', body: JSON.stringify({ key }) });
    reload();
  };
  const newPart = async (g: { name: string; items: ProjectSummary[] }) => {
    const n = Math.max(0, ...g.items.map((x) => x.part)) + 1;
    const r = await fetch('/api/projects', { method: 'POST', body: JSON.stringify({ title: `${g.name} parte ${n}`, series: g.name, part: n }) });
    if (!r.ok) return alert(await r.text());
    router.push(`/p/${((await r.json()) as StudioProject).id}`);
  };
  // projetos agrupados por obra (mesma série); obras criadas na mão aparecem mesmo sem partes
  const groups = (() => {
    const m = new Map<string, { key: string; name: string; items: ProjectSummary[] }>();
    for (const o of obras) m.set(o.key, { key: o.key, name: o.name, items: [] });
    for (const p of (list ?? []).filter((p) => passes(p) && inWhen(p))) {
      const g = m.get(p.seriesKey) ?? { key: p.seriesKey, name: p.seriesName, items: [] };
      g.items.push(p);
      m.set(p.seriesKey, g);
    }
    const when = (g: { items: ProjectSummary[] }) => g.items.map((x) => x.publishedAt).filter(Boolean).sort().at(-1) ?? null;
    for (const g of m.values()) g.items.sort((a, b) => a.steps - b.steps || a.part - b.part || a.updatedAt.localeCompare(b.updatedAt)); // quem tem mais passos faltando fica no topo
    // obras com mais passos faltando no topo (pelo item mais atrasado); empate: mais perto de completar 7 dias da publicação; sem data por último
    const least = (g: { items: ProjectSummary[] }) => Math.min(4, ...g.items.map((x) => x.steps));
    return [...m.values()].filter((g) => (filter === 'all' && when_ === 'any') || g.items.length).sort((a, b) => {
      if (least(a) !== least(b)) return least(a) - least(b);
      const x = when(a);
      const y = when(b);
      return x && y ? x.localeCompare(y) : x ? -1 : y ? 1 : 0;
    });
  })();
  return (
    <div className="mx-auto max-w-[1200px] space-y-6">
      <div className="flex gap-2">
        <input className="field" placeholder="Nome do vídeo (ex.: Solo Leveling cap. 1-3)" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        <button className="btn-primary shrink-0" onClick={create}>
          Novo projeto
        </button>
        <button className="btn shrink-0" onClick={createObra} title="Cria uma obra (série) no painel; as partes dela ficam agrupadas embaixo">
          Criar obra
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Mostrar:</span>
        {([['all', 'Todos'], ['unpublished', 'Todos menos os já publicados'], ['1', 'Etapa 1'], ['2', 'Etapa 2'], ['3', 'Etapa 3'], ['4', 'Etapa 4'], ['done', '✓ Finalizados']] as const).map(([k, label]) => (
          <button key={k} className={filter === k ? 'btn-primary px-2 py-0.5' : 'btn px-2 py-0.5'} onClick={() => pickFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Última edição:</span>
        {([['any', 'Qualquer data'], ['today', 'Hoje'], ['yesterday', 'Ontem'], ['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias']] as const).map(([k, label]) => (
          <button key={k} className={when_ === k ? 'btn-primary px-2 py-0.5' : 'btn px-2 py-0.5'} onClick={() => pickWhen(k)}>
            {label}
          </button>
        ))}
      </div>
      {list === null && <p className="p-3 text-sm text-muted-foreground">Carregando…</p>}
      {list?.length === 0 && !obras.length && <p className="p-3 text-sm text-muted-foreground">Nenhum projeto ainda.</p>}
      {groups.map((g) => (
        <section key={g.key} className="overflow-hidden rounded-lg border">
          <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2">
            <h2 className="min-w-0 truncate font-medium" title="Obra">
              {g.name} <span className="text-xs font-normal text-muted-foreground">· {g.items.length} {g.items.length === 1 ? 'parte' : 'partes'}</span>
            </h2>
            <span className="flex shrink-0 items-center gap-3 text-sm">
              <button className="text-sky-400 hover:underline" disabled={!!busy} title="Cria uma nova parte desta obra (vídeo novo, com a série e o número da parte já preenchidos)" onClick={() => newPart(g)}>
                + Parte
              </button>
              {g.items.filter((x) => x.joined).map((x) => (
                <a key={x.id} className="text-emerald-400 hover:underline" href={x.joined!.url} target="_blank" rel="noreferrer" title={`${x.joined!.labels.join(' + ')} · gerado em ${new Date(x.joined!.at).toLocaleString('pt-BR')}`}>
                  ▶ Vídeo completo ({Math.round(x.joined!.duration / 60)} min)
                </a>
              ))}
              {g.items.filter((x) => sel.has(x.id)).length >= 2 && (
                <button className="rounded bg-sky-600 px-2 py-0.5 text-white hover:bg-sky-500" disabled={!!busy} onClick={() => join(g)} title="Junta as partes marcadas, em ordem, num vídeo completo (sem os ganchos; só a abertura e o fechamento novos usam voz)">
                  🔗 Juntar {g.items.filter((x) => sel.has(x.id)).length} partes
                </button>
              )}
              {!g.items.length && (
                <button className="text-muted-foreground hover:text-destructive" onClick={() => removeObra(g.key)}>
                  Remover obra
                </button>
              )}
            </span>
          </div>
          <ul className="divide-y">
            {g.items.map((p) => (
          <li key={p.id} className={`flex items-center ${busy === p.id ? 'opacity-50' : ''}`}>
            {g.items.length > 1 && (
              <input type="checkbox" className="ml-3 h-4 w-4 shrink-0 cursor-pointer accent-sky-500" checked={sel.has(p.id)} disabled={!!busy} onChange={() => toggleSel(p.id)} title="Marcar para juntar com outras partes desta obra num vídeo completo" />
            )}
            {p.seriesKey && <span className="w-24 shrink-0 pl-3 text-xs font-medium text-sky-300" title="Parte da obra">{p.partLabel || (p.part ? `Parte ${p.part}` : '')}</span>}
            <input
              type="checkbox"
              className="ml-3 h-4 w-4 shrink-0 cursor-pointer accent-orange-500"
              checked={!!p.publishedAt}
              disabled={!!busy}
              title={p.publishedAt ? 'Publiquei um vídeo novo hoje (reinicia os 7 dias)' : 'Marcar como publicado hoje'}
              onChange={() => setPublished(p)}
            />
            <span className={`ml-3 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${p.steps >= 4 ? 'bg-green-600' : 'bg-blue-600'}`} title={p.steps >= 4 ? 'Todas as etapas prontas' : `Etapa ${p.steps + 1} de 4 (${p.steps} pronta${p.steps === 1 ? '' : 's'})`}>{p.steps >= 4 ? '✓' : p.steps + 1}</span>
            <Link href={`/p/${p.id}`} className="flex min-w-0 flex-1 items-center justify-between gap-3 p-3 hover:bg-muted">
              <span className="min-w-0">
                <span className="block truncate">{p.title}</span>
                <span className={`block truncate text-xs ${p.ytTitle ? 'text-muted-foreground' : 'text-muted-foreground/60'}`} title="Nome no YouTube">
                  {p.ytTitle || 'Sem título do YouTube ainda'}
                </span>
                <span className="block truncate text-xs text-muted-foreground" title={new Date(p.updatedAt).toLocaleString('pt-BR')}>Última edição: {daysAgo(p.updatedAt) <= 0 ? 'hoje' : daysAgo(p.updatedAt) === 1 ? 'ontem' : `${new Date(p.updatedAt).toLocaleDateString('pt-BR')} (há ${daysAgo(p.updatedAt)} dias)`} às {new Date(p.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                {p.publishedAt && <PublishedInfo at={p.publishedAt} />}
                {p.job && (
                  <span className="mt-0.5 flex items-center gap-2 text-xs text-sky-400">
                    <span>⏳ Processo em andamento: <b>{JOB_NAMES[p.job.kind] ?? p.job.kind}</b> · {Math.round(p.job.progress * 100)}%{jobEta({ status: 'running', ...p.job }) ? ` · ${jobEta({ status: 'running', ...p.job })}` : ''}</span>
                    <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-sky-400" style={{ width: `${Math.max(2, Math.round(p.job.progress * 100))}%` }} /></span>
                  </span>
                )}
              </span>
              <span className="shrink-0 text-sm text-muted-foreground">
                {p.pages} páginas · {p.shots} partes
              </span>
            </Link>
            {(p.prevPublishedAt || p.publishedAt) && (
              <button
                className="px-2 py-3 text-xs text-orange-400 hover:underline"
                title={p.prevPublishedAt ? 'Clicou sem querer? Volta para a data anterior' : 'Limpar a data de publicação'}
                onClick={() => undoPublished(p)}
              >
                {p.prevPublishedAt ? `↩ voltar ${new Date(p.prevPublishedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}` : 'limpar data'}
              </button>
            )}
            <button className="px-2 py-3 text-sm text-muted-foreground hover:text-foreground" disabled={!!busy} title="Mudar o nome da obra no YouTube" onClick={() => renameYt(p)}>
              Nome YT
            </button>
            <button className="px-2 py-3 text-sm text-muted-foreground hover:text-foreground" disabled={!!busy} title="Nome da parte no painel (ex.: Parte 1 e 2)" onClick={() => renamePart(p)}>
              Parte
            </button>
            <button className="px-2 py-3 text-sm text-muted-foreground hover:text-foreground" disabled={!!busy} title="Renomear projeto" onClick={() => rename(p)}>
              Renomear
            </button>
            <button className="px-2 py-3 text-sm text-muted-foreground hover:text-foreground" disabled={!!busy} title="Duplicar projeto" onClick={() => duplicate(p)}>
              Duplicar
            </button>
            <button className="px-3 py-3 text-sm text-muted-foreground hover:text-destructive" disabled={!!busy} title="Excluir projeto" onClick={() => remove(p)}>
              Excluir
            </button>
          </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
