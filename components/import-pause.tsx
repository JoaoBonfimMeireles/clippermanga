'use client';
// Importação pausada: um capítulo falhou em todas as formas de link. Pede a URL (ou o HTML) certa, ou pula o capítulo.
import { useState } from 'react';
import type { JobInfo } from '@/lib/types';
import type { JobPause } from '@/lib/jobs';

export function ImportPause({ projectId, job }: { projectId: string; job: JobInfo & { pause?: JobPause } }) {
  const [url, setUrl] = useState('');
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pz = job.pause;
  if (!pz) return null;
  const send = async (body: object) => {
    setBusy(true);
    setErr('');
    const r = await fetch(`/api/projects/${projectId}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'resume', job: job.id, ...body }) });
    setBusy(false);
    if (!r.ok) return setErr(await r.text());
    setUrl('');
    setHtml('');
  };
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/60 bg-amber-500/10 p-3 text-sm">
      <p className="font-medium">
        O {pz.chapter.replace(/^Capítulo/, 'capítulo')} falhou com o link <span className="break-all font-mono text-xs">{pz.url}</span> — procure o link certo manualmente.
      </p>
      <p className="text-xs text-muted-foreground">{pz.error}</p>
      {pz.tried.length > 1 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Formas já tentadas ({pz.tried.length})</summary>
          {pz.tried.map((t) => (
            <p key={t} className="break-all font-mono">
              {t}
            </p>
          ))}
        </details>
      )}
      <input className="field font-mono text-xs" placeholder="Link certo deste capítulo" value={url} onChange={(e) => setUrl(e.target.value)} />
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">ou cole o HTML da página</summary>
        <textarea className="field mt-1 h-16" value={html} onChange={(e) => setHtml(e.target.value)} />
      </details>
      <p className="text-xs text-muted-foreground">Com o link certo, os próximos capítulos tentam também esse formato antes de pausar de novo.</p>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex gap-2">
        <button className="btn-primary flex-1 justify-center" disabled={busy || (!url.trim() && !html.trim())} onClick={() => send({ url: url.trim() || undefined, html: html.trim() || undefined })}>
          Continuar
        </button>
        <button className="btn" disabled={busy} onClick={() => send({ skip: true })}>
          Pular este capítulo
        </button>
      </div>
    </div>
  );
}
