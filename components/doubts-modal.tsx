'use client';
// Dúvidas da IA sobre os recortes (lib/restyle.ts): até 3 opções por parte. "Seguir" aplica o que foi escolhido
// (o resto fica com o palpite da IA) e, se marcado, renderiza só o que mudou. Fechar não faz nada.
import { useEffect, useRef, useState } from 'react';
import type { Doubt, Shot, StudioProject } from '@/lib/types';
import { pageUrl } from './preview';

const picksCache = new Map<string, Record<string, number>>();
const prevCache = new Map<string, Record<string, boolean>>();
const nextCache = new Map<string, Record<string, boolean>>();

const REPEAT = 'Repetir o quadro anterior';
const NEXT = 'Usar o quadro seguinte';
const isRepeat = (o: { label: string }) => o.label === REPEAT;
const isNext = (o: { label: string }) => o.label === NEXT;
const isSpoken = (p: StudioProject, s: Shot) => p.narration === 'mic' || !!s.text.trim();
const sameImg = (a: Shot, b: Shot) => a.pageId === b.pageId && JSON.stringify(a.focus) === JSON.stringify(b.focus);

/** Toda dúvida tem a opção fixa "Repetir o quadro anterior" (a imagem da parte anterior que aparece no vídeo). */
export function withRepeat(p: StudioProject, d: Doubt): Doubt {
  const i = p.shots.findIndex((s) => s.id === d.shotId);
  let prev: Shot | undefined;
  for (let j = i - 1; j >= 0 && !prev; j--) if (isSpoken(p, p.shots[j])) prev = p.shots[j];
  let nx: Shot | undefined;
  for (let j = i + 1; j < p.shots.length && !nx; j++) if (isSpoken(p, p.shots[j])) nx = p.shots[j];
  let options = d.options.filter((o) => !isNext(o));
  if (prev) {
    const r = { label: REPEAT, pageId: prev.pageId, focus: prev.focus, ...(prev.stretch !== undefined ? { stretch: prev.stretch } : {}) };
    const k = options.findIndex((o) => isRepeat(o) || /^Repetir a imagem/.test(o.label)); // a que a IA já tinha dado vira a fixa
    options = k >= 0 ? options.map((o, j) => (j === k ? r : o)) : [...options, r];
  }
  if (nx) options = [...options, { label: NEXT, pageId: nx.pageId, focus: nx.focus, ...(nx.stretch !== undefined ? { stretch: nx.stretch } : {}) }];
  return { ...d, options };
}

/** Aplica as respostas (chosen/prevToo de cada dúvida) e devolve as partes novas; salva no projeto e anota para a IA aprender. */
export async function applyDoubts(p: StudioProject, ds: Doubt[], manual: (d: Doubt) => boolean = () => false): Promise<Shot[]> {
  const byShot = new Map(ds.map((d) => [d.shotId, d]));
  const out: Shot[] = [];
  let prevIdx = -1; // última parte COM fala já resolvida (a que "repetir o quadro anterior" copia)
  for (const [i, s] of p.shots.entries()) {
    const d = byShot.get(s.id);
    const o = d && d.chosen !== undefined ? d.options[d.chosen] : undefined;
    let next = s;
    if (d && o) {
      if (isRepeat(o)) {
        // repete a imagem final da parte anterior (já com o que você ajustou nela ou escolheu na dúvida dela)
        const prev = prevIdx >= 0 ? out[prevIdx] : undefined;
        if (prev) next = { ...s, pageId: prev.pageId, focus: prev.focus, stretch: prev.stretch, zoom: prev.zoom, rotate: prev.rotate };
      } else next = { ...s, pageId: o.pageId, focus: o.focus, stretch: o.stretch ?? s.stretch };
    }
    out.push(next);
    if (isSpoken(p, s)) prevIdx = i;
  }
  // "usar o quadro seguinte": copia a imagem final da próxima parte com fala (de trás para frente, para encadear)
  for (let i = p.shots.length - 1; i >= 0; i--) {
    const d = byShot.get(p.shots[i].id);
    const o = d && d.chosen !== undefined ? d.options[d.chosen] : undefined;
    if (!o || !isNext(o)) continue;
    let j = i + 1;
    while (j < p.shots.length && !isSpoken(p, p.shots[j])) j++;
    const nx = out[j];
    if (nx) out[i] = { ...p.shots[i], pageId: nx.pageId, focus: nx.focus, stretch: nx.stretch, zoom: nx.zoom, rotate: nx.rotate };
  }
  await fetch(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify({ shots: out, doubts: [], doubtAnswers: ds.map((d) => ({ ...d, manual: manual(d) })) }) });
  return out;
}

// "Seguir ao fim do render": guarda as respostas e só aplica quando o processo em andamento terminar
const queue = new Map<string, { ds: Doubt[]; render: boolean }>();
export function useQueuedDoubts(p: StudioProject | null, busy: boolean | undefined, onDone: (shots: Shot[], render: boolean) => void) {
  const [q, setQ] = useState<{ render: boolean } | null>(() => (p && queue.has(p.id) ? { render: queue.get(p.id)!.render } : null));
  const working = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const job = p && queue.get(p.id);
    if (!p || !q || !job || busy || working.current) return;
    working.current = true;
    applyDoubts(p, job.ds)
      .then((shots) => {
        queue.delete(p.id);
        picksCache.delete(p.id);
        prevCache.delete(p.id);
        nextCache.delete(p.id);
        setQ(null);
        done.current(shots, job.render);
      })
      .catch(() => {})
      .finally(() => (working.current = false));
  }, [q, busy, p]);
  return {
    queued: q,
    queue: (ds: Doubt[], render: boolean) => {
      if (p) queue.set(p.id, { ds, render });
      setQ({ render });
    },
    cancel: () => {
      if (p) queue.delete(p.id);
      setQ(null);
    },
  };
}

export function DoubtsModal({ p, busy, onClose, onDone, onGoTo, onQueue }: { p: StudioProject; busy?: boolean; onClose: () => void; onDone: (shots: Shot[], render: boolean) => void; onGoTo?: (part: number, linkShotId?: string) => void; onQueue?: (ds: Doubt[], render: boolean) => void }) {
  // parte sem fala não entra no vídeo final: nunca aparece aqui
  const spoken = new Set(p.shots.filter((s) => isSpoken(p, s)).map((s) => s.id));
  const doubts = (p.doubts ?? []).filter((d) => spoken.has(d.shotId)).map((d) => withRepeat(p, d));
  // escolhas ficam salvas (no projeto e aqui na memória): sair para ajustar uma parte não perde as outras
  const [pick, setPickState] = useState<Record<string, number>>(() => {
    const out: Record<string, number> = { ...(picksCache.get(p.id) ?? {}) };
    for (const d of doubts) if (d.chosen !== undefined && out[d.id] === undefined) out[d.id] = d.chosen;
    return out;
  });
  const [prevToo, setPrevTooState] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = { ...(prevCache.get(p.id) ?? {}) };
    for (const d of doubts) if (d.prevToo && out[d.id] === undefined) out[d.id] = true;
    return out;
  });
  const [nextToo, setNextTooState] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = { ...(nextCache.get(p.id) ?? {}) };
    for (const d of doubts) if (d.nextToo && out[d.id] === undefined) out[d.id] = true;
    return out;
  });
  const save = (pk: Record<string, number>, pv: Record<string, boolean>, nv: Record<string, boolean> = nextToo) => {
    picksCache.set(p.id, pk);
    prevCache.set(p.id, pv);
    nextCache.set(p.id, nv);
    fetch(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify({ doubts: doubts.map((d) => ({ ...d, chosen: pk[d.id], prevToo: pv[d.id] && pk[d.id] !== undefined && isRepeat(d.options[pk[d.id]] ?? { label: '' }) ? true : undefined, nextToo: nv[d.id] && pk[d.id] !== undefined && isNext(d.options[pk[d.id]] ?? { label: '' }) ? true : undefined })) }) }).catch(() => {});
  };
  const setPick = (fn: (x: Record<string, number>) => Record<string, number>) =>
    setPickState((cur) => {
      const next = fn(cur);
      save(next, prevToo);
      return next;
    });
  // ícone da opção "Repetir o quadro anterior": escolhe repetir e abre a parte anterior no editor, como o "Ajustar eu mesmo".
  // O que você ajustar lá vale para a parte anterior e para esta (que repete a mesma imagem).
  const prevPartOf = (d: (typeof doubts)[number]) => {
    const i = p.shots.findIndex((s) => s.id === d.shotId);
    for (let j = i - 1; j >= 0; j--) if (isSpoken(p, p.shots[j])) return j + 1;
    return 0;
  };
  const adjustPrev = (d: (typeof doubts)[number]) => {
    const k = d.options.findIndex(isRepeat);
    const nextPick = { ...pick, [d.id]: k };
    const nextPrev = { ...prevToo, [d.id]: true };
    setPickState(nextPick);
    setPrevTooState(nextPrev);
    save(nextPick, nextPrev);
    const part = prevPartOf(d);
    if (onGoTo && part) onGoTo(part, d.shotId);
  };
  const nextPartOf = (d: (typeof doubts)[number]) => {
    const i = p.shots.findIndex((s) => s.id === d.shotId);
    for (let j = i + 1; j < p.shots.length; j++) if (isSpoken(p, p.shots[j])) return j + 1;
    return 0;
  };
  const adjustNext = (d: (typeof doubts)[number]) => {
    const k = d.options.findIndex(isNext);
    const nextPick = { ...pick, [d.id]: k };
    const nv = { ...nextToo, [d.id]: true };
    setPickState(nextPick);
    setNextTooState(nv);
    save(nextPick, prevToo, nv);
    const part = nextPartOf(d);
    if (onGoTo && part) onGoTo(part, d.shotId);
  };
  const [renderAfter, setRenderAfter] = useState(true);
  const [saving, setSaving] = useState(false);
  // Ctrl + scroll sobre uma dúvida aumenta as imagens dela. Listener nativo: o onWheel do React não impede o zoom do navegador.
  const [zoom, setZoom] = useState<Record<string, number>>({});
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-doubt]')?.dataset.doubt;
      if (!id) return;
      setZoom((z) => ({ ...z, [id]: Math.min(4, Math.max(1, (z[id] ?? 1) * (e.deltaY < 0 ? 1.2 : 1 / 1.2))) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // a parte não está mais no palpite da IA (1ª opção): o usuário ajustou à mão no editor
  const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
  const mine = (d: (typeof doubts)[number]) => {
    const s = p.shots.find((x) => x.id === d.shotId);
    return !!s && !(s.pageId === d.options[0]?.pageId && same(s.focus, d.options[0].focus));
  };
  const pageById = new Map(p.pages.map((pg) => [pg.id, pg]));
  // leva a lista até uma dúvida: ao abrir vai para a primeira sem resposta; ao escolher, desce para a próxima
  const scrollToDoubt = (id: string, smooth: boolean) => {
    const c = listRef.current;
    const el = c?.querySelector(`[data-doubt="${id}"]`);
    if (!c || !el) return;
    c.scrollTo({ top: c.scrollTop + el.getBoundingClientRect().top - c.getBoundingClientRect().top - 8, behavior: smooth ? 'smooth' : 'auto' });
  };
  useEffect(() => {
    const first = doubts.find((d) => pick[d.id] === undefined && !mine(d));
    if (first) scrollToDoubt(first.id, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const choose = (d: (typeof doubts)[number], k: number) => {
    const wasOpen = pick[d.id] === undefined && !mine(d);
    setPick((x) => ({ ...x, [d.id]: k }));
    if (!wasOpen) return; // trocar uma resposta já dada não mexe na rolagem
    const open = (x: (typeof doubts)[number]) => x.id !== d.id && pick[x.id] === undefined && !mine(x);
    const next = doubts.slice(doubts.indexOf(d) + 1).find(open) ?? doubts.find(open);
    if (next) scrollToDoubt(next.id, true);
  };
  const answers = () => doubts.map((d) => ({ ...d, chosen: pick[d.id], prevToo: prevToo[d.id] && pick[d.id] !== undefined && isRepeat(d.options[pick[d.id]]) ? true : undefined, nextToo: nextToo[d.id] && pick[d.id] !== undefined && isNext(d.options[pick[d.id]]) ? true : undefined }));
  const follow = async () => {
    setSaving(true);
    const shots = await applyDoubts(p, answers(), (d) => pick[d.id] === undefined && mine(d));
    setSaving(false);
    picksCache.delete(p.id);
    prevCache.delete(p.id);
    nextCache.delete(p.id);
    onDone(shots, renderAfter);
  };
  const followAfterRender = () => {
    onQueue?.(answers(), renderAfter);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-[1075px] flex-col rounded-lg border bg-background text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b p-3">
          <p className="flex-1 font-semibold">❓ Dúvidas da IA nos recortes ({doubts.length})</p>
          <button className="btn px-2 py-0.5" onClick={onClose} title="Fechar sem fazer nada (dá para responder depois)">
            ✕
          </button>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
          <p className="text-xs text-muted-foreground">A IA já aplicou o melhor palpite dela (⭐). Escolha a opção certa onde ela errou; o que você não escolher fica como está. Ctrl + scroll sobre uma dúvida aumenta as imagens.</p>
          {doubts.map((d) => (
            <div key={d.id} data-doubt={d.id} className={`relative space-y-2 rounded border p-2 ${pick[d.id] !== undefined || mine(d) ? 'border-green-500' : ''}`}>
              {(pick[d.id] !== undefined || mine(d)) && (
                <span className="absolute right-2 top-2 rounded bg-green-600 px-2 py-0.5 text-xs font-semibold text-white">✔ {pick[d.id] !== undefined ? 'Escolhido' : 'Ajustado por você'}</span>
              )}
              <p className="pr-40 text-xs">
                <b>Parte {d.part}</b> · <span className="italic">“{d.text}”</span>
              </p>
              {(() => {
                const o0 = d.options[0];
                const pg0 = o0 && pageById.get(o0.pageId);
                return pg0 ? (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">⭐ Palpite da IA no contexto (contorno tracejado = o que ela pegou; 25% a mais acima e abaixo):</p>
                    <ContextThumb src={pageUrl(p.id, pg0)} page={pg0} focus={o0.focus} scale={zoom[d.id]} />
                  </div>
                ) : null;
              })()}
              <p className="text-amber-300">{d.question}</p>
              <div className="flex flex-wrap gap-2">
                {d.options.map((o, k) => {
                  const pg = pageById.get(o.pageId);
                  const rep = isRepeat(o);
                  const nxt = isNext(o);
                  const hand = rep || nxt;
                  const handOn = rep ? prevToo[d.id] : nextToo[d.id];
                  const handPart = rep ? prevPartOf(d) : nextPartOf(d);
                  const on = pick[d.id] === k;
                  return (
                    <div key={k} role="button" tabIndex={0} className={`relative cursor-pointer space-y-1 rounded border-2 p-1 text-left text-xs ${on ? 'border-green-500 bg-green-500/10' : 'border-transparent hover:border-muted-foreground'}`} onClick={() => choose(d, k)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && choose(d, k)}>
                      {on && <span className={`absolute top-1 z-10 flex size-6 items-center justify-center rounded-full bg-green-600 text-sm font-bold text-white ${hand ? 'right-9' : 'right-1'}`}>✔</span>}
                      {hand && (onGoTo || handPart > 0) && (
                        onGoTo ? (
                          <button
                            type="button"
                            title={rep ? 'Ajustar a cena anterior eu mesmo: abre a parte anterior no editor; o que eu ajustar vale para ela e para esta parte' : 'Ajustar a cena seguinte eu mesmo: abre a parte seguinte no editor; o que eu ajustar vale para ela e para esta parte'}
                            className={`absolute right-1 top-1 z-10 flex size-6 items-center justify-center rounded-full border text-sm ${handOn ? 'border-amber-400 bg-amber-500 text-black' : 'border-muted-foreground bg-black/70 text-white hover:bg-black'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              (rep ? adjustPrev : adjustNext)(d);
                            }}
                          >
                            ✋
                          </button>
                        ) : (
                          <a title="Ajustar a cena anterior eu mesmo (abre o editor)" href={`/p/${p.id}/editor`} className="absolute right-1 top-1 z-10 flex size-6 items-center justify-center rounded-full border border-muted-foreground bg-black/70 text-sm text-white hover:bg-black" onClick={(e) => e.stopPropagation()}>
                            ✋
                          </a>
                        )
                      )}
                      {pg && <CropThumb src={pageUrl(p.id, pg)} page={pg} focus={o.focus} scale={zoom[d.id]} />}
                      <span className="block">
                        {k === 0 ? '⭐ ' : ''}
                        {o.label}
                      </span>
                    </div>
                  );
                })}
                {onGoTo ? (
                  <button className="btn self-center text-xs" onClick={() => onGoTo(d.part)}>
                    ✋ Ajustar eu mesmo
                  </button>
                ) : (
                  <a className="btn self-center text-xs" href={`/p/${p.id}/editor`}>
                    ✋ Ajustar eu mesmo (editor)
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t p-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={renderAfter} onChange={(e) => setRenderAfter(e.target.checked)} /> renderizar depois (só as partes que mudaram)
          </label>
          <span className="flex-1 text-muted-foreground">{Object.keys(pick).length} escolhida(s) · {doubts.filter((d) => pick[d.id] === undefined && mine(d)).length} ajustada(s) por você</span>
          {onQueue && (
            <button className="btn" disabled={!busy || saving} onClick={followAfterRender} title={busy ? 'Fecha o modal e aplica as escolhas (e renderiza só o que mudou) quando o processo em andamento terminar' : 'Só serve enquanto tem um processo rodando; agora use "Seguir"'}>
              Seguir ao fim do render
            </button>
          )}
          <button className="btn-primary" disabled={busy || saving} onClick={follow}>
            Seguir
          </button>
        </div>
      </div>
    </div>
  );
}

/** Miniatura de um recorte da página (posiciona a página inteira atrás de uma janela). */
/** Mostra o recorte do palpite da IA com 25% a mais para cima e para baixo (até a borda da página), com o recorte contornado. */
function ContextThumb({ src, page, focus, scale = 1 }: { src: string; page: { width: number; height: number }; focus: { x0: number; y0: number; x1: number; y1: number }; scale?: number }) {
  const fh = Math.max(0.01, focus.y1 - focus.y0);
  const y0 = Math.max(0, focus.y0 - fh * 0.25), y1 = Math.min(1, focus.y1 + fh * 0.25);
  const x0 = Math.max(0, focus.x0), x1 = Math.min(1, focus.x1), fw = Math.max(0.01, x1 - x0);
  const ar = (fw * page.width) / ((y1 - y0) * page.height);
  const W = Math.min(990, Math.min(260, 150 * ar) * scale);
  const iw = W / fw, ih = (iw * page.height) / page.width, H = W / ar;
  return (
    <div className="relative overflow-hidden rounded bg-black" style={{ width: W, height: H }}>
      <img src={src} alt="" loading="lazy" className="absolute max-w-none" style={{ width: iw, height: ih, left: -x0 * iw, top: -y0 * ih }} />
      <div className="pointer-events-none absolute border-2 border-dashed border-amber-400" style={{ left: 0, width: '100%', top: ((focus.y0 - y0) / (y1 - y0)) * H, height: (fh / (y1 - y0)) * H }} />
    </div>
  );
}

export function CropThumb({ src, page, focus, scale = 1 }: { src: string; page: { width: number; height: number }; focus: { x0: number; y0: number; x1: number; y1: number }; scale?: number }) {
  const fw = Math.max(0.01, focus.x1 - focus.x0), fh = Math.max(0.01, focus.y1 - focus.y0);
  const ar = (fw * page.width) / (fh * page.height);
  const base = Math.min(260, 150 * ar);
  const W = Math.min(990, base * scale); // não passa da largura do modal
  const iw = W / fw, ih = (iw * page.height) / page.width;
  return (
    <div className="relative overflow-hidden rounded bg-black" style={{ width: W, height: W / ar }}>
      <img src={src} alt="" loading="lazy" className="absolute max-w-none" style={{ width: iw, height: ih, left: -focus.x0 * iw, top: -focus.y0 * ih }} />
    </div>
  );
}
