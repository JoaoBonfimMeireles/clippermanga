'use client';
// Área de foco sobre a página: arraste no vazio para desenhar, arraste dentro para mover,
// e puxe as bordas/cantos (alças) para ajustar cada lado com precisão.
import { useRef, useState } from 'react';
import type { Rect } from '@/lib/types';

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const MIN = 0.02; // tamanho mínimo do foco (fração da página)

/** Lados que uma alça move: n = topo, s = base, w = esquerda, e = direita. */
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const CURSOR: Record<Edge, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };

export function FocusEditor({ src, width, height, focus, onChange, zoom = 1 }: { src: string; width: number; height: number; focus: Rect; onChange: (r: Rect) => void; /** aproximação da página (1 = cabe na tela) */ zoom?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ mode: 'draw' | 'move' | Edge; sx: number; sy: number; start: Rect } | null>(null);
  const pos = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const down = (e: React.PointerEvent) => {
    const { x, y } = pos(e);
    // foco na página inteira não dá para mover: aí arrastar sempre desenha um novo
    const whole = (focus.x1 - focus.x0) * (focus.y1 - focus.y0) > 0.9;
    const inside = !whole && x > focus.x0 && x < focus.x1 && y > focus.y0 && y < focus.y1;
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ mode: inside ? 'move' : 'draw', sx: x, sy: y, start: focus });
    if (!inside) onChange({ x0: x, y0: y, x1: x, y1: y });
  };
  const startEdge = (edge: Edge) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const { x, y } = pos(e);
    setDrag({ mode: edge, sx: x, sy: y, start: focus });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const { x, y } = pos(e);
    const s = drag.start;
    if (drag.mode === 'draw') onChange({ x0: Math.min(drag.sx, x), y0: Math.min(drag.sy, y), x1: Math.max(drag.sx, x), y1: Math.max(drag.sy, y) });
    else if (drag.mode === 'move') {
      const dx = Math.min(1 - s.x1, Math.max(-s.x0, x - drag.sx));
      const dy = Math.min(1 - s.y1, Math.max(-s.y0, y - drag.sy));
      onChange({ x0: s.x0 + dx, y0: s.y0 + dy, x1: s.x1 + dx, y1: s.y1 + dy });
    } else {
      // alça: move só os lados dela, sem deixar o foco virar do avesso
      const r = { ...s };
      if (drag.mode.includes('n')) r.y0 = Math.min(y, s.y1 - MIN);
      if (drag.mode.includes('s')) r.y1 = Math.max(y, s.y0 + MIN);
      if (drag.mode.includes('w')) r.x0 = Math.min(x, s.x1 - MIN);
      if (drag.mode.includes('e')) r.x1 = Math.max(x, s.x0 + MIN);
      onChange(r);
    }
  };
  const up = (e: React.PointerEvent) => {
    if (drag?.mode === 'draw') {
      const { x, y } = pos(e);
      const r = { x0: Math.min(drag.sx, x), y0: Math.min(drag.sy, y), x1: Math.max(drag.sx, x), y1: Math.max(drag.sy, y) };
      // retângulo minúsculo (clique sem arrastar) volta para a página inteira
      onChange(r.x1 - r.x0 < 0.03 || r.y1 - r.y0 < 0.03 ? { x0: 0, y0: 0, x1: 1, y1: 1 } : r);
    } else if (drag) move(e);
    setDrag(null);
  };
  // posição de cada alça dentro do retângulo do foco
  const handles: { edge: Edge; style: React.CSSProperties; cls: string }[] = [
    { edge: 'n', style: { left: '50%', top: 0 }, cls: 'h-2 w-8' },
    { edge: 's', style: { left: '50%', top: '100%' }, cls: 'h-2 w-8' },
    { edge: 'w', style: { left: 0, top: '50%' }, cls: 'h-8 w-2' },
    { edge: 'e', style: { left: '100%', top: '50%' }, cls: 'h-8 w-2' },
    { edge: 'nw', style: { left: 0, top: 0 }, cls: 'size-3' },
    { edge: 'ne', style: { left: '100%', top: 0 }, cls: 'size-3' },
    { edge: 'sw', style: { left: 0, top: '100%' }, cls: 'size-3' },
    { edge: 'se', style: { left: '100%', top: '100%' }, cls: 'size-3' },
  ];
  return (
    <div ref={box} className="relative mx-auto cursor-crosshair touch-none select-none" style={{ aspectRatio: `${width} / ${height}`, width: `calc(min(100%, calc(70vh * ${(width / height).toFixed(4)})) * ${zoom})`, flexShrink: 0 }} onPointerDown={down} onPointerMove={move} onPointerUp={up} data-testid="focus-editor">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" draggable={false} className="pointer-events-none size-full rounded object-contain" />
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded">
        <div
          className="absolute border-2 border-primary bg-primary/10"
          style={{ left: `${focus.x0 * 100}%`, top: `${focus.y0 * 100}%`, width: `${(focus.x1 - focus.x0) * 100}%`, height: `${(focus.y1 - focus.y0) * 100}%`, boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.45)' }}
        />
      </div>
      {/* alças das bordas (fora do recorte escuro, para dar para pegar mesmo na beira da página) */}
      <div className="pointer-events-none absolute" style={{ left: `${focus.x0 * 100}%`, top: `${focus.y0 * 100}%`, width: `${(focus.x1 - focus.x0) * 100}%`, height: `${(focus.y1 - focus.y0) * 100}%` }}>
        {handles.map((h) => (
          <div
            key={h.edge}
            title="Puxe para ajustar a borda"
            onPointerDown={startEdge(h.edge)}
            className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border border-black/50 bg-white shadow ${h.cls}`}
            style={{ ...h.style, cursor: CURSOR[h.edge] }}
          />
        ))}
      </div>
    </div>
  );
}
