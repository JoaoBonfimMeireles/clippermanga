'use client';
// Etapa 3 em página própria (/p/<id>/final): vídeo final, partes clicáveis (pula no vídeo e edita o texto/duração),
// polir com IA, palavras cortadas, imagem inicial, renderizar de novo, o material de publicação e, embaixo, os shorts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStickBottom } from './use-stick-bottom';
import type { JobInfo, StudioProject } from '@/lib/types';
import { baseOf, shotsDelta, type ShotsBase } from '@/lib/shots-merge';
import { pageUrl } from './preview';
import { PublishPanel } from './publish-panel';
import { ShortsPanel } from './shorts-panel';
import { LastRenderInfo } from './last-render';
import { PaidAsk } from './paid-ask';
import { fmtDuration } from '@/lib/duration';

const fmtTime = (t: number) => fmtDuration(t);
const KIND: Record<JobInfo['kind'], string> = { import: 'Importar', script: 'Roteiro', edit: 'Edição', check: 'Validação', render: 'Render', context: 'Resumos', polish: 'Polir', publish: 'Publicação', subs: 'Legendas', shorts: 'Shorts', english: 'Inglês', restyle: 'Meu estilo', audit: 'Auditoria do gestor', test: 'Teste finalizado', hooks: 'Ganchos da parte', join: 'Juntar partes' };

export function FinalStudio({ id }: { id: string }) {
  const [p, setP] = useState<StudioProject | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [err, setErr] = useState('');
  const [polishPrompt, setPolishPrompt] = useState('');
  const [time, setTime] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const dirty = useRef(false);

  // retrato das partes como o servidor as conhece: o salvamento manda só o que mudou em relação a ele (lib/shots-merge.ts)
  const base = useRef<ShotsBase | null>(null);
  const load = useCallback(async () => {
    const j = (await (await fetch(`/api/projects/${id}`)).json()) as StudioProject;
    base.current = baseOf(j.shots ?? []);
    setP(j);
  }, [id]);
  useEffect(() => {
    load();
    fetch(`/api/projects/${id}/jobs`).then((r) => (r.ok ? r.json() : [])).then(setJobs).catch(() => {});
  }, [id, load]);

  const save = useCallback(async (cur: StudioProject) => {
    dirty.current = false;
    const r = await fetch(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify({ shots: cur.shots, ...shotsDelta(base.current, cur.shots), cutWords: cur.cutWords }) });
    if (r.ok) base.current = baseOf(cur.shots);
  }, [id]);
  useEffect(() => {
    if (!p || !dirty.current) return;
    const t = setTimeout(() => save(p), 600);
    return () => clearTimeout(t);
  }, [p, save]);
  const edit = (fn: (d: StudioProject) => void) =>
    setP((cur) => {
      if (!cur) return cur;
      const d = structuredClone(cur);
      fn(d);
      dirty.current = true;
      return d;
    });

  const running = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const list = (await (await fetch(`/api/projects/${id}/jobs`)).json()) as JobInfo[];
      setJobs(list);
      if (!list.some((j) => j.status === 'running')) load();
    }, 800);
    return () => clearInterval(t);
  }, [running, id, load]);

  // ocioso: um processo iniciado de fora (a cadeia automática, outra aba, o servidor) aparece sozinho, sem precisar de refresh
  useEffect(() => {
    if (running) return;
    const t = setInterval(async () => {
      try {
        const list = (await (await fetch(`/api/projects/${id}/jobs`)).json()) as JobInfo[];
        if (list.some((j) => j.status === 'running')) setJobs(list); // vira "rodando" e o acompanhamento rápido assume
      } catch {
        /* servidor ocupado: tenta de novo */
      }
    }, 4000);
    return () => clearInterval(t);
  }, [running, id]);

  const addJob = (j: JobInfo) => setJobs((cur) => [...cur.filter((x) => x.id !== j.id), j]);
  const flush = async () => void (p && dirty.current && (await save(p)));
  const start = async (body: object | FormData) => {
    setErr('');
    await flush();
    const r = await fetch(`/api/projects/${id}/jobs`, body instanceof FormData ? { method: 'POST', body } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    if (!r.ok) return setErr(await r.text());
    addJob(await r.json());
  };
  const addIntro = (f: File) => {
    const fd = new FormData();
    fd.append('files', f);
    fd.append('chapter', 'Abertura');
    fd.append('intro', '1');
    start(fd);
  };

  if (!p) return <p className="text-muted-foreground">Carregando…</p>;
  const segs = p.lastRender?.segments ?? [];
  const playing = segs.find((g) => time >= g.start && time < g.start + g.dur)?.id;
  const recent = jobs.slice(-4).reverse();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href={`/p/${id}`} className="btn">
          ← Voltar ao estúdio
        </a>
        <h1 className="text-lg font-semibold">{p.title} · 3 · Vídeo final{p.lastRender ? ` (${fmtTime(p.lastRender.duration)})` : ''}</h1>
        {p.lastRender && (
          <a className="btn ml-auto" href={`/api/file?project=${p.id}&video=1&download=1`}>
            Baixar MP4
          </a>
        )}
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      {recent.map((j) => (
        <details key={j.id} className="rounded-md border p-2 text-sm">
          <summary className={`cursor-pointer ${j.status === 'error' ? 'text-destructive' : ''}`}>
            {KIND[j.kind]}: {j.message} · {Math.round(j.progress * 100)}%
            <PaidAsk job={j} projectId={id} />
            {j.status === 'running' && (
              <button className="btn ml-2" onClick={() => fetch(`/api/projects/${id}/jobs?job=${j.id}`, { method: 'DELETE' })}>
                Cancelar
              </button>
            )}
          </summary>
          <JobLogPre logs={j.logs} />
        </details>
      ))}

      {!p.lastRender ? (
        <div className="rounded-lg border p-3 text-sm">
          Ainda não há vídeo renderizado.{' '}
          <button className="btn-primary" disabled={running || !p.shots.length} onClick={() => start({ kind: 'render' })}>
            Renderizar vídeo
          </button>
        </div>
      ) : (
        <div className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[1fr_360px]">
          <video
            ref={video}
            key={p.lastRender.at}
            src={`/api/file?project=${p.id}&video=1&v=${encodeURIComponent(p.lastRender.at)}`}
            controls
            className="max-h-[70vh] w-full rounded bg-black"
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          />
          <div className="flex flex-col gap-3 text-sm">
            <div className="rounded-md border border-primary/50 bg-primary/5 p-3">
              <p className="font-medium">Passo 1 · Editar o vídeo (opcional)</p>
              <p className="mt-1 text-xs text-muted-foreground">Linha do tempo com recortes, zoom, dividir/juntar partes, cortes na narração, filtro por palavra e “Polir com IA” no vídeo todo ou só num trecho (ex.: os 2 primeiros minutos).</p>
              <a href={`/p/${id}/editor`} className="btn-primary mt-2 w-full justify-center">
                ✂ Editar vídeo / polir com IA
              </a>
            </div>
            <button className="btn w-full justify-center" disabled={running} onClick={() => start({ kind: 'render' })}>
              Renderizar de novo
            </button>
            <LastRenderInfo p={p} />
            <p className="text-xs text-muted-foreground">Não quer editar? Siga para o passo 2 abaixo: título, descrição e tags; e o passo 3, os shorts.</p>
          </div>
        </div>
      )}

      {p.lastRender && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-sm font-medium">Passo 2 · Publicação</p>
          <PublishPanel project={p} running={running} beforeStart={flush} onJob={addJob} />
        </div>
      )}

      {p.lastRender && (
        <div className="space-y-1">
          <p className="text-sm font-medium">Passo 3 · Shorts</p>
          <ShortsPanel
            p={p}
            jobs={jobs}
            busy={running}
            onStart={(count, pauseForNarration) => start({ kind: 'shorts', count, pauseForNarration })}
            onApprove={(plan) => start({ kind: 'shorts', approvePlan: true, plan })}
            onRenderOne={(shortId, from, to, skip, cuts, frames) => start({ kind: 'shorts', shortId, from, to, skip, cuts, frames })}
            onGoTo={(i) => {
              const g = segs.find((x) => x.id === p.shots[i]?.id);
              if (g && video.current) {
                video.current.currentTime = g.start;
                video.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }}
            onSaved={load}
          />
        </div>
      )}
    </div>
  );
}

function JobLogPre({ logs }: { logs: string[] }) {
  const ref = useStickBottom<HTMLPreElement>(logs.length);
  return (
    <pre ref={ref} className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
      {logs.join('\n')}
    </pre>
  );
}
