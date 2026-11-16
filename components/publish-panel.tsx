'use client';
// Publicação (fim da etapa 3): título, descrição (com a minutagem dos capítulos) e tags com copiar/baixar, e legendas.
import { useEffect, useRef, useState } from 'react';
import type { JobInfo, StudioProject } from '@/lib/types';
import { fullDescription } from '@/lib/youtube';

const fileUrl = (projectId: string, f: string, download = false) => `/api/file?project=${projectId}&f=${encodeURIComponent(f)}${download ? '&download=1' : ''}`;

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Roda de espera ao lado do texto do botão. */
export function Spinner() {
  return <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]" aria-hidden="true" />;
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="btn"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
    >
      {ok ? 'Copiado' : 'Copiar'}
    </button>
  );
}

export function PublishPanel({ project: p, running, beforeStart, onJob }: { project: StudioProject; running: boolean; beforeStart?: () => Promise<void>; onJob: (j: JobInfo) => void }) {
  const pub = p.publish;
  const [prompt, setPrompt] = useState(pub?.prompt ?? '');
  const [err, setErr] = useState('');
  // capítulos que o vídeo cobre, para o [ ] do título: começa pelo que está na linha do tempo e fica salvo por projeto
  const defaultCh = (() => {
    const label = new Map(p.pages.map((x) => [x.id, x.chapter]));
    const ns = [...new Set(p.shots.map((s) => label.get(s.pageId)))].map((c) => Number(/(\d+)\s*$/.exec(c ?? '')?.[1])).filter((n) => Number.isFinite(n));
    return ns.length ? (Math.min(...ns) === Math.max(...ns) ? `${ns[0]}` : `${Math.min(...ns)}-${Math.max(...ns)}`) : '';
  })();
  const chKey = `manga-chapters-${p.id}`;
  const [chapters, setChapters] = useState(() => {
    try {
      return localStorage.getItem(chKey) ?? pub?.chapters ?? defaultCh;
    } catch {
      return pub?.chapters ?? defaultCh;
    }
  });
  const saveChapters = (v: string) => {
    setChapters(v);
    try {
      localStorage.setItem(chKey, v);
    } catch {
      /* só conveniência */
    }
  };
  // feedback imediato: salvar as edições antes de começar pode demorar, e sem isso parece que o clique não pegou
  const [step, setStep] = useState<'' | 'saving' | 'writing'>('');
  const seen = useRef(false);
  useEffect(() => {
    if (step !== 'writing') return;
    if (running) seen.current = true;
    else if (seen.current) setStep('');
  }, [running, step]);
  useEffect(() => {
    if (step !== 'writing') return;
    const t = setTimeout(() => setStep(''), 180000); // rede de segurança
    return () => clearTimeout(t);
  }, [step]);

  const generate = async () => {
    if (step) return; // um clique só
    setErr('');
    setStep('saving');
    try {
      await beforeStart?.();
      const fd = new FormData();
      fd.append('prompt', prompt);
      fd.append('chapters', chapters);
      const r = await fetch(`/api/projects/${p.id}/publish`, { method: 'POST', body: fd });
      if (!r.ok) {
        setStep('');
        return setErr(await r.text());
      }
      seen.current = false;
      onJob((await r.json()) as JobInfo);
      setStep('writing');
    } catch (e) {
      setStep('');
      setErr((e as Error).message);
    }
  };

  const tagsText = pub?.tags.join(', ') ?? '';
  const description = fullDescription(p); // descrição da IA + minutagem dos capítulos do último render
  const all = pub ? `${pub.title}\n\n${description}\n\nTags: ${tagsText}\n` : '';

  return (
    <div className="space-y-3 border-t pt-3" data-testid="publish-panel">
      <p className="text-sm font-medium">Publicação do vídeo · título, descrição e tags</p>
      <div className="grid gap-3 lg:grid-cols-[340px_1fr]">
        <div className="space-y-2 text-sm">
          <label className="block space-y-1">
            <span className="text-muted-foreground">Pedido para a IA (tom, o que destacar) — opcional</span>
            <textarea className="field h-24" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ex.: tom empolgado, destacar a mansão e a galinha monstro" />
          </label>
          <label className="flex items-center gap-2" title="Vai entre colchetes no fim de cada título. 1 capítulo: 1. Vários: 1-2, 1-3…">
            <span className="text-muted-foreground">Capítulos no vídeo [ ]</span>
            <input className="field w-24 py-1" value={chapters} onChange={(e) => saveChapters(e.target.value)} placeholder="ex.: 1-2" />
          </label>
          <button className="btn-primary w-full" disabled={running || !!step} onClick={generate}>
            {step ? (
              <>
                <Spinner /> {step === 'saving' ? 'Salvando suas edições…' : 'Escrevendo título, descrição e tags…'}
              </>
            ) : pub ? (
              'Gerar título, descrição e tags de novo'
            ) : (
              'Gerar título, descrição e tags com IA'
            )}
          </button>
          {step && <p className="text-xs text-muted-foreground">{step === 'saving' ? 'Primeiro o app salva suas edições do vídeo (em projeto grande leva um pouco).' : 'A IA está escrevendo; costuma levar de 10 a 40 segundos. Não precisa clicar de novo.'}</p>}
          {err && <p className="text-destructive">{err}</p>}
        </div>

        <div className="space-y-3 text-sm">
          {pub && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-muted-foreground">{pub.titles && pub.titles.length > 1 ? 'Títulos para teste A/B' : 'Título'}</span>
              </div>
              {(pub.titles?.length ? pub.titles : [pub.title]).map((t, i, arr) => (
                <div key={i} className="flex items-center gap-2">
                  {arr.length > 1 && <span className="w-5 shrink-0 font-semibold text-amber-300">{'ABC'[i]}</span>}
                  <p className="flex-1 rounded border p-2 font-medium">{t}</p>
                  <CopyBtn text={t} />
                </div>
              ))}
            </div>
          )}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-muted-foreground">Descrição</span>
              <CopyBtn text={description} />
            </div>
            <p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded border p-2">{description}</p>
          </div>
          {pub && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-muted-foreground">Tags ({tagsText.length}/500 caracteres)</span>
                <CopyBtn text={tagsText} />
              </div>
              <div className="flex flex-wrap gap-1 rounded border p-2">
                {pub.tags.map((t) => (
                  <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {pub && (
            <button className="btn" onClick={() => download(`${p.title.replace(/[^\w\- ]+/g, '').trim() || 'video'} - publicacao.txt`, all)}>
              Baixar título + descrição + tags (.txt)
            </button>
          )}
        </div>
      </div>
      <SubsSection project={p} running={running} beforeStart={beforeStart} onJob={onJob} />
    </div>
  );
}

/** Legendas (embaixo da publicação): SRT pt-BR com a minutagem do render, tradução em chinês e vídeo com legenda chinesa. */
function SubsSection({ project: p, running, beforeStart, onJob }: { project: StudioProject; running: boolean; beforeStart?: () => Promise<void>; onJob: (j: JobInfo) => void }) {
  const [err, setErr] = useState('');
  const subsUrl = (f: string) => `/api/projects/${p.id}/subs?f=${f}&v=${encodeURIComponent(p.lastRender?.at ?? '')}`;
  const run = async (kind: 'zh' | 'burn') => {
    setErr('');
    await beforeStart?.();
    const r = await fetch(`/api/projects/${p.id}/subs`, { method: 'POST', body: JSON.stringify({ kind }), headers: { 'content-type': 'application/json' } });
    if (!r.ok) return setErr(await r.text());
    onJob((await r.json()) as JobInfo);
  };
  const zh = p.subs?.zh?.length ? p.subs : null;
  const vid = p.subs?.zhVideo;
  const vidStale = vid && vid.renderAt !== p.lastRender?.at;
  if (!p.lastRender) return null;
  return (
    <div className="space-y-2 border-t pt-3 text-sm" data-testid="subs-panel">
      <p className="font-medium">Legendas para o YouTube</p>
      <p className="text-xs text-muted-foreground">Tempos tirados do último render (início e duração de cada parte no vídeo final). Se mudar o texto, renderize de novo antes de baixar.</p>
      <div className="flex flex-wrap gap-2">
        <a className="btn" href={subsUrl('pt')}>
          Baixar legenda pt-BR (.srt)
        </a>
        <a className="btn" href={subsUrl('txt')}>
          Baixar todos os textos da IA (.txt)
        </a>
        <button className="btn" disabled={running} onClick={() => run('zh')}>
          {zh ? 'Traduzir para chinês de novo' : 'Gerar legenda em chinês (mandarim)'}
        </button>
        {zh && (
          <a className="btn" href={subsUrl('zh')}>
            Baixar legenda chinês (.srt)
          </a>
        )}
      </div>
      <details className="rounded border p-2">
        <summary className="cursor-pointer">Opcional: vídeo com legenda em chinês</summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">Usa o vídeo final já renderizado e só queima a legenda chinesa por cima (fonte Microsoft YaHei). {zh ? '' : 'Traduz antes, se ainda não houver tradução.'}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary" disabled={running} onClick={() => run('burn')}>
              {vid ? 'Gerar de novo' : 'Gerar vídeo legendado em chinês'}
            </button>
            {vid && (
              <a className="btn" href={fileUrl(p.id, vid.file, true)}>
                Baixar MP4 legendado (chinês)
              </a>
            )}
            {vidStale && <span className="text-xs text-amber-600">Feito sobre um render anterior: gere de novo.</span>}
          </div>
          {vid && <video key={vid.at} src={`${fileUrl(p.id, vid.file)}&v=${encodeURIComponent(vid.at)}`} controls className="max-h-80 w-full rounded bg-black" />}
        </div>
      </details>
      {err && <p className="text-destructive">{err}</p>}
    </div>
  );
}
