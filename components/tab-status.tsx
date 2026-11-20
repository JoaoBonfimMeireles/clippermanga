'use client';
// Aba do navegador nas telas de uma obra (/p/<id>/...): título = nome da obra; favicon = etapa atual (1 a 4) ou ✓ quando tudo terminou.
import { useEffect } from 'react';
import { stepsDone } from '@/lib/stage';

type Job = { kind: string; status: string; startedAt?: number; endedAt?: number };

function icon(n: number): string {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const finished = n >= 4;
  g.fillStyle = finished ? '#16a34a' : '#2563eb';
  g.beginPath();
  g.arc(32, 32, 32, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 44px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(finished ? '✓' : String(n + 1), 32, 35);
  return c.toDataURL('image/png');
}

export function TabStatus({ id }: { id: string }) {
  useEffect(() => {
    let alive = true;
    let title = '';
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    const old = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
    const prevTitle = document.title;
    const tick = async () => {
      try {
        const [pr, jr] = await Promise.all([fetch(`/api/projects/${id}`), fetch(`/api/projects/${id}/jobs`)]);
        if (!alive) return;
        if (pr.ok) title = String(((await pr.json()) as { title?: string }).title ?? '');
        const jobs = jr.ok ? ((await jr.json()) as Job[]) : [];
        if (title) document.title = title;
        link.href = icon(stepsDone(Array.isArray(jobs) ? jobs : []));
        old.forEach((l) => l.remove());
        if (!link.isConnected) document.head.appendChild(link);
      } catch {
        /* servidor ocupado: tenta de novo no próximo ciclo */
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    // o Next reescreve o título ao navegar; reaplica o nome da obra
    const keep = setInterval(() => { if (title && document.title !== title) document.title = title; }, 1000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(keep);
      link.remove();
      old.forEach((l) => document.head.appendChild(l));
      document.title = prevTitle;
    };
  }, [id]);
  return null;
}
