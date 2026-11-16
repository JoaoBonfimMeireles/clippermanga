'use client';
// Assets de exemplo: até 5 shorts de referência. Envie o vídeo ou cole a URL do YouTube, preencha os números do
// YouTube Studio e a IA dos shorts passa a imitar os que performam melhor. Cheio: apague o pior para entrar outro.
import { useEffect, useRef, useState } from 'react';

interface Item {
  id: string; title: string; url?: string; duration?: number; views?: number; likes?: number; retention?: number; subs?: number; note?: string; score: number; analysis?: string; transcript?: string; avoid?: string[];
}
interface State { max: number; weakest?: string; items: Item[]; maxBad: number; bad: Item[] }

export default function ExemplosPage() {
  const [st, setSt] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [url, setUrl] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const call = async (init?: RequestInit, url = '/api/exemplos') => {
    setError('');
    const r = await fetch(url, init);
    const j = await r.json();
    if (!r.ok) setError(j.error ?? `HTTP ${r.status}`);
    else setSt(j);
    return r.ok;
  };
  useEffect(() => void call(), []);

  const full = !!st && st.items.length >= st.max;
  const [badUrl, setBadUrl] = useState('');
  const badFileRef = useRef<HTMLInputElement>(null);
  const fullBad = !!st && st.bad.length >= st.maxBad;
  const uploadBad = async (file: File) => {
    setBusy('Enviando…');
    const f = new FormData();
    f.set('file', file);
    f.set('kind', 'bad');
    await call({ method: 'POST', body: f });
    setBusy('');
    if (badFileRef.current) badFileRef.current.value = '';
  };
  const downloadBad = async () => {
    setBusy('Baixando do YouTube e analisando…');
    if (await call({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: badUrl, kind: 'bad' }) })) setBadUrl('');
    setBusy('');
  };
  const upload = async (file: File) => {
    setBusy('Enviando…');
    const f = new FormData();
    f.set('file', file);
    await call({ method: 'POST', body: f });
    setBusy('');
    if (fileRef.current) fileRef.current.value = '';
  };
  const download = async () => {
    setBusy('Baixando do YouTube…');
    if (await call({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })) setUrl('');
    setBusy('');
  };
  const patch = (id: string, p: Record<string, unknown>) => call({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...p }) });
  const analyze = (it: Item) => async () => {
    setBusy(`a:${it.id}`);
    await call({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ analyze: it.id }) });
    setBusy('');
  };
  const remove = (it: Item) => confirm(`Apagar "${it.title}"?`) && call({ method: 'DELETE' }, `/api/exemplos?id=${it.id}`);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Assets de exemplo</h1>
        <p className="text-sm text-muted-foreground">
          Até {st?.max ?? 5} shorts de referência. A IA dos shorts lê o título, a duração e os números (views × retenção) e imita os primeiros da lista. Preencha os números do YouTube Studio
          depois de 48 h; quando estiver cheio, apague o último e coloque outro.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded border p-3">
        <input ref={fileRef} type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <button className="btn-primary" disabled={full || !!busy} onClick={() => fileRef.current?.click()}>
          Enviar vídeo
        </button>
        <span className="text-sm text-muted-foreground">ou</span>
        <input className="field max-w-md flex-1" placeholder="https://youtube.com/shorts/..." value={url} disabled={full || !!busy} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url && download()} />
        <button className="btn" disabled={full || !!busy || !url.trim()} onClick={download}>
          Baixar da URL
        </button>
        <span className="ml-auto text-sm">{st?.items.length ?? 0}/{st?.max ?? 5}</span>
        {busy && <span className="basis-full text-sm text-muted-foreground">{busy}</span>}
      </div>
      {full && <p className="rounded border border-primary/50 p-2 text-sm">Cheio. Apague o pior (marcado em vermelho) para entrar um novo.</p>}
      {error && <p className="rounded border border-red-500/50 p-3 text-sm text-red-500">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {st?.items.map((it, i) => (
          <Card key={it.id} it={it} rank={i + 1} worst={st.weakest === it.id} onPatch={(p) => patch(it.id, p)} onRemove={() => remove(it)} analyzing={busy === `a:${it.id}`} onAnalyze={analyze(it)} />
        ))}
      </div>
      {st && !st.items.length && <p className="text-sm text-muted-foreground">Nenhum exemplo ainda.</p>}

      <div className="border-t pt-4">
        <h2 className="text-base font-semibold text-red-500">Shorts que deram errado</h2>
        <p className="text-sm text-muted-foreground">
          Até {st?.maxBad ?? 15}. Conte em &quot;Por que deu errado?&quot; o motivo. O gestor (Opus) lê o vídeo, a fala e o seu motivo, guarda o que evitar no histórico e passa a evitar isso em todos os projetos, antigos e novos.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded border border-red-500/40 p-3">
        <input ref={badFileRef} type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && uploadBad(e.target.files[0])} />
        <button className="btn-primary" disabled={fullBad || !!busy} onClick={() => badFileRef.current?.click()}>
          Enviar vídeo
        </button>
        <span className="text-sm text-muted-foreground">ou</span>
        <input className="field max-w-md flex-1" placeholder="https://youtube.com/shorts/..." value={badUrl} disabled={fullBad || !!busy} onChange={(e) => setBadUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && badUrl && downloadBad()} />
        <button className="btn" disabled={fullBad || !!busy || !badUrl.trim()} onClick={downloadBad}>
          Baixar da URL
        </button>
        <span className="ml-auto text-sm">{st?.bad.length ?? 0}/{st?.maxBad ?? 15}</span>
      </div>
      {fullBad && <p className="rounded border border-red-500/50 p-2 text-sm">Cheio. Apague um para entrar outro.</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {st?.bad.map((it) => (
          <BadCard key={it.id} it={it} onPatch={(p) => patch(it.id, p)} onRemove={() => remove(it)} analyzing={busy === `a:${it.id}`} onAnalyze={analyze(it)} />
        ))}
      </div>
      {st && !st.bad.length && <p className="text-sm text-muted-foreground">Nenhum short ruim ainda.</p>}
    </div>
  );
}

function Card({ it, rank, worst, onPatch, onRemove, onAnalyze, analyzing }: { it: Item; rank: number; worst: boolean; onPatch: (p: Record<string, unknown>) => void; onRemove: () => void; onAnalyze: () => void; analyzing: boolean }) {
  const num = (label: string, key: 'views' | 'retention' | 'likes' | 'subs', suffix = '') => (
    <label className="text-xs text-muted-foreground">
      {label}
      <input
        key={`${key}:${it[key] ?? ''}`}
        className="field mt-0.5"
        type="number"
        min={0}
        defaultValue={it[key] ?? ''}
        placeholder={suffix}
        onBlur={(e) => e.target.value !== String(it[key] ?? '') && onPatch({ [key]: e.target.value })}
      />
    </label>
  );
  return (
    <div className={`space-y-2 rounded border p-2 ${worst ? 'border-red-500/60' : ''}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium">#{rank}</span>
        <span className="text-muted-foreground">nota {it.score}{it.duration ? ` · ${it.duration}s` : ''}</span>
        {worst && <span className="text-red-500">pior</span>}
        <button className="ml-auto text-red-500 hover:underline" onClick={onRemove}>
          Apagar
        </button>
      </div>
      <video className="mx-auto aspect-[9/16] max-h-80 rounded bg-black" controls preload="metadata" src={`/api/exemplos/video?id=${it.id}`} />
      <input key={it.title} className="field font-medium" defaultValue={it.title} onBlur={(e) => e.target.value.trim() && e.target.value !== it.title && onPatch({ title: e.target.value })} />
      <div className="grid grid-cols-4 gap-1.5">
        {num('Views', 'views')}
        {num('Retenção %', 'retention')}
        {num('Likes', 'likes')}
        {num('Inscritos', 'subs')}
      </div>
      <input key={it.note ?? ''} className="field" placeholder="Por que funcionou? (opcional)" defaultValue={it.note ?? ''} onBlur={(e) => e.target.value !== (it.note ?? '') && onPatch({ note: e.target.value })} />
      <details className="rounded border p-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">{it.analysis ? 'O que a IA aprendeu com este short' : 'Ainda não analisado'}</summary>
        {it.analysis && <p className="mt-2 whitespace-pre-wrap">{it.analysis.replace(/\s+-\s+(?=\*{0,2}[A-ZÁÉÍÓÚ])/g, '\n- ')}</p>}
        {it.transcript && <p className="mt-2 text-muted-foreground">Fala: {it.transcript}</p>}
        <button className="btn mt-2" disabled={analyzing} onClick={onAnalyze}>
          {analyzing ? 'Analisando…' : it.analysis ? 'Analisar de novo' : 'Analisar com IA'}
        </button>
      </details>
      {it.url && (
        <a className="block truncate text-xs text-muted-foreground hover:underline" href={it.url} target="_blank" rel="noreferrer">
          {it.url}
        </a>
      )}
    </div>
  );
}

function BadCard({ it, onPatch, onRemove, onAnalyze, analyzing }: { it: Item; onPatch: (p: Record<string, unknown>) => void; onRemove: () => void; onAnalyze: () => void; analyzing: boolean }) {
  const num = (label: string, key: 'views' | 'retention') => (
    <label className="text-xs text-muted-foreground">
      {label}
      <input key={`${key}:${it[key] ?? ''}`} className="field mt-0.5" type="number" min={0} defaultValue={it[key] ?? ''} onBlur={(e) => e.target.value !== String(it[key] ?? '') && onPatch({ [key]: e.target.value })} />
    </label>
  );
  return (
    <div className="space-y-2 rounded border border-red-500/40 p-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-red-500">deu errado{it.duration ? ` · ${it.duration}s` : ''}</span>
        <button className="ml-auto text-red-500 hover:underline" onClick={onRemove}>
          Apagar
        </button>
      </div>
      <video className="mx-auto aspect-[9/16] max-h-80 rounded bg-black" controls preload="metadata" src={`/api/exemplos/video?id=${it.id}`} />
      <input key={it.title} className="field font-medium" defaultValue={it.title} onBlur={(e) => e.target.value.trim() && e.target.value !== it.title && onPatch({ title: e.target.value })} />
      <div className="grid grid-cols-2 gap-1.5">
        {num('Views', 'views')}
        {num('Retenção %', 'retention')}
      </div>
      <textarea key={it.note ?? ''} className="field min-h-16" placeholder="Por que deu errado? (gancho fraco, título, longo demais, final cortado...)" defaultValue={it.note ?? ''} onBlur={(e) => e.target.value !== (it.note ?? '') && onPatch({ note: e.target.value })} />
      <details className="rounded border p-2 text-xs" open={!!it.avoid?.length}>
        <summary className="cursor-pointer text-muted-foreground">{it.analysis ? 'O que a IA vai evitar' : 'Ainda não analisado'}</summary>
        {it.analysis && <p className="mt-2 whitespace-pre-wrap">{it.analysis.replace(/;\s+(?=[A-ZÁÉÍÓÚ][^:]{2,25}:)/g, '\n')}</p>}
        {!!it.avoid?.length && (
          <ul className="mt-2 list-disc space-y-0.5 pl-4">
            {it.avoid.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
        <button className="btn mt-2" disabled={analyzing} onClick={onAnalyze}>
          {analyzing ? 'Analisando…' : it.analysis ? 'Analisar de novo (use depois de editar o motivo)' : 'Analisar com IA'}
        </button>
      </details>
      {it.url && (
        <a className="block truncate text-xs text-muted-foreground hover:underline" href={it.url} target="_blank" rel="noreferrer">
          {it.url}
        </a>
      )}
    </div>
  );
}
