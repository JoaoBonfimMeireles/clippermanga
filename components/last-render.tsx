'use client';
// "Último render: 06/11 às 22:02" ao lado do botão de renderizar, e se o vídeo já tem todas as edições.
import type { StudioProject } from '@/lib/types';
import { renderUpToDate } from '@/lib/sig';

export function LastRenderInfo({ p }: { p: StudioProject }) {
  if (!p.lastRender) return <span className="text-xs text-muted-foreground">Ainda não renderizado</span>;
  const d = new Date(p.lastRender.at);
  const day = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  const hour = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const fresh = renderUpToDate(p);
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" title={d.toLocaleString('pt-BR')}>
      Último render: {day} às {hour}
      {fresh ? <span className="text-green-500">· ✔ atualizado</span> : <span className="text-amber-300">· ⚠ edições depois dele</span>}
    </span>
  );
}
