'use client';
// Shorts (página de Publicação, embaixo): botão que cria os vídeos curtos verticais com os melhores momentos e a
// lista deles. Cada short abre um modal para ajustar o corte (começo/fim, tirar partes, cortar segundos) vendo a
// prévia ao vivo, editar a legenda do YouTube daquele trecho (título, descrição, tags) e renderizar só ele.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JobInfo, PlanItem, Rect, ShortInfo, StudioProject } from '@/lib/types';
import { FocusEditor } from './focus-editor';
import { PaidAsk } from './paid-ask';
import { Spinner } from './publish-panel';
import { Preview, pageUrl } from './preview';
import { renderUpToDate, shortRange, shotDurations } from '@/lib/sig';
import { tc } from '@/lib/youtube';
import { toVertical } from '@/lib/vertical';
import { MANGA_SIZES } from '@clipper/shared';
const VERT = MANGA_SIZES.vertical.w / MANGA_SIZES.vertical.h;

const fileUrl = (projectId: string, f: string, v: string) => `/api/file?project=${projectId}&f=${encodeURIComponent(f)}&v=${encodeURIComponent(v)}`;
const MAX_SHORT = 180; // o YouTube aceita shorts de até 3 minutos
/** "1:05,3" — tempo do short com décimos, para os cortes em segundos. */
const tcd = (x: number) => `${tc(x)},${Math.floor((Math.max(0, x) % 1) * 10)}`;
/** "1:05", "65", "65,5" ou "1:05.5" → segundos. */
const parseSec = (v: string) => {
  const t = v.trim().replace(',', '.');
  if (!t) return NaN;
  if (t.includes(':')) {
    const [m, s] = t.split(':');
    return Number(m) * 60 + Number(s);
  }
  return Number(t);
};

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="btn px-2 py-0.5 text-xs"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        });
      }}
    >
      {ok ? '✔ Copiado' : `📋 ${label}`}
    </button>
  );
}

/** Descrição do short como vai para o YouTube: o texto + o link do vídeo completo (se houver). */
export const shortDescription = (desc: string, url?: string) => (url?.trim() ? `${desc.trim()}\n\n▶ Assista ao vídeo completo: ${url.trim()}` : desc.trim());

type Cut = { from: number; to: number; skip: string[]; cuts: [number, number][]; frames: Record<string, Rect> };
const SPEEDS = [1, 1.5, 2, 3, 4];

/**
 * Modal de um short. Em cima, a prévia ao vivo (tocada do vídeo principal já renderizado, numa tela em pé) com a
 * barra de tempo DO SHORT; embaixo, o corte: começo/fim, mover, tirar partes e cortar pedaços em segundos; e a
 * legenda do YouTube do trecho. Ctrl+Z / Ctrl+Y desfazem e refazem o corte.
 */
function ShortEditor({
  p,
  short,
  busy,
  fresh,
  onClose,
  onRender,
  onSaved,
}: {
  p: StudioProject;
  short: ShortInfo;
  busy: boolean;
  fresh: boolean;
  onClose: () => void;
  onRender: (c: Cut) => void;
  onSaved: () => void;
}) {
  const dur = useMemo(() => shotDurations(p), [p]);
  // onde cada parte começa no vídeo principal (tempos reais do render quando existem)
  const starts = useMemo(() => {
    const seg = new Map((p.lastRender?.segments ?? []).map((g) => [g.id, g]));
    let t = 0;
    return p.shots.map((s, i) => {
      const st = seg.get(s.id)?.start ?? t;
      t = st + dur[i];
      return st;
    });
  }, [p, dur]);
  const [init] = useState<Cut>(() => {
    const [a, b] = shortRange(p.shots, short);
    return { from: a, to: b, skip: short.skip ?? [], cuts: short.cuts ?? [], frames: short.frames ?? {} };
  });
  const [cut, setCut] = useState<Cut>(init);
  const [past, setPast] = useState<Cut[]>([]);
  const [future, setFuture] = useState<Cut[]>([]);
  const { from, to } = cut;
  const n = p.shots.length - 1;
  const skip = useMemo(() => new Set(cut.skip), [cut.skip]);
  const inRange = Array.from({ length: to - from + 1 }, (_, k) => from + k);
  const kept = inRange.filter((i) => !skip.has(p.shots[i].id));
  const skipped = inRange.filter((i) => skip.has(p.shots[i].id));
  // tempo do short (depois de tirar as partes) ↔ tempo no vídeo principal
  const relStart = new Map<number, number>();
  let acc = 0;
  for (const i of kept) {
    relStart.set(i, acc);
    acc += dur[i];
  }
  const keptLen = acc; // antes dos cortes em segundos
  const cutsLen = cut.cuts.reduce((x, [a, b]) => x + Math.max(0, Math.min(b, keptLen) - a), 0);
  const total = keptLen - cutsLen; // duração final do short
  const relOf = (abs: number) => {
    for (const i of kept) if (abs >= starts[i] && abs < starts[i] + dur[i]) return relStart.get(i)! + (abs - starts[i]);
    return null; // fora do short (ou numa parte tirada)
  };
  const absOf = (rel: number) => {
    for (const i of kept) if (rel < relStart.get(i)! + dur[i]) return starts[i] + Math.max(0, rel - relStart.get(i)!);
    const last = kept[kept.length - 1];
    return last === undefined ? 0 : starts[last] + dur[last] - 0.05;
  };
  // tempo "final" (o que se vê no short depois dos cortes) ↔ tempo do short antes dos cortes
  const finalOf = (rel: number) => rel - cut.cuts.reduce((x, [a, b]) => x + Math.max(0, Math.min(b, rel) - a), 0);
  const relOfFinal = (f: number) => {
    let r = f;
    for (const [a, b] of [...cut.cuts].sort((x, y) => x[0] - y[0])) if (r >= a) r += b - a;
    return Math.min(r, keptLen - 0.05);
  };

  const vref = useRef<HTMLVideoElement>(null);
  const [rel, setRel] = useState(0); // posição atual no short (antes dos cortes)
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  useEffect(() => {
    if (vref.current) vref.current.playbackRate = rate;
  }, [rate]);
  const seekRel = (r: number) => {
    r = Math.min(Math.max(0, r), Math.max(0, keptLen - 0.05));
    for (const [a, b] of cut.cuts) if (r >= a && r < b) r = b; // não para dentro de um corte
    if (vref.current) vref.current.currentTime = absOf(r);
    setRel(r);
  };
  const seekFinal = (f: number) => seekRel(relOfFinal(f));
  // corte mudou: se a posição saiu do short, volta para o começo
  useEffect(() => {
    if (rel > keptLen) seekRel(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptLen]);
  useEffect(() => {
    seekRel(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);
  const play = () => {
    const v = vref.current;
    if (!v) return;
    if (!v.paused) return v.pause();
    if (rel >= keptLen - 0.15) seekRel(0);
    v.play().catch(() => {});
  };
  const cur = kept.find((i) => rel >= relStart.get(i)! && rel < relStart.get(i)! + dur[i]) ?? kept[0] ?? from;

  const apply = (next: Cut) => {
    setPast((h) => [...h.slice(-99), cut]);
    setFuture([]);
    setCut(next);
  };
  const setRange = (x: number, y: number) => {
    x = Math.max(0, Math.min(n, x));
    y = Math.max(x, Math.min(n, y));
    if (x === from && y === to) return;
    apply({ ...cut, from: x, to: y, cuts: [] }); // os segundos cortados valiam para o trecho antigo
  };
  // tira/devolve uma parte do short (só do short; o vídeo principal não muda)
  const toggleSkip = (i: number) => {
    const id = p.shots[i].id;
    const next = skip.has(id) ? cut.skip.filter((x) => x !== id) : [...cut.skip, id];
    if (inRange.every((k) => next.includes(p.shots[k].id))) return; // não deixa o short vazio
    apply({ ...cut, skip: next, cuts: [] });
  };
  const undo = () => {
    const last = past[past.length - 1];
    if (!last) return;
    setPast(past.slice(0, -1));
    setFuture((f) => [cut, ...f]);
    setCut(last);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture(future.slice(1));
    setPast((h) => [...h, cut]);
    setCut(next);
  };

  // cortar pedaços em segundos (no tempo final do short, o que aparece na barra)
  const [cutA, setCutA] = useState('');
  const [cutB, setCutB] = useState('');
  const [cutErr, setCutErr] = useState('');
  const addCut = () => {
    const fa = parseSec(cutA), fb = parseSec(cutB);
    if (!Number.isFinite(fa) || !Number.isFinite(fb) || Math.abs(fb - fa) < 0.1) return setCutErr('Coloque o início e o fim do pedaço (ex.: 1 e 2, ou 0:05 e 0:08).');
    const [x, y] = [Math.min(fa, fb), Math.min(Math.max(fa, fb), total)];
    if (x >= total) return setCutErr(`O short tem ${tcd(total)}: o pedaço começa depois do fim.`);
    if (y - x >= total - 1) return setCutErr('Esse corte apagaria o short inteiro.');
    setCutErr('');
    const ra = relOfFinal(x), rb = relOfFinal(y);
    const all = [...cut.cuts, [ra, rb] as [number, number]].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of all) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    apply({ ...cut, cuts: merged });
    setCutA('');
    setCutB('');
    seekRel(Math.max(0, ra - 1.5)); // volta um pouco antes para ouvir como ficou
  };

  // atalhos: Ctrl+Z desfaz, Ctrl+Y / Ctrl+Shift+Z refaz, espaço toca/pausa, Esc fecha
  const keys = useRef({ undo, redo, play, onClose });
  keys.current = { undo, redo, play, onClose };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !typing && e.key.toLowerCase() === 'z' && !e.shiftKey) keys.current.undo();
      else if (ctrl && !typing && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) keys.current.redo();
      else if (e.key === ' ' && !typing) keys.current.play();
      else if (e.key === 'Escape') keys.current.onClose();
      else return;
      e.preventDefault();
      e.stopPropagation(); // não deixa o atalho agir na página por baixo
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  // legenda do YouTube deste short
  const [title, setTitle] = useState(short.title);
  const [desc, setDesc] = useState(short.description);
  const [tags, setTags] = useState(short.tags.join(', '));
  const [capBusy, setCapBusy] = useState<'' | 'save' | 'ai'>('');
  const [capMsg, setCapMsg] = useState('');
  const capChanged = title !== short.title || desc !== short.description || tags !== short.tags.join(', ');
  const saveCaption = async () => {
    setCapBusy('save');
    const r = await fetch(`/api/projects/${p.id}/shorts`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ short: short.id, title, description: desc, tags }) });
    setCapBusy('');
    setCapMsg(r.ok ? '✔ Legenda salva' : await r.text());
    if (r.ok) onSaved();
  };
  const aiCaption = async () => {
    setCapBusy('ai');
    setCapMsg('A IA está escrevendo a legenda deste trecho…');
    const r = await fetch(`/api/projects/${p.id}/shorts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ short: short.id, from, to, skip: skipped.map((i) => p.shots[i].id) }) });
    setCapBusy('');
    if (!r.ok) return setCapMsg(await r.text());
    const c = (await r.json()) as { title: string; description: string; tags: string[] };
    setTitle(c.title);
    setDesc(c.description);
    setTags(c.tags.join(', '));
    setCapMsg('✔ Legenda nova gerada e salva');
    onSaved();
  };

  // enquadramento: qual parte está sendo enquadrada e o recorte dela no short (o escolhido ou o do vídeo principal)
  const [framing, setFraming] = useState<number | null>(null);
  const frameOf = (i: number): Rect => cut.frames[p.shots[i].id] ?? p.shots[i].focus;
  // arrastar o recorte gera muitos passos: junta num só passo do Ctrl+Z (um por arrasto)
  const lastFrameAt = useRef(0);
  const setFrame = (i: number, r: Rect | null) => {
    const frames = { ...cut.frames };
    if (r) frames[p.shots[i].id] = r;
    else delete frames[p.shots[i].id];
    const now = Date.now();
    if (now - lastFrameAt.current < 700) setCut({ ...cut, frames });
    else apply({ ...cut, frames });
    lastFrameAt.current = now;
  };
  const changed = JSON.stringify(cut) !== JSON.stringify(init);
  // as partes do short como o render vai desenhar (tela em pé, enquadramento do short), com a duração real
  const vertShots = kept.map((i) => ({ ...toVertical(p.shots[i], p.pages, VERT, cut.frames[p.shots[i].id]), duration: dur[i] }));
  const rows = Array.from({ length: Math.min(n, to + 4) - Math.max(0, from - 4) + 1 }, (_, k) => Math.max(0, from - 4) + k);
  const fNow = finalOf(rel);
  const step = (label: string, fn: () => void, title: string) => (
    <button className="btn px-2 py-0.5 text-xs" onClick={fn} title={title}>
      {label}
    </button>
  );
  const ctl = (label: string, fn: () => void, title: string) => (
    <button className="btn px-2 py-1 text-sm" onClick={fn} title={title}>
      {label}
    </button>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="flex h-[94vh] w-full max-w-[1400px] flex-col gap-3 overflow-hidden rounded-lg border bg-background p-4 text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium">✂ Editar short: {short.title}</p>
            <p className="text-xs text-muted-foreground">Ajuste o corte embaixo; a prévia muda na hora. Ctrl+Z desfaz, Ctrl+Y refaz, espaço toca, Esc fecha.</p>
          </div>
          <button className="btn px-2 py-0.5 text-xs" disabled={!past.length} onClick={undo} title="Desfazer (Ctrl+Z)">
            ↶ Desfazer
          </button>
          <button className="btn px-2 py-0.5 text-xs" disabled={!future.length} onClick={redo} title="Refazer (Ctrl+Y)">
            ↷ Refazer
          </button>
          <button className="rounded-full px-2 text-lg text-muted-foreground hover:bg-muted" onClick={onClose} title="Fechar (Esc)">
            ✕
          </button>
        </div>

        {/* duas colunas: a prévia do short fica fixa à esquerda; a edição rola à direita */}
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[380px_1fr]">
        <div className="flex min-h-0 flex-col items-center gap-2 overflow-y-auto">
          <div className="relative aspect-[9/16] w-full max-w-[300px] shrink-0 overflow-hidden rounded bg-black">
            {p.lastRender && (
              <video
                ref={vref}
                hidden
                src={`/api/file?project=${p.id}&video=1&v=${encodeURIComponent(p.lastRender.at)}`}
                preload="auto"
                onLoadedMetadata={(e) => {
                  e.currentTarget.currentTime = absOf(0);
                  e.currentTarget.playbackRate = rate;
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onClick={play}
                onTimeUpdate={(e) => {
                  const v = e.currentTarget;
                  let r = relOf(v.currentTime);
                  if (r === null) {
                    // entrou numa parte tirada (ou passou do fim): pula para a próxima parte do short
                    const nextPart = kept.find((i) => starts[i] > v.currentTime - 0.05);
                    if (nextPart === undefined || v.currentTime >= absOf(keptLen)) {
                      v.pause();
                      v.currentTime = absOf(Math.max(0, keptLen - 0.05));
                      return setRel(Math.max(0, keptLen - 0.05));
                    }
                    v.currentTime = starts[nextPart];
                    r = relStart.get(nextPart)!;
                  }
                  const inCut = cut.cuts.find(([a, b]) => r! >= a && r! < b);
                  if (inCut) {
                    v.currentTime = absOf(inCut[1]);
                    r = inCut[1];
                  }
                  if (r >= keptLen - 0.05) v.pause();
                  setRel(r);
                }}
              />
            )}
            {/* o short de verdade: tela em pé, cada parte com o enquadramento e o ajuste do render */}
            {kept.length > 0 && (
              <div className="absolute inset-0">
                <Preview
                  projectId={p.id}
                  format="vertical"
                  shots={vertShots}
                  pages={p.pages}
                  selected={Math.max(0, kept.indexOf(cur))}
                  onSelect={() => {}}
                  subtitles={!!p.subtitles}
                  externalTime={Math.max(0, rel - (relStart.get(cur) ?? 0))}
                  hideControls
                />
              </div>
            )}
            <button className="absolute inset-0 z-10" onClick={play} aria-label={playing ? 'Pausar' : 'Tocar'} />
            <span className="absolute left-1 top-1 z-20 rounded bg-black/70 px-1 text-[10px]">prévia do short · parte {cur + 1}</span>
          </div>
          <div className="w-full max-w-md space-y-1">
            <input type="range" className="w-full accent-green-500" min={0} max={Math.max(0.1, total)} step={0.1} value={Math.min(total, Math.max(0, fNow))} onChange={(e) => seekFinal(Number(e.target.value))} aria-label="Posição no short" />
            <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
              <span>{tcd(fNow)}</span>
              <span>parte {cur + 1}</span>
              <span>{tcd(total)}</span>
            </div>
          </div>
          <div className="flex flex-wrap justify-center gap-1">
            {ctl('⏮ Início', () => seekRel(0), 'Volta para o começo do short')}
            {ctl('⏪ 5 s', () => seekFinal(fNow - 5), 'Volta 5 segundos')}
            <button className="btn-primary px-3 py-1 text-sm" onClick={play}>
              {playing ? '⏸ Pausar' : '▶ Tocar'}
            </button>
            {ctl('5 s ⏩', () => seekFinal(fNow + 5), 'Avança 5 segundos')}
            {ctl('Fim ⏭', () => seekFinal(total - 3), 'Vai para os 3 últimos segundos')}
          </div>
          <div className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">Velocidade da prévia:</span>
            {SPEEDS.map((v) => (
              <button key={v} className={`rounded border px-2 py-0.5 ${rate === v ? 'border-primary bg-primary/30' : 'hover:bg-muted'}`} onClick={() => setRate(v)} title="Só para assistir; o short não muda">
                {String(v).replace('.', ',')}x
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">Prévia igual ao short final: tela em pé, enquadramento de cada parte, partes tiradas e pedaços cortados.</p>
        </div>

        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
        {/* corte: começo, fim, mover */}
        <div className="grid grid-cols-[90px_1fr] items-center gap-x-2 gap-y-1.5 rounded border p-2 text-xs">
          <span className="text-muted-foreground">Começo</span>
          <div className="flex flex-wrap gap-1">
            {step('◀ mais cedo', () => setRange(from - 1, to), 'Começa uma parte antes')}
            {step('mais tarde ▶', () => setRange(Math.min(from + 1, to), to), 'Começa uma parte depois')}
            <span className="self-center text-muted-foreground">
              parte {from + 1} · {tc(starts[from] ?? 0)} do vídeo
            </span>
          </div>
          <span className="text-muted-foreground">Fim</span>
          <div className="flex flex-wrap gap-1">
            {step('◀ mais cedo', () => setRange(from, Math.max(from, to - 1)), 'Termina uma parte antes')}
            {step('mais tarde ▶', () => setRange(from, to + 1), 'Termina uma parte depois')}
            <span className="self-center text-muted-foreground">
              parte {to + 1} · {tc((starts[to] ?? 0) + (dur[to] ?? 0))} do vídeo
            </span>
          </div>
          <span className="text-muted-foreground">Mover tudo</span>
          <div className="flex flex-wrap gap-1">
            {step('◀ para trás', () => from > 0 && setRange(from - 1, to - 1), 'O corte inteiro uma parte antes')}
            {step('para frente ▶', () => to < n && setRange(from + 1, to + 1), 'O corte inteiro uma parte depois')}
            {changed && step('↺ voltar ao original', () => apply(init), 'Volta para o corte de quando abriu')}
          </div>
        </div>

        {/* cortar pedaços em segundos */}
        <div className="space-y-1.5 rounded border p-2 text-xs">
          <p className="font-medium">
            ✂ Cortar um pedaço em segundos <span className="font-normal text-muted-foreground">— ex.: do segundo 1 ao 2, ou do 5 ao 8 (tempos da barra do short)</span>
          </p>
          <div className="flex flex-wrap items-center gap-1">
            de
            <input className="field px-1 py-0.5 text-xs" style={{ width: 80 }} value={cutA} onChange={(e) => setCutA(e.target.value)} placeholder="ex.: 1" onKeyDown={(e) => e.key === 'Enter' && addCut()} />
            <button className="btn px-1.5 py-0.5 text-xs" onClick={() => setCutA(fNow.toFixed(1).replace('.', ','))} title="Usa a posição atual da prévia">
              ⇤ posição atual
            </button>
            até
            <input className="field px-1 py-0.5 text-xs" style={{ width: 80 }} value={cutB} onChange={(e) => setCutB(e.target.value)} placeholder="ex.: 2" onKeyDown={(e) => e.key === 'Enter' && addCut()} />
            <button className="btn px-1.5 py-0.5 text-xs" onClick={() => setCutB(fNow.toFixed(1).replace('.', ','))} title="Usa a posição atual da prévia">
              posição atual ⇥
            </button>
            <button className="btn-primary px-2 py-0.5 text-xs" onClick={addCut}>
              ✂ Cortar e apagar
            </button>
          </div>
          {cutErr && <p className="text-destructive">{cutErr}</p>}
          {!!cut.cuts.length && (
            <div className="flex flex-wrap gap-1">
              {cut.cuts.map(([a, b], k) => (
                <span key={k} className="flex items-center gap-1 rounded border border-destructive/50 bg-destructive/10 px-1.5 py-0.5">
                  apagado em {tcd(finalOf(a))} ({(b - a).toFixed(1).replace('.', ',')} s)
                  <button className="text-destructive hover:text-white" title="Devolver este pedaço" onClick={() => apply({ ...cut, cuts: cut.cuts.filter((_, j) => j !== k) })}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <p className={`text-xs ${total > MAX_SHORT ? 'text-destructive' : total > 60 ? 'text-amber-300' : 'text-green-500'}`}>
          Duração final: {tcd(total)} · {kept.length} parte(s)
          {skipped.length > 0 && ` · ${skipped.length} parte(s) tirada(s)`}
          {cut.cuts.length > 0 && ` · ${cut.cuts.length} pedaço(s) cortado(s)`}
          {total > MAX_SHORT ? ' · passa de 3 min: o YouTube não aceita como short' : total > 60 ? ' · mais de 60 s (o YouTube aceita até 3 min)' : ''}
        </p>

        {/* enquadramento da parte escolhida */}
        {framing !== null && framing >= from && framing <= to && (() => {
          const shot = p.shots[framing];
          const pg = p.pages.find((x) => x.id === shot.pageId);
          if (!pg) return null;
          const vshot = toVertical(shot, p.pages, VERT, frameOf(framing));
          return (
            <div className="space-y-2 rounded border border-primary/60 p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <p className="flex-1 font-medium">🖼 Enquadramento da parte {framing + 1} no short</p>
                {cut.frames[shot.id] && (
                  <button className="btn px-2 py-0.5 text-xs" onClick={() => setFrame(framing, null)} title="Volta para o recorte do vídeo principal">
                    ↺ Usar o do vídeo principal
                  </button>
                )}
                <button className="btn px-2 py-0.5 text-xs" onClick={() => setFrame(framing, { x0: 0, y0: 0, x1: 1, y1: 1 })}>
                  Página inteira
                </button>
                <button className="btn-primary px-2 py-0.5 text-xs" onClick={() => setFraming(null)}>
                  ✔ Pronto
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
                <div className="max-h-[60vh] overflow-y-auto">
                  <FocusEditor src={pageUrl(p.id, pg)} width={pg.width} height={pg.height} focus={frameOf(framing)} onChange={(r) => setFrame(framing, r)} />
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Como fica no short:</p>
                  <div className="w-[180px] overflow-hidden rounded bg-black">
                    <Preview projectId={p.id} format="vertical" shots={[vshot]} pages={p.pages} selected={0} onSelect={() => {}} subtitles={false} />
                  </div>
                  <p className="text-[11px] text-muted-foreground">Arraste na página para escolher o que aparece na tela em pé; puxe as alças para ajustar.</p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* partes do short */}
        <p className="text-xs font-medium">
          Partes do short <span className="font-normal text-muted-foreground">— 🗑 Tirar apaga uma parte inteira do short (começo, meio ou fim) sem mexer no vídeo principal</span>
        </p>
        <ol className="shrink-0 space-y-1 rounded border p-1 text-sm">
          {rows.map((i) => {
            const inside = i >= from && i <= to;
            const off = inside && skip.has(p.shots[i].id);
            return (
              <li
                key={p.shots[i].id}
                className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 ${off ? 'bg-destructive/15 opacity-60' : i === cur && inside ? 'bg-green-600/30 ring-1 ring-green-500' : inside ? 'bg-primary/20' : 'opacity-50'}`}
                onClick={() => inside && !off && seekRel(relStart.get(i) ?? 0)}
                title={off ? 'Tirada do short' : inside ? 'Ir até esta parte na prévia' : 'Fora do short'}
              >
                <span className="w-20 shrink-0 tabular-nums text-xs text-muted-foreground">
                  {i === cur && inside && !off ? '▶ ' : ''}
                  {i + 1} · {dur[i].toFixed(1)}s
                </span>
                <span className={`min-w-0 flex-1 ${off ? 'line-through' : ''}`}>{p.shots[i].text || <i className="text-muted-foreground">(sem fala)</i>}</span>
                <span className="flex shrink-0 gap-1 text-xs" onClick={(e) => e.stopPropagation()}>
                  {inside && (
                    <button className={`rounded border px-1.5 ${off ? 'border-green-600 text-green-500 hover:bg-green-600/20' : 'border-destructive/60 text-destructive hover:bg-destructive/20'}`} onClick={() => toggleSkip(i)} title={off ? 'Devolver esta parte ao short' : 'Tirar esta parte do short'}>
                      {off ? '↺ Devolver' : '🗑 Tirar'}
                    </button>
                  )}
                  {inside && !off && (
                    <button className={`rounded border px-1.5 ${framing === i ? 'border-primary bg-primary/30' : cut.frames[p.shots[i].id] ? 'border-sky-500 text-sky-400' : 'hover:bg-muted'}`} onClick={() => setFraming(framing === i ? null : i)} title="Escolher o que aparece na tela em pé nesta parte">
                      🖼 Enquadrar{cut.frames[p.shots[i].id] ? ' ✔' : ''}
                    </button>
                  )}
                  <button className="rounded border px-1 hover:bg-muted" onClick={() => setRange(i, Math.max(i, to))} title="O short começa nesta parte">
                    começar aqui
                  </button>
                  <button className="rounded border px-1 hover:bg-muted" onClick={() => setRange(Math.min(from, i), i)} title="O short termina nesta parte">
                    terminar aqui
                  </button>
                </span>
              </li>
            );
          })}
        </ol>

        {/* legenda do YouTube deste short */}
        <div className="space-y-1.5 rounded border p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 font-medium">📝 Legenda do YouTube deste short (título, descrição e tags)</p>
            <button className="btn px-2 py-0.5 text-xs" disabled={!!capBusy} onClick={aiCaption} title="A IA escreve de novo a partir das falas do trecho atual">
              {capBusy === 'ai' ? 'Gerando…' : '✨ Gerar de novo para este trecho'}
            </button>
          </div>
          <label className="block space-y-0.5">
            <span className="flex items-center gap-2 text-muted-foreground">
              Título <CopyBtn text={title} label="Copiar" />
            </span>
            <input className="field w-full px-2 py-1 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block space-y-0.5">
            <span className="flex items-center gap-2 text-muted-foreground">
              Descrição <CopyBtn text={shortDescription(desc, p.fullVideoUrl)} label="Copiar" />
            </span>
            <textarea className="field h-24 w-full px-2 py-1 text-sm" value={desc} onChange={(e) => setDesc(e.target.value)} />
            {p.fullVideoUrl?.trim() ? (
              <p className="text-[11px] text-muted-foreground">No fim entra: ▶ Assista ao vídeo completo: {p.fullVideoUrl.trim()}</p>
            ) : (
              <p className="text-[11px] text-amber-300">Sem link do vídeo completo: coloque no campo ao lado de “Quantos”, na lista de shorts.</p>
            )}
          </label>
          <label className="block space-y-0.5">
            <span className="flex items-center gap-2 text-muted-foreground">
              Tags (separadas por vírgula) <CopyBtn text={tags} label="Copiar" />
            </span>
            <input className="field w-full px-2 py-1 text-sm" value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary px-2 py-0.5 text-xs" disabled={!capChanged || !!capBusy} onClick={saveCaption}>
              💾 Salvar legenda
            </button>
            <CopyBtn text={`${title}\n\n${shortDescription(desc, p.fullVideoUrl)}\n\n${tags}`} label="Copiar tudo" />
            {capMsg && <span className="text-muted-foreground">{capMsg}</span>}
          </div>
        </div>
        </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-2">
          {!fresh && <span className="mr-auto text-xs text-amber-300">⚠ Renderize o vídeo principal com as suas edições antes.</span>}
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
          <button className="btn-primary" disabled={busy || !fresh || total > MAX_SHORT} onClick={() => onRender(cut)}>
            🎬 Renderizar este short
          </button>
        </div>
      </div>
    </div>
  );
}

export function ShortsPanel({
  p,
  jobs,
  busy,
  onStart,
  onApprove,
  onRenderOne,
  onGoTo,
  onSaved,
}: {
  p: StudioProject;
  jobs: JobInfo[];
  busy: boolean;
  onStart: (count: number, pauseForNarration: boolean) => void;
  onApprove: (plan: PlanItem[]) => void;
  onRenderOne: (shortId: string, from: number, to: number, skip: string[], cuts: [number, number][], frames: Record<string, Rect>) => void;
  onGoTo: (i: number) => void;
  onSaved: () => void;
}) {
  const [count, setCount] = useState(5);
  const [pause, setPause] = useState(false);
  useEffect(() => {
    try {
      setPause(localStorage.getItem('shorts-pause') === '1');
    } catch {
      /* sem armazenamento: começa desligado */
    }
  }, []);
  const togglePause = (v: boolean) => {
    setPause(v);
    try {
      localStorage.setItem('shorts-pause', v ? '1' : '0');
    } catch {
      /* ignora */
    }
  };
  const [url, setUrl] = useState(p.fullVideoUrl ?? '');
  const [urlMsg, setUrlMsg] = useState('');
  const saveUrl = async () => {
    const v = url.trim();
    if (v === (p.fullVideoUrl ?? '')) return;
    if (v && !/^https?:\/\//i.test(v)) return setUrlMsg('Cole o link completo (começa com https://)');
    const r = await fetch(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify({ fullVideoUrl: v }) });
    setUrlMsg(r.ok ? '✔ salvo' : 'Não salvou');
    if (r.ok) onSaved();
    setTimeout(() => setUrlMsg(''), 2000);
  };
  const [editing, setEditing] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const job = [...jobs].reverse().find((j) => j.kind === 'shorts');
  const running = job?.status === 'running';
  // feedback imediato ao clicar: o app salva as edições antes de iniciar e o job só aparece depois
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!starting) return;
    if (running) setStarting(false);
    const t = setTimeout(() => setStarting(false), 20000);
    return () => clearTimeout(t);
  }, [starting, running]);
  const fresh = renderUpToDate(p);
  const list = (p.shorts ?? []).filter((s) => !gone.has(s.id));
  const edited = list.find((s) => s.id === editing);
  const remove = async (id: string, title: string) => {
    if (!confirm(`Apagar o short "${title}"? O vídeo dele é excluído e não dá para desfazer.`)) return;
    setGone((g) => new Set(g).add(id));
    const r = await fetch(`/api/projects/${p.id}/shorts?short=${id}`, { method: 'DELETE' });
    if (!r.ok)
      setGone((g) => {
        const x = new Set(g);
        x.delete(id);
        return x;
      });
  };
  return (
    <section className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">📱 Shorts</h2>
        <span className="text-xs text-muted-foreground">O Diretor de Shorts planeja vídeos verticais de 20–40 s (até 45): só corte, ou com narração nova na voz do vídeo, na ordem do vídeo ou livre. Cada um com a sua legenda para o YouTube. Clique em ✂ Editar para ajustar o corte e a legenda.</span>
        <label className="ml-auto flex items-center gap-1 text-xs" title="Entra no fim da descrição de todos os shorts: ▶ Assista ao vídeo completo">
          🔗 Vídeo completo
          <input
            className="field px-2 py-1 text-xs"
            style={{ width: 260 }}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={saveUrl}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            placeholder="https://youtube.com/watch?v=…"
          />
          {urlMsg && <span className={urlMsg.startsWith('✔') ? 'text-green-500' : 'text-destructive'}>{urlMsg}</span>}
        </label>
        <label className="flex items-center gap-1 text-xs">
          Quantos
          <select className="field py-1 text-xs" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[3, 4, 5, 6, 8, 10].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs" title="Se a IA decidir criar narração nova, o plano para antes de gastar voz e espera o seu OK. Desligado: segue direto até o fim.">
          <input type="checkbox" checked={pause} onChange={(e) => togglePause(e.target.checked)} />
          Pausar se houver narração nova
        </label>
        <button
          className="btn-primary"
          disabled={busy || !fresh || starting || running}
          onClick={() => {
            setStarting(true);
            onStart(count, pause);
          }}
          title={fresh ? '' : 'Renderize o vídeo com as suas edições antes'}
        >
          {starting || running ? (
            <>
              <Spinner /> {running ? 'Criando shorts…' : 'Começando…'}
            </>
          ) : (
            '✨ Criar shorts'
          )}
        </button>
      </div>
      {!fresh && (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
          {p.lastRender ? '⚠ Você editou o vídeo depois do último render.' : '⚠ O vídeo ainda não foi renderizado.'} Renderize de novo; quando terminar, os botões de shorts liberam e eles saem sempre da versão mais recente.
        </p>
      )}
      {running && (
        <div className="space-y-1 text-xs">
          <div className="flex items-center gap-2">
            <span className="flex-1">{job.message}</span>
            <PaidAsk job={job} projectId={p.id} />
            <span className="tabular-nums text-muted-foreground">{Math.round(job.progress * 100)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-green-500 transition-[width] duration-500" style={{ width: `${Math.max(2, job.progress * 100)}%` }} />
          </div>
        </div>
      )}
      {job?.status === 'error' && <p className="text-xs text-destructive">Shorts: {job.message}</p>}
      {p.shortsPlan && !running && <PlanReview key={p.shortsPlan.at} p={p} onApprove={onApprove} onDiscard={onSaved} />}
      {!!list.length && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((s, k) => {
            const tags = s.tags.join(', ');
            const [from, to] = shortRange(p.shots, s);
            return (
              <article key={s.id} className="relative flex gap-3 rounded-md border p-2 text-xs">
                <button className="absolute right-1 top-1 rounded-full px-1.5 text-sm text-muted-foreground hover:bg-destructive hover:text-white" title="Apagar este short" onClick={() => remove(s.id, s.title)}>
                  ✕
                </button>
                <video src={fileUrl(p.id, s.file, s.at)} controls preload="metadata" className="aspect-[9/16] w-36 shrink-0 rounded bg-black" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="pr-5 text-[11px] text-muted-foreground">
                    Short {k + 1} · {Math.round(s.duration)} s ·{' '}
                    {s.parts ? (
                      <span>{s.mode === 'narrated' ? '🎙 narração nova' : '🔀 corte livre'} · {s.parts.length} imagens</span>
                    ) : (
                      <button className="underline" onClick={() => onGoTo(from)}>
                        partes {from + 1}–{to + 1}
                      </button>
                    )}
                  </p>
                  <p className="font-medium">{s.title}</p>
                  {s.summary && <p className="text-muted-foreground">{s.summary}</p>}
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">Descrição e tags</summary>
                    <p className="mt-1 whitespace-pre-wrap">{shortDescription(s.description, p.fullVideoUrl)}</p>
                    <p className="mt-1 text-muted-foreground">{tags}</p>
                  </details>
                  <div className="flex flex-wrap gap-1">
                    <button className="btn-primary px-2 py-0.5 text-xs" disabled={!!s.parts} title={s.parts ? 'Short do Diretor (partes soltas ou narração nova): o editor de trecho ainda não edita este formato' : ''} onClick={() => setEditing(s.id)}>
                      ✂ Editar
                    </button>
                    <CopyBtn text={s.title} label="Título" />
                    <CopyBtn text={shortDescription(s.description, p.fullVideoUrl)} label="Descrição" />
                    <CopyBtn text={tags} label="Tags" />
                    <a className="btn px-2 py-0.5 text-xs" href={fileUrl(p.id, s.file, s.at)} download={`${s.title.replace(/[<>:"/\\|?*#]/g, '').trim().slice(0, 60) || `short_${k + 1}`}.mp4`}>
                      ⬇ Baixar
                    </a>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {edited && (
        <ShortEditor
          key={edited.id}
          p={p}
          short={edited}
          busy={busy}
          fresh={fresh}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
          onRender={(c) => {
            onRenderOne(edited.id, c.from, c.to, c.skip.filter((x) => p.shots.slice(c.from, c.to + 1).some((s) => s.id === x)), c.cuts, c.frames);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

const wordsSec = (t: string) => (t.split(/\s+/).filter(Boolean).length / 150) * 60 + 0.25;

/** Plano parado: mostra cada short planejado (formato, motivo, narração nova editável) e só gasta voz depois do OK. */
function PlanReview({ p, onApprove, onDiscard }: { p: StudioProject; onApprove: (plan: PlanItem[]) => void; onDiscard: () => void }) {
  const [items, setItems] = useState<PlanItem[]>(() => structuredClone(p.shortsPlan!.items));
  const [off, setOff] = useState<Set<string>>(new Set());
  const shotOf = (id: string) => p.shots.find((x) => x.id === id);
  const secs = (it: PlanItem) => it.parts.reduce((a, pt) => a + (pt.text ? wordsSec(pt.text) : (shotDurations(p)[p.shots.findIndex((x) => x.id === pt.shot)] ?? 0)), 0);
  const kept = items.filter((i) => !off.has(i.id));
  const setText = (id: string, j: number, text: string) => setItems((cur) => cur.map((it) => (it.id === id ? { ...it, parts: it.parts.map((pt, k) => (k === j ? { ...pt, text } : pt)) } : it)));
  const discard = async () => {
    if (!confirm('Descartar o plano? Nenhuma voz foi gasta.')) return;
    await fetch(`/api/projects/${p.id}/shorts?plan=1`, { method: 'DELETE' });
    onDiscard();
  };
  const nar = kept.filter((i) => i.mode === 'narrated').length;
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/60 bg-amber-500/10 p-3 text-xs">
      <p className="text-sm font-medium">⏸ Plano de shorts esperando o seu OK</p>
      <p className="text-muted-foreground">Nada de voz foi gasto ainda. Edite o texto da narração nova, desmarque o que não quiser e aprove.</p>
      {items.map((it) => {
        const t = secs(it);
        return (
          <div key={it.id} className={`space-y-1 rounded border p-2 ${off.has(it.id) ? 'opacity-40' : ''}`}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!off.has(it.id)} onChange={(e) => setOff((o) => { const n = new Set(o); if (e.target.checked) n.delete(it.id); else n.add(it.id); return n; })} />
              <span className="rounded bg-muted px-1.5 py-0.5">{it.mode === 'narrated' ? '🎙 narração nova' : '✂ só corte'}</span>
              <span className="font-medium">{it.title}</span>
              <span className={`ml-auto tabular-nums ${t > 45 ? 'text-destructive' : 'text-muted-foreground'}`}>~{Math.round(t)} s</span>
            </label>
            {it.why && <p className="text-muted-foreground">{it.why}</p>}
            {it.summary && <p>{it.summary}</p>}
            {it.mode === 'narrated' ? (
              <div className="space-y-1">
                {it.parts.map((pt, j) => {
                  const pg = p.pages.find((x) => x.id === shotOf(pt.shot)?.pageId);
                  return (
                    <div key={j} className="flex gap-2">
                      {pg && <img src={`/api/file?project=${p.id}&f=${encodeURIComponent(pg.file)}&w=96`} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />}
                      <textarea className="field h-12 text-xs" value={pt.text ?? ''} onChange={(e) => setText(it.id, j, e.target.value)} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground">{it.parts.length} imagens do vídeo, com a voz original</p>
            )}
          </div>
        );
      })}
      <div className="flex gap-2">
        <button className="btn-primary flex-1 justify-center" disabled={!kept.length} onClick={() => onApprove(kept)}>
          Aprovar e gerar {kept.length} short(s){nar ? ` (${nar} com voz nova)` : ''}
        </button>
        <button className="btn" onClick={discard}>
          Descartar plano
        </button>
      </div>
    </div>
  );
}
