'use client';
// Área de foco sobre a página: arraste no vazio para desenhar, arraste dentro para mover,
// e puxe as bordas/cantos (alças) para ajustar cada lado com precisão.
import { useEffect, useRef, useState } from 'react';
import type { Rect } from '@/lib/types';

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const MIN = 0.02; // tamanho mínimo do foco (fração da página)

/** Lados que uma alça move: n = topo, s = base, w = esquerda, e = direita. */
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const CURSOR: Record<Edge, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };

type Drag = { mode: 'draw' | 'move' | Edge; sx: number; sy: number; start: Rect; mark?: number };

/** Novo retângulo ao mover/puxar alça (compartilhado entre o recorte e os recortes marcados). */
function reshape(d: Drag, x: number, y: number): Rect {
  const s = d.start;
  if (d.mode === 'draw') return { x0: Math.min(d.sx, x), y0: Math.min(d.sy, y), x1: Math.max(d.sx, x), y1: Math.max(d.sy, y) };
  if (d.mode === 'move') {
    const dx = Math.min(1 - s.x1, Math.max(-s.x0, x - d.sx));
    const dy = Math.min(1 - s.y1, Math.max(-s.y0, y - d.sy));
    return { x0: s.x0 + dx, y0: s.y0 + dy, x1: s.x1 + dx, y1: s.y1 + dy };
  }
  // alça: move só os lados dela, sem deixar o retângulo virar do avesso
  const r = { ...s };
  if (d.mode.includes('n')) r.y0 = Math.min(y, s.y1 - MIN);
  if (d.mode.includes('s')) r.y1 = Math.max(y, s.y0 + MIN);
  if (d.mode.includes('w')) r.x0 = Math.min(x, s.x1 - MIN);
  if (d.mode.includes('e')) r.x1 = Math.max(x, s.x0 + MIN);
  return r;
}

const HANDLES: { edge: Edge; style: React.CSSProperties; cls: string }[] = [
  { edge: 'n', style: { left: '50%', top: 0 }, cls: 'h-2 w-8' },
  { edge: 's', style: { left: '50%', top: '100%' }, cls: 'h-2 w-8' },
  { edge: 'w', style: { left: 0, top: '50%' }, cls: 'h-8 w-2' },
  { edge: 'e', style: { left: '100%', top: '50%' }, cls: 'h-8 w-2' },
  { edge: 'nw', style: { left: 0, top: 0 }, cls: 'size-3' },
  { edge: 'ne', style: { left: '100%', top: 0 }, cls: 'size-3' },
  { edge: 'sw', style: { left: 0, top: '100%' }, cls: 'size-3' },
  { edge: 'se', style: { left: '100%', top: '100%' }, cls: 'size-3' },
];

export function FocusEditor({ src, width, height, focus, onChange, zoom = 1, marks = [], onMark, onMarkChange }: { src: string; width: number; height: number; focus: Rect; onChange: (r: Rect) => void; /** aproximação da página (1 = cabe na tela) */ zoom?: number; /** recortes marcados (vermelho) nesta página */ marks?: Rect[]; /** botão direito: arrastar no vazio marca um recorte para usar em outra parte */ onMark?: (r: Rect) => void; /** botão direito: mover/puxar alças de um recorte marcado */ onMarkChange?: (i: number, r: Rect) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [mdrag, setMdrag] = useState<(Drag & { cur: Rect }) | null>(null); // botão direito
  // sem o menu do navegador (voltar/recarregar) em cima da página: o botão direito é da marcação
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener('contextmenu', stop, true);
    return () => el.removeEventListener('contextmenu', stop, true);
  }, []);
  useEffect(() => {
    if (!mdrag) return;
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener('contextmenu', stop, true);
    return () => window.removeEventListener('contextmenu', stop, true);
  }, [!!mdrag]);
  const pos = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const down = (e: React.PointerEvent) => {
    const { x, y } = pos(e);
    if (e.button === 2) {
      e.preventDefault();
      if (!onMark) return;
      (e.target as Element).setPointerCapture(e.pointerId);
      let mi = -1;
      for (let k = marks.length - 1; k >= 0 && mi < 0; k--) if (x > marks[k].x0 && x < marks[k].x1 && y > marks[k].y0 && y < marks[k].y1) mi = k;
      if (mi >= 0) setMdrag({ mode: 'move', sx: x, sy: y, start: marks[mi], mark: mi, cur: marks[mi] });
      else setMdrag({ mode: 'draw', sx: x, sy: y, start: { x0: x, y0: y, x1: x, y1: y }, cur: { x0: x, y0: y, x1: x, y1: y } });
      return;
    }
    if (e.button !== 0) return;
    // foco na página inteira não dá para mover: aí arrastar sempre desenha um novo
    const whole = (focus.x1 - focus.x0) * (focus.y1 - focus.y0) > 0.9;
    const inside = !whole && x > focus.x0 && x < focus.x1 && y > focus.y0 && y < focus.y1;
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ mode: inside ? 'move' : 'draw', sx: x, sy: y, start: focus });
    if (!inside) onChange({ x0: x, y0: y, x1: x, y1: y });
  };
  const startEdge = (edge: Edge, mark?: number) => (e: React.PointerEvent) => {
    if (e.button !== (mark === undefined ? 0 : 2)) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const { x, y } = pos(e);
    if (mark === undefined) setDrag({ mode: edge, sx: x, sy: y, start: focus });
    else setMdrag({ mode: edge, sx: x, sy: y, start: marks[mark], mark, cur: marks[mark] });
  };
  const move = (e: React.PointerEvent) => {
    const { x, y } = pos(e);
    if (mdrag) {
      const cur = reshape(mdrag, x, y);
      setMdrag({ ...mdrag, cur });
      if (mdrag.mark !== undefined) onMarkChange?.(mdrag.mark, cur);
      return;
    }
    if (drag) onChange(reshape(drag, x, y));
  };
  const up = (e: React.PointerEvent) => {
    if (mdrag) {
      const r = mdrag.cur;
      if (mdrag.mark === undefined && r.x1 - r.x0 >= 0.03 && r.y1 - r.y0 >= 0.03) onMark?.(r);
      setMdrag(null);
      return;
    }
    if (drag?.mode === 'draw') {
      const { x, y } = pos(e);
      const r = reshape(drag, x, y);
      // retângulo minúsculo (clique sem arrastar) volta para a página inteira
      onChange(r.x1 - r.x0 < 0.03 || r.y1 - r.y0 < 0.03 ? { x0: 0, y0: 0, x1: 1, y1: 1 } : r);
    } else if (drag) move(e);
    setDrag(null);
  };
  const frame = (r: Rect): React.CSSProperties => ({ left: `${r.x0 * 100}%`, top: `${r.y0 * 100}%`, width: `${(r.x1 - r.x0) * 100}%`, height: `${(r.y1 - r.y0) * 100}%` });
  return (
    <div ref={box} className="relative mx-auto cursor-crosshair touch-none select-none" style={{ aspectRatio: `${width} / ${height}`, width: `calc(min(100%, calc(70vh * ${(width / height).toFixed(4)})) * ${zoom})`, flexShrink: 0 }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onContextMenu={(e) => e.preventDefault()} data-testid="focus-editor">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" draggable={false} className="pointer-events-none size-full rounded object-contain" />
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded">
        <div className="absolute border-2 border-primary bg-primary/10" style={{ ...frame(focus), boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.45)' }} />
      </div>
      {/* recortes marcados para usar em outra parte (vermelho; botão direito) */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded">
        {marks.map((m, k) => (
          <div key={k} className="absolute border-2 border-red-500 bg-red-500/15" style={frame(m)} />
        ))}
        {mdrag && mdrag.mark === undefined && <div className="absolute border-2 border-red-500 bg-red-500/15" style={frame(mdrag.cur)} />}
      </div>
      {/* alças das bordas (fora do recorte escuro, para dar para pegar mesmo na beira da página) */}
      <div className="pointer-events-none absolute" style={frame(focus)}>
        {HANDLES.map((h) => (
          <div key={h.edge} title="Puxe para ajustar a borda" onPointerDown={startEdge(h.edge)} className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border border-black/50 bg-white shadow ${h.cls}`} style={{ ...h.style, cursor: CURSOR[h.edge] }} />
        ))}
      </div>
      {marks.map((m, k) => (
        <div key={k} className="pointer-events-none absolute" style={frame(m)}>
          {HANDLES.map((h) => (
            <div key={h.edge} title="Botão direito: puxe para ajustar a borda" onPointerDown={startEdge(h.edge, k)} className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border border-black/50 bg-red-500 shadow ${h.cls}`} style={{ ...h.style, cursor: CURSOR[h.edge] }} />
          ))}
        </div>
      ))}
    </div>
  );
}
