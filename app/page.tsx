'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { jobEta, type StudioProject } from '@/lib/types';

const JOB_NAMES: Record<string, string> = { import: 'Importar', script: 'Roteiro', edit: 'Edição', check: 'Validação', render: 'Render', context: 'Resumos', polish: 'Polir', publish: 'Publicação', subs: 'Legendas', shorts: 'Shorts', english: 'Inglês', restyle: 'Ajuste de estilo', audit: 'Auditoria do gestor' };
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
  useEffect(() => {
    fetch('/api/projects').then((r) => r.json()).then(setList);
    // atualiza o andamento dos processos a cada 3 s
    const t = setInterval(() => fetch('/api/projects').then((r) => r.json()).then(setList).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, []);
  const [busy, setBusy] = useState('');
  const reload = () => fetch('/api/projects').then((r) => r.json()).then(setList);
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
  return (
    <div className="mx-auto max-w-[1200px] space-y-6">
      <div className="flex gap-2">
        <input className="field" placeholder="Nome do vídeo (ex.: Solo Leveling cap. 1-3)" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        <button className="btn-primary shrink-0" onClick={create}>
          Novo projeto
        </button>
      </div>
      <ul className="divide-y rounded-lg border">
        {list === null && <li className="p-3 text-sm text-muted-foreground">Carregando…</li>}
        {list?.length === 0 && <li className="p-3 text-sm text-muted-foreground">Nenhum projeto ainda.</li>}
        {/* mais perto de completar 7 dias (ou já passou) no topo; sem data de publicação por último */}
        {list
          ?.slice()
          .sort((a, b) => (a.publishedAt && b.publishedAt ? a.publishedAt.localeCompare(b.publishedAt) : a.publishedAt ? -1 : b.publishedAt ? 1 : 0))
          .map((p) => (
          <li key={p.id} className={`flex items-center ${busy === p.id ? 'opacity-50' : ''}`}>
            <input
              type="checkbox"
              className="ml-3 h-4 w-4 shrink-0 cursor-pointer accent-orange-500"
              checked={!!p.publishedAt}
              disabled={!!busy}
              title={p.publishedAt ? 'Publiquei um vídeo novo hoje (reinicia os 7 dias)' : 'Marcar como publicado hoje'}
              onChange={() => setPublished(p)}
            />
            <Link href={`/p/${p.id}`} className="flex min-w-0 flex-1 items-center justify-between gap-3 p-3 hover:bg-muted">
              <span className="min-w-0">
                <span className="block truncate">{p.title}</span>
                <span className={`block truncate text-xs ${p.ytTitle ? 'text-muted-foreground' : 'text-muted-foreground/60'}`} title="Nome no YouTube">
                  {p.ytTitle || 'Sem título do YouTube ainda'}
                </span>
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
    </div>
  );
}
