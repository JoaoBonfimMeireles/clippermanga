'use client';
// Prévia ao vivo: mesmo enquadramento do render (lib/camera.ts): recorte do foco, laterais desfocadas, câmera e legenda.
import { useEffect, useRef, useState } from 'react';
import { MANGA_SIZES, type MangaFormat } from '@clipper/shared';
import { cleanRect, cropPx, effSize, frameAt, normRotate, bgBandRange, STRETCH_RANGE, ZOOM_RANGE } from '@/lib/camera';
import { fmtClock, fmtDuration } from '@/lib/duration';
import type { Shot, StudioPage } from '@/lib/types';

/** URL da página. `thumb` = largura em px de uma miniatura (listas e linhas do tempo), muito mais leve que a página inteira. */
export const pageUrl = (projectId: string, pg: StudioPage, thumb?: number) => `/api/file?project=${projectId}&f=${encodeURIComponent(pg.file)}${thumb ? `&w=${thumb}` : ''}`;

function captionAt(text: string, t: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 7) chunks.push(words.slice(i, i + 7).join(' '));
  const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
  let acc = 0;
  for (const c of chunks) {
    acc += c.length / total;
    if (t <= acc) return c;
  }
  return chunks.at(-1) ?? '';
}

/** Fundo: o recorte esticado para cobrir a tela toda (mesma ideia do render). */
function coverBox(c: { w: number; h: number }) {
  const k = Math.max(1 / c.w, 1 / c.h);
  const w = c.w * k, h = c.h * k;
  return { left: `${((1 - w) / 2) * 100}%`, top: `${((1 - h) / 2) * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, overflow: 'hidden' as const };
}

type Drag = { kind: 'stretch' | 'zoom'; side: number; x0: number; y0: number; cx: number; cy: number; w0: number; stretch0: number; zoom0: number };
const clampTo = (v: number, [a, b]: readonly [number, number]) => Math.round(Math.min(b, Math.max(a, v)) * 100) / 100;

export function Preview({ projectId, format, shots, pages, selected, onSelect, subtitles = false, onEditShot, externalTime, hideControls = false }: { projectId: string; format: MangaFormat; shots: Shot[]; pages: StudioPage[]; selected: number; onSelect: (i: number) => void; subtitles?: boolean; onEditShot?: (patch: Partial<Shot>) => void; /** Tempo (s) dentro da parte vindo de fora (ex.: o áudio da narração tocando). */ externalTime?: number; hideControls?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<{ stretch: number; zoom: number } | null>(null);
  const { w: W, h: H } = MANGA_SIZES[format];
  const [playing, setPlaying] = useState<'one' | 'all' | null>(null);
  const [time, setTime] = useState(0); // segundos dentro da parte selecionada
  const raf = useRef(0);
  const shot0 = shots[selected];
  // durante o arraste a prévia usa o rascunho; ao soltar, grava na parte
  const shot = shot0 && draft ? { ...shot0, ...draft } : shot0;
  const pg = shot && pages.find((p) => p.id === shot.pageId);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let t = time;
    let idx = selected;
    const tick = (now: number) => {
      t += (now - last) / 1000;
      last = now;
      const d = shots[idx]?.duration ?? 0;
      if (t >= d) {
        if (playing === 'all' && idx + 1 < shots.length) {
          idx++;
          t = 0;
          onSelect(idx);
        } else {
          setTime(d);
          setPlaying(null);
          return;
        }
      }
      setTime(t);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // trocar de parte fora da reprodução volta ao começo dela
  useEffect(() => {
    if (!playing) setTime(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const frame = shot && pg ? frameAt(shot.focus, shot.motion, shot.fit, pg.width, pg.height, W / H, shot.duration ? (externalTime ?? time) / shot.duration : 0, { rotate: shot.rotate, stretch: shot.stretch, zoom: shot.zoom, reverse: shot.scroll === 'up' }) : null;
  const cam = frame?.cam;
  const band = bgBandRange(shot?.bgBand);
  const r = shot ? cleanRect(shot.focus) : null;
  // a imagem inteira posicionada para que só o recorte (r) apareça dentro da caixa
  const cropStyle = r ? { width: `${100 / (r.x1 - r.x0)}%`, height: `${100 / (r.y1 - r.y0)}%`, left: `${(-r.x0 / (r.x1 - r.x0)) * 100}%`, top: `${(-r.y0 / (r.y1 - r.y0)) * 100}%`, maxWidth: 'none' } : {};
  // recorte girado/esticado: um "suporte" com o recorte original, girado e esticado por CSS, centralizado na caixa
  let holder: React.CSSProperties = { inset: 0 };
  if (shot && pg) {
    const c = cropPx(shot.focus, pg.width, pg.height);
    const ef = effSize(c, { rotate: shot.rotate, stretch: shot.stretch });
    holder = ef.rot
      ? { left: '50%', top: '50%', width: `${(c.w / (c.h * ef.s)) * 100}%`, height: `${(c.h / c.w) * 100}%`, transform: `translate(-50%,-50%) scaleX(${ef.s}) rotate(${ef.deg}deg)` }
      : { left: '50%', top: '50%', width: `${100 / ef.s}%`, height: '100%', transform: `translate(-50%,-50%) scaleX(${ef.s}) rotate(${ef.deg}deg)` };
  }
  // ----- ajuste manual: alças nas laterais esticam, alças nos cantos aproximam -----
  const editing = !!onEditShot && !!frame && !playing;
  const startDrag = (kind: Drag['kind'], side: number) => (e: React.PointerEvent) => {
    if (!shot || !frame || !box.current) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const r = box.current.getBoundingClientRect();
    setDrag({ kind, side, x0: e.clientX, y0: e.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w0: Math.max(8, frame.content.w * r.width), stretch0: shot.stretch ?? 1, zoom0: shot.zoom ?? 1 });
    setDraft({ stretch: shot.stretch ?? 1, zoom: shot.zoom ?? 1 });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === 'stretch') {
      // a caixa cresce para os dois lados: arrastar a alça direita para fora (ou a esquerda) estica
      const w = Math.max(8, drag.w0 + 2 * drag.side * (e.clientX - drag.x0));
      setDraft({ stretch: clampTo((drag.stretch0 * w) / drag.w0, STRETCH_RANGE), zoom: drag.zoom0 });
    } else {
      const d0 = Math.hypot(drag.x0 - drag.cx, drag.y0 - drag.cy) || 1;
      const d = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy);
      setDraft({ stretch: drag.stretch0, zoom: clampTo((drag.zoom0 * d) / d0, ZOOM_RANGE) });
    }
  };
  const endDrag = () => {
    if (drag && draft) onEditShot?.({ stretch: draft.stretch, zoom: draft.zoom });
    setDrag(null);
    setDraft(null);
  };
  const rotateBy = (deg: number) => shot && onEditShot?.({ rotate: normRotate((shot.rotate ?? 0) + deg) });

  const total = shots.reduce((n, s) => n + s.duration, 0);
  const before = shots.slice(0, selected).reduce((n, s) => n + s.duration, 0);

  return (
    <div className="space-y-2">
      <div ref={box} onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={endDrag} className="relative mx-auto overflow-hidden rounded-md bg-black select-none" style={{ containerType: 'inline-size', aspectRatio: `${W} / ${H}`, maxHeight: format === 'vertical' ? 520 : undefined }} data-testid="preview">
        {cam && pg ? (
          <>
            <div className="absolute inset-0 origin-top-left" style={{ transform: `scale(${1 / cam.w}) translate(${-cam.x * 100}%, ${-cam.y * 100}%)` }}>
              {/* fundo: o próprio recorte, ampliado e desfocado */}
              {/* mesmo desfoque do render (boxblur 30×3 ≈ σ 30,5 px numa tela de 2×W) em proporção à largura da prévia, e escurecido ~20% (eq brightness -0.15) */}
              <div className="absolute inset-0 overflow-hidden" style={{ transform: 'scale(1.1)', filter: `blur(${((30.5 / (2 * W)) * 100).toFixed(3)}cqw) brightness(0.8)` }}>
                <div className="absolute" style={{ ...coverBox({ w: frame!.content.w, h: frame!.content.h * (band[1] - band[0]) }) }}>
                  {/* só uma faixa do recorte (de cima ou de baixo), sem o texto do meio */}
                  <div className="absolute inset-x-0" style={{ height: `${100 / (band[1] - band[0])}%`, top: `${(-band[0] / (band[1] - band[0])) * 100}%` }}>
                    <div className="absolute overflow-hidden" style={holder}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={pageUrl(projectId, pg)} alt="" className="absolute" style={cropStyle} />
                    </div>
                  </div>
                </div>
              </div>
              <div className="absolute overflow-hidden" style={{ left: `${frame!.content.x * 100}%`, top: `${frame!.content.y * 100}%`, width: `${frame!.content.w * 100}%`, height: `${frame!.content.h * 100}%` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <div className="absolute overflow-hidden" style={holder}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pageUrl(projectId, pg)} alt="" className="absolute" style={cropStyle} />
                  </div>
              </div>
            </div>
            {editing && (
              <>
                {/* contorno do recorte com as alças (a câmera leve não entra aqui; a caixa é a do começo da parte) */}
                <div className="pointer-events-none absolute border border-dashed border-white/70" style={{ left: `${frame!.content.x * 100}%`, top: `${frame!.content.y * 100}%`, width: `${frame!.content.w * 100}%`, height: `${frame!.content.h * 100}%` }}>
                  {[-1, 1].map((side) => (
                    <div key={side} title="Arraste para esticar na horizontal" onPointerDown={startDrag('stretch', side)} className="pointer-events-auto absolute top-1/2 h-10 w-3 -translate-y-1/2 cursor-ew-resize rounded-sm border border-black/40 bg-white shadow" style={{ [side < 0 ? 'left' : 'right']: 2 }} />
                  ))}
                  {[
                    [-1, -1],
                    [1, -1],
                    [-1, 1],
                    [1, 1],
                  ].map(([sx, sy]) => (
                    <div key={`${sx}${sy}`} title="Arraste para aproximar ou afastar" onPointerDown={startDrag('zoom', sx)} className="pointer-events-auto absolute size-4 cursor-nwse-resize rounded-full border border-black/40 bg-primary shadow" style={{ [sx < 0 ? 'left' : 'right']: 2, [sy < 0 ? 'top' : 'bottom']: 2, cursor: sx === sy ? 'nwse-resize' : 'nesw-resize' }} />
                  ))}
                </div>
                <div className="absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-md bg-black/60 p-1 text-xs text-white">
                  <button className="rounded px-1.5 py-0.5 hover:bg-white/20" title="Girar 90° para a esquerda" onClick={() => rotateBy(-90)}>
                    ↺
                  </button>
                  <button className="rounded px-1.5 py-0.5 hover:bg-white/20" title="Girar 90° para a direita" onClick={() => rotateBy(90)}>
                    ↻
                  </button>
                  <span className="px-1 tabular-nums">
                    {normRotate(shot.rotate)}° · esticar {(shot.stretch ?? 1).toFixed(2)}× · zoom {(shot.zoom ?? 1).toFixed(2)}×
                  </span>
                  {(normRotate(shot.rotate) !== 0 || (shot.stretch ?? 1) !== 1 || (shot.zoom ?? 1) !== 1) && (
                    <button className="rounded px-1.5 py-0.5 hover:bg-white/20" onClick={() => onEditShot?.({ rotate: 0, stretch: 1, zoom: 1 })}>
                      Redefinir
                    </button>
                  )}
                </div>
              </>
            )}
            {subtitles && shot.text && (
              <div className="absolute inset-x-4 bottom-[4%] text-center font-bold text-white" style={{ fontSize: format === 'vertical' ? 14 : 16, textShadow: '0 0 3px #000, 0 0 3px #000, 0 0 3px #000' }}>
                {captionAt(shot.text, shot.duration ? (externalTime ?? time) / shot.duration : 0)}
              </div>
            )}
          </>
        ) : (
          <div className="grid size-full place-items-center text-sm text-muted-foreground">Adicione páginas à linha do tempo</div>
        )}
      </div>
      <div className={`flex items-center gap-2 text-sm ${hideControls ? "hidden" : ""}`}>
        <button className="btn" disabled={!shot} onClick={() => setPlaying(playing ? null : 'one')}>
          {playing === 'one' ? '⏸' : '▶'} Parte
        </button>
        <button
          className="btn"
          disabled={!shots.length}
          onClick={() => {
            if (playing) return setPlaying(null);
            if (selected !== 0) onSelect(0);
            setTime(0);
            setPlaying('all');
          }}
        >
          {playing === 'all' ? '⏸' : '▶'} Tudo
        </button>
        <input type="range" className="flex-1" min={0} max={shot?.duration ?? 0} step={0.01} value={time} onChange={(e) => setTime(Number(e.target.value))} />
        <span className="w-28 text-right tabular-nums text-muted-foreground">
          {fmtClock(before + time, true)} / {fmtDuration(total)}
        </span>
      </div>
    </div>
  );
}
