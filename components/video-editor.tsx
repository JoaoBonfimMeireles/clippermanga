'use client';
// Editor do vídeo final (/p/<id>/editor): prévia da parte no centro, ferramentas à esquerda, vídeo renderizado à direita
// e a linha do tempo embaixo (régua, partes, narração por fala, cortes, imagens). Edita os shots do projeto;
// o render reaproveita a voz em cache. A linha do tempo só desenha o que está visível (projetos com centenas de partes).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JobInfo, Shot, ShotView, StudioProject } from '@/lib/types';
import { MOTIONS, jobEta, quotaFromLogs, quotaText } from '@/lib/types';
import { baseOf, shotsDelta, type ShotsBase } from '@/lib/shots-merge';
import { FocusEditor } from './focus-editor';
import { CropThumb, DoubtsModal, useQueuedDoubts } from './doubts-modal';
import { DictateButton } from './learn-helpers';
import { LearnQuestions } from './learn-questions';
import { fmtClock, fmtDuration } from '@/lib/duration';
import { Preview, pageUrl } from './preview';
import { LastRenderInfo } from './last-render';
import { PaidAsk } from './paid-ask';

const parseTime = (v: string) => {
  const m = v.trim().replace(',', '.').match(/^(\d+):(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Math.max(0, Number(v.replace(',', '.')) || 0);
};
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const newId = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 8);
const LABEL_W = 92;
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const SPANS = [5, 10, 15, 30, 60, 120, 300]; // segundos visíveis na tela
const TRACK_H = 34;

/**
 * Uma parte na linha do tempo JÁ EDITADA. start/dur = tempo editado (o que o vídeo vai ter no próximo render).
 * seg* = onde ela está no último vídeo renderizado; pend = cortes ainda não renderizados (tempo local do vídeo renderizado);
 * ratio = velocidade nova ÷ velocidade renderizada. Com isso a prévia toca o vídeo antigo pulando cortes e acelerando.
 */
type Item = { i: number; shot: Shot; start: number; dur: number; rendered: boolean; cuts: [number, number][]; segStart: number; segDur: number; gs: number; ratio: number; pend: [number, number][] };
/** tempo editado (local) → tempo local no vídeo renderizado */
function e2r(it: Item, u: number) {
  let r = u * it.ratio;
  for (const [a, b] of it.pend) if (r >= a) r += b - a;
  return Math.min(r, it.segDur);
}
/** tempo local no vídeo renderizado → tempo editado (local) */
function r2e(it: Item, r: number) {
  let x = r;
  for (const [a, b] of it.pend) if (r >= b) x -= b - a;
  else if (r > a) x -= r - a;
  return x / it.ratio;
}
/** tempo editado (local) → tempo no áudio original da fala (onde os cortes são guardados) */
function localToRaw(it: Item, u: number) {
  return it.rendered ? toRaw(e2r(it, u) * it.gs, it.cuts) : u * (it.shot.speed ?? 1);
}
type Tab = 'ia' | 'parte' | 'texto' | 'inserir' | 'aprender';
type Learning = { rules: string[]; questions: { id: string; title: string; part: number; question: string; answer?: string; projectId: string }[] };

/** Tempo dentro do áudio renderizado → tempo no áudio original da fala (os cortes já aplicados no render somem). */
function toRaw(t: number, cuts: [number, number][]) {
  let r = t;
  for (const [a, b] of [...cuts].sort((x, y) => x[0] - y[0])) if (r >= a) r += b - a;
  return r;
}
function toRendered(raw: number, cuts: [number, number][]) {
  let r = raw;
  for (const [a, b] of cuts) if (raw >= b) r -= b - a;
  else if (raw > a) r -= raw - a;
  return r;
}

export function VideoEditor({ id }: { id: string }) {
  const [p, setP] = useState<StudioProject | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(0);
  const [time, setTime] = useState(0);
  const [tab, setTab] = useState<Tab>('parte');
  const [pps, setPps] = useState(6); // pixels por segundo
  const [scroll, setScroll] = useState({ left: 0, width: 1200 });
  const [range, setRange] = useState<{ i: number; a: number; b: number } | null>(null); // seleção na narração (tempo global)
  const [filter, setFilter] = useState('');
  const [hit, setHit] = useState(0);
  const [cacheOnly, setCacheOnly] = useState(true);
  const [aiPrompt, setAiPrompt] = useState('');
  // zoom da página do mangá (escolha do recorte): Ctrl + rolagem aproxima onde está o mouse
  const [pageZoom, setPageZoom] = useState(1);
  // dúvidas da IA sobre recortes (lib/restyle.ts): abre sozinho quando chegam dúvidas novas
  const [doubtsOpen, setDoubtsOpen] = useState(false);
  const doubtKey = (p?.doubts ?? []).map((d) => d.id).join(',');
  useEffect(() => {
    if (doubtKey) setDoubtsOpen(true);
  }, [doubtKey]);
  // aprendizado: regras que a IA tirou das suas correções e perguntas dela
  const [learn, setLearn] = useState<Learning | null>(null);
  const [newRule, setNewRule] = useState('');
  const loadLearn = useCallback(() => fetch('/api/learning').then((r) => r.json()).then(setLearn).catch(() => {}), []);
  const postLearn = (b: object) => fetch('/api/learning', { method: 'POST', body: JSON.stringify(b) }).then((r) => r.json()).then(setLearn);
  useEffect(() => {
    loadLearn();
  }, [loadLearn, p?.lastRender?.at]);
  // arrastar a imagem na tela grande (vídeo pausado) move o recorte da parte; Ctrl + rolagem aproxima
  const [adjusting, setAdjusting] = useState(false);
  const keepAdjusting = useRef(false); // veio do "Ajustar eu mesmo": a troca de parte abre direto na prévia do recorte
  useEffect(() => {
    setAdjusting(keepAdjusting.current); // outra parte: volta a mostrar o vídeo
    keepAdjusting.current = false;
  }, [sel]);
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 800, h: 450 });
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  });
  const dragRef = useRef<{ x: number; y: number; moved: boolean; focus: { x0: number; y0: number; x1: number; y1: number } } | null>(null);
  const stageZoom = useRef<(dir: number) => void>(() => {});
  const stageCrop = useRef<(dir: number, axis: 'x' | 'y') => void>(() => {});
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const d = e.deltaY || e.deltaX;
      if (e.shiftKey || e.altKey) {
        // Shift + rolagem: recorte mais alto/baixo; Alt + rolagem: mais largo/estreito (pega mais da página)
        e.preventDefault();
        stageCrop.current(d < 0 ? 1 : -1, e.shiftKey ? 'y' : 'x');
        return;
      }
      if (!e.ctrlKey) return;
      e.preventDefault();
      stageZoom.current(d < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });
  const pageBox = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null); // painel lateral (o único scroll vertical: a página aparece inteira)
  const zoomRef = useRef(1);
  zoomRef.current = pageZoom;
  useEffect(() => {
    const el = pageBox.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const z0 = zoomRef.current;
      const z1 = Math.min(12, Math.max(1, +(z0 * (e.deltaY < 0 ? 1.15 : 1 / 1.15)).toFixed(3)));
      if (z1 === z0) return;
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      // mantém o ponto embaixo do mouse no mesmo lugar (na horizontal pela rolagem da página, na vertical pelo painel lateral)
      const fx = (el.scrollLeft + mx) / el.scrollWidth, fy = my / r.height;
      setPageZoom(z1);
      requestAnimationFrame(() => {
        el.scrollLeft = fx * el.scrollWidth - mx;
        const r2 = el.getBoundingClientRect();
        if (sideRef.current) sideRef.current.scrollTop += r2.top + fy * r2.height - e.clientY;
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });
  // leva o painel lateral até o recorte (centralizado), já que a página aparece inteira, sem rolagem própria
  const centerCrop = (f: { x0: number; y0: number; x1: number; y1: number }) => {
    const box = pageBox.current, side = sideRef.current;
    if (!box) return;
    box.scrollLeft = ((f.x0 + f.x1) / 2) * box.scrollWidth - box.clientWidth / 2;
    if (side) side.scrollTop += box.getBoundingClientRect().top - side.getBoundingClientRect().top + ((f.y0 + f.y1) / 2) * box.scrollHeight - side.clientHeight / 2;
  };
  const zoomToFocus = (f: { x0: number; y0: number; x1: number; y1: number }, pg0: { width: number; height: number }, fill = 0.85) => {
    const el = pageBox.current;
    if (!el) return;
    const img = el.firstElementChild as HTMLElement | null;
    const bw = (img?.offsetWidth ?? el.clientWidth) / pageZoom, bh = bw * (pg0.height / pg0.width); // tamanho com zoom 1
    const viewH = sideRef.current?.clientHeight ?? el.clientHeight;
    const z = Math.min(12, Math.max(1, fill * Math.min(el.clientWidth / ((f.x1 - f.x0) * bw), viewH / ((f.y1 - f.y0) * bh))));
    setPageZoom(+z.toFixed(2));
    // espera o novo zoom estar na tela para medir o tamanho rolável
    setTimeout(() => centerCrop(f), 60);
  };
  // "Ajustar eu mesmo": depois de trocar de parte, leva o painel esquerdo até o quadro, com folga em volta para reenquadrar
  const [jumpTick, setJumpTick] = useState(0);
  const jumpToCrop = useRef<() => void>(() => {});
  useEffect(() => {
    if (jumpTick) jumpToCrop.current();
  }, [jumpTick]);
  // o painel esquerdo acompanha o vídeo: ao tocar (ou trocar de parte) a página rola até o recorte de agora e o painel
  // lateral mantém essa página à vista, com as opções logo abaixo (meio a meio)
  // quanto já foi editado por você (log de edições do servidor), para a barra de cima
  const [editStats, setEditStats] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`/api/projects/${id}/edit-stats`)
        .then((r) => r.json())
        .then((d: { edited?: Record<string, string[]> }) => live && setEditStats(d.edited ?? {}))
        .catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  const followKey = useRef<() => string>(() => '');
  const followNow = useRef<() => void>(() => {});
  const lastFollow = useRef('');
  useEffect(() => {
    const k = followKey.current();
    if (k === lastFollow.current) return;
    lastFollow.current = k;
    setTimeout(() => followNow.current(), 40); // espera a página nova ser desenhada para medir a rolagem
  });
  const [aiAll, setAiAll] = useState(true);
  const [aiFrom, setAiFrom] = useState(1); // segundos (trecho do corte / da IA / da velocidade)
  const [aiTo, setAiTo] = useState(5);
  const [spFrom, setSpFrom] = useState(0); // trecho para acelerar
  const [spTo, setSpTo] = useState(0);
  const [follow, setFollow] = useState(true);
  const video = useRef<HTMLVideoElement>(null);
  const tl = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const history = useRef<Shot[][]>([]);
  const future = useRef<Shot[][]>([]);
  const lastPush = useRef(0);
  const deleteRef = useRef<() => void>(() => {});

  // retrato das partes como o servidor as conhece: o salvamento manda só o que mudou em relação a ele (lib/shots-merge.ts)
  const base = useRef<ShotsBase | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/projects/${id}`);
    if (!r.ok) return;
    const j = (await r.json()) as StudioProject;
    base.current = baseOf(j.shots ?? []);
    setP(j);
  }, [id]);
  useEffect(() => {
    load();
    fetch(`/api/projects/${id}/jobs`).then((r) => (r.ok ? r.json() : [])).then(setJobs).catch(() => {});
  }, [id, load]);

  const restylingRef = useRef(false);
  const save = useCallback(async (cur: StudioProject) => {
    if (restylingRef.current) return; // a IA está mexendo nos recortes: não sobrescreve
    dirty.current = false;
    const r = await fetch(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify({ shots: cur.shots, ...shotsDelta(base.current, cur.shots), cutWords: cur.cutWords, endSilence: cur.endSilence ?? 3, endTalkPad: cur.endTalkPad ?? 0.8 }) });
    if (r.ok) base.current = baseOf(cur.shots);
  }, [id]);
  useEffect(() => {
    if (!p || !dirty.current) return;
    const t = setTimeout(() => save(p), 700);
    return () => clearTimeout(t);
  }, [p, save]);
  const edit = useCallback((fn: (d: StudioProject) => void, undoable = true) => {
    setP((cur) => {
      if (!cur) return cur;
      // um passo de desfazer por ajuste (arrastar um controle conta como um só)
      const now = Date.now();
      if (undoable && now - lastPush.current > 700) history.current = [...history.current.slice(-99), cur.shots];
      if (undoable) {
        lastPush.current = now;
        future.current = [];
      }
      const d = { ...cur, shots: cur.shots.map((s) => ({ ...s })), cutWords: [...(cur.cutWords ?? [])] };
      fn(d);
      dirty.current = true;
      return d;
    });
  }, []);
  const undo = useCallback(() => {
    const prev = history.current.pop();
    lastPush.current = 0;
    if (prev) setP((cur) => (cur ? ((future.current = [...future.current, cur.shots]), (dirty.current = true), { ...cur, shots: prev }) : cur));
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    lastPush.current = 0;
    if (next) setP((cur) => (cur ? ((history.current = [...history.current, cur.shots]), (dirty.current = true), { ...cur, shots: next }) : cur));
  }, []);

  const running = jobs.some((j) => j.status === 'running');
  // jobs começados fora desta tela (ex.: aplicar estilo): confere a cada 5 s para recarregar quando terminarem
  useEffect(() => {
    if (running) return;
    const t = setInterval(() => fetch(`/api/projects/${id}/jobs`).then((r) => (r.ok ? r.json() : [])).then((l: JobInfo[]) => l.some((j) => j.status === 'running') && setJobs(l)).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [running, id]);
  const restyling = jobs.some((j) => j.status === 'running' && j.kind === 'restyle');
  restylingRef.current = restyling;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const list = (await (await fetch(`/api/projects/${id}/jobs`)).json()) as JobInfo[];
      setJobs(list);
      if (!list.some((j) => j.status === 'running')) load();
    }, 1000);
    return () => clearInterval(t);
  }, [running, id, load]);

  // ocioso: um processo iniciado de fora (a cadeia automática, outra aba, o servidor) aparece sozinho, sem precisar de refresh
  useEffect(() => {
    if (running) return;
    const t = setInterval(async () => {
      try {
        const list = (await (await fetch(`/api/projects/${id}/jobs`)).json()) as JobInfo[];
        if (list.some((j) => j.status === 'running')) setJobs(list); // vira "rodando" e o acompanhamento rápido assume
      } catch {
        /* servidor ocupado: tenta de novo */
      }
    }, 4000);
    return () => clearInterval(t);
  }, [running, id]);
  const [starting, setStarting] = useState(false);
  const start = async (body: object | FormData) => {
    if (starting) return; // um clique só: salvar 660 partes demora e o botão ficava livre nesse meio tempo
    setStarting(true);
    try {
      await startNow(body);
    } finally {
      setStarting(false);
    }
  };
  const startNow = async (body: object | FormData) => {
    setErr('');
    if (p && dirty.current) await save(p);
    const r = await fetch(`/api/projects/${id}/jobs`, body instanceof FormData ? { method: 'POST', body } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    if (!r.ok) return setErr(await r.text());
    const j = (await r.json()) as JobInfo;
    setJobs((cur) => [...cur.filter((x) => x.id !== j.id), j]);
  };

  // tempos de cada parte: os reais do último render; partes novas/alteradas usam a duração pedida
  const items = useMemo<Item[]>(() => {
    if (!p) return [];
    const segs = new Map((p.lastRender?.segments ?? []).map((g) => [g.id, g]));
    let t = 0;
    return p.shots.map((shot, i) => {
      const g = segs.get(shot.id);
      const sp = shot.speed ?? 1;
      let it: Item;
      if (!g) {
        it = { i, shot, start: t, dur: shot.duration / sp, rendered: false, cuts: [], segStart: 0, segDur: 0, gs: 1, ratio: sp, pend: [] };
      } else {
        const gs = g.speed ?? 1;
        const cuts = g.cuts ?? [];
        // parte sem fala encurtada à mão: usa a duração nova
        const segDur = shot.text.trim() ? g.dur : Math.min(g.dur, shot.duration / gs);
        const pend = (shot.audioCuts ?? [])
          .filter(([a, b]) => !cuts.some(([x, y]) => x === a && y === b))
          .map(([a, b]) => [toRendered(a, cuts) / gs, toRendered(b, cuts) / gs] as [number, number])
          .filter(([a, b]) => b - a > 0.01 && a < segDur)
          .sort((x, y) => x[0] - y[0]);
        const cutLen = pend.reduce((n, [a, b]) => n + Math.min(b, segDur) - a, 0);
        const ratio = sp / gs;
        it = { i, shot, start: t, dur: Math.max(0.1, (segDur - cutLen) / ratio), rendered: true, cuts, segStart: g.start, segDur, gs, ratio, pend };
      }
      t += it.dur;
      return it;
    });
  }, [p]);
  const total = items.length ? items[items.length - 1].start + items[items.length - 1].dur : 0;
  const at = useCallback((t: number) => {
    let lo = 0, hi = items.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (items[m].start <= t) lo = m;
      else hi = m - 1;
    }
    return lo;
  }, [items]);

  const matches = useMemo(() => {
    const q = norm(filter);
    if (!q || !p) return [] as number[];
    return p.shots.flatMap((s, i) => (` ${norm(s.text)} `.includes(` ${q} `) ? [i] : []));
  }, [filter, p]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const pageById = useMemo(() => new Map((p?.pages ?? []).map((x) => [x.id, x])), [p?.pages]);

  const seek = useCallback((t: number, select = true) => {
    const c = Math.max(0, Math.min(total, t));
    setTime(c);
    if (select && items.length) setSel(at(c));
    const it = items[at(c)];
    if (video.current && p?.lastRender && it?.rendered) {
      playIdx.current = it.i;
      // seek nosso: o onSeeked não recalcula a parte pelo quadro (o 1º quadro pode ser o último da parte anterior
      // e a seleção "pulava" para ela). +0,04 s cai dentro do 1º quadro desta parte.
      ownSeek.current = true;
      video.current.currentTime = it.segStart + Math.min(it.segDur - 0.05, e2r(it, c - it.start) + 0.04);
      video.current.playbackRate = it.ratio * viewRateRef.current;
    }
  }, [at, items, total, p?.lastRender]);
  const goTo = (i: number) => {
    setSel(i);
    if (items[i]) seek(items[i].start + 0.01, false);
    const el = tl.current;
    if (el && items[i]) {
      const x = items[i].start * pps;
      if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - LABEL_W - 40) el.scrollLeft = Math.max(0, x - 120);
    }
  };

  // prévia das edições sem renderizar: toca o último vídeo pulando partes apagadas e trechos cortados,
  // na velocidade nova de cada parte; o cursor anda no tempo editado
  const playIdx = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [viewRate, setViewRate] = useState(1); // velocidade só para assistir
  const viewRateRef = useRef(1);
  viewRateRef.current = viewRate;
  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };
  const ownSeek = useRef(false);
  const onVideoTick = () => {
    const v = video.current;
    if (!v || !items.length) return;
    const rt = v.currentTime;
    let it = items[playIdx.current];
    // o usuário arrastou a barra do player: acha a parte pelo tempo do vídeo renderizado
    if (!it || !it.rendered || rt < it.segStart - 0.05 || rt > it.segStart + it.segDur + 0.3) {
      it = items.find((x) => x.rendered && rt >= x.segStart && rt < x.segStart + x.segDur) ?? it;
      if (it) playIdx.current = it.i;
    }
    if (!it) return;
    let local = rt - it.segStart;
    const inCut = it.pend.find(([a, b]) => local >= a && local < b - 0.02);
    if (inCut) {
      ownSeek.current = true;
      v.currentTime = it.segStart + inCut[1];
      local = inCut[1];
    }
    if (local >= it.segDur - 0.03 || !it.rendered) {
      const next = items.slice(it.i + 1).find((x) => x.rendered);
      if (!next) {
        v.pause();
        return;
      }
      playIdx.current = next.i;
      ownSeek.current = true;
      v.currentTime = next.segStart + (next.pend[0]?.[0] === 0 ? next.pend[0][1] : 0) + 0.001;
      v.playbackRate = next.ratio * viewRateRef.current;
      it = next;
      local = 0;
    }
    const want = Math.min(16, it.ratio * viewRateRef.current);
    if (Math.abs(v.playbackRate - want) > 0.01) v.playbackRate = want;
    onVideoTime(it.start + r2e(it, Math.max(0, local)));
  };
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (video.current && !video.current.paused) onVideoTick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  // playhead acompanha o vídeo tocando. Tocando, atualiza a tela ~20x/s em vez de a cada quadro (60x/s):
  // cada atualização redesenha o editor inteiro (prévia, trilhas, painéis)
  const lastTick = useRef(0);
  const onVideoTime = (t: number) => {
    const nowMs = performance.now();
    if (!video.current?.paused && nowMs - lastTick.current < 50) return;
    lastTick.current = nowMs;
    setTime(t);
    if (!items.length) return;
    const i = at(t);
    if (i !== sel) setSel(i);
    const el = tl.current;
    if (follow && el && !video.current?.paused) {
      const x = t * pps;
      if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - LABEL_W - 60) el.scrollLeft = Math.max(0, x - 80);
    }
  };

  useEffect(() => {
    const el = tl.current;
    if (!el) return;
    const upd = () => setScroll({ left: el.scrollLeft, width: el.clientWidth });
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    el.addEventListener('scroll', upd, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', upd);
    };
  }, [p === null]);

  // atalhos: espaço toca/pausa, Ctrl+Z desfaz
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === ' ' && video.current) {
        e.preventDefault();
        if (video.current.paused) video.current.play();
        else video.current.pause();
      } else if (e.key === 'Delete') {
        e.preventDefault();
        deleteRef.current();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [undo, redo]);

  // as respostas das dúvidas já foram gravadas pelo modal: essas partes passam a ser "o que o servidor conhece"
  const syncBase = (shots: Shot[]) => {
    const b = base.current;
    if (b && p) shots.forEach((s, i) => s !== p.shots[i] && b.set(s.id, JSON.stringify(s)));
  };
  const dq = useQueuedDoubts(p, running, (shots, render) => {
    if (!p) return;
    syncBase(shots);
    history.current = [...history.current.slice(-99), p.shots];
    dirty.current = false;
    setP({ ...p, shots, doubts: [] });
    if (render) start({ kind: 'render', cacheOnly: true });
  });
  if (!p) return <p className="p-4 text-muted-foreground">Carregando…</p>;
  const shot = p.shots[sel];
  const item = items[sel];
  // Ajustar o recorte de uma fala que repete a imagem da anterior (mesma página e mesmo recorte) ajusta também as
  // anteriores que mostram essa mesma imagem: a imagem repetida continua igual nas duas falas.
  const patch = (ch: Partial<Shot>) =>
    edit((d) => {
      const cur = d.shots[sel];
      const KEYS = ['pageId', 'focus', 'zoom', 'stretch', 'rotate', 'fit'] as const;
      if (cur && KEYS.some((k) => ch[k] !== undefined)) {
        // as partes seguidas que mostram a MESMA imagem (antes e depois desta) mudam juntas: quem puxou a imagem de uma
        // vizinha (ou repete a anterior) acompanha o ajuste que você faz em qualquer uma delas
        const same = (a: Shot, b: Shot) => a.pageId === b.pageId && JSON.stringify(a.focus) === JSON.stringify(b.focus);
        const run: Shot[] = [];
        for (let i = sel - 1; i >= 0 && same(d.shots[i], cur); i--) run.push(d.shots[i]);
        for (let i = sel + 1; i < d.shots.length && same(d.shots[i], cur); i++) run.push(d.shots[i]);
        for (const o of run) for (const k of KEYS) if (ch[k] !== undefined) Object.assign(o, { [k]: ch[k] });
      }
      Object.assign(cur, ch);
    });
  const nViews = 1 + (shot?.extra?.length ?? 0);
  const viewIdx = item && nViews > 1 ? Math.min(nViews - 1, Math.max(0, Math.floor(((time - item.start) / Math.max(0.01, item.dur)) * nViews))) : 0;
  const curView = viewIdx === 0 ? shot : shot?.extra?.[viewIdx - 1];
  const patchView = (ch: Partial<Shot>) =>
    viewIdx === 0 ? patch(ch) : edit((d) => (d.shots[sel].extra = d.shots[sel].extra?.map((v, j) => (j === viewIdx - 1 ? { ...v, ...ch } : v))));
  // vizinhas da imagem que está passando agora: a de antes e a de depois (dentro da mesma fala ou nas falas ao lado)
  const spokenShot = (x: Shot) => p.narration === 'mic' || !!x.text.trim();
  const neighbour = (dir: -1 | 1): { v: ShotView; label: string } | null => {
    if (!shot) return null;
    const inner = viewIdx + dir;
    if (inner >= 0 && inner < nViews) return { v: inner === 0 ? shot : shot.extra![inner - 1], label: `imagem ${inner + 1} desta fala` };
    for (let j = sel + dir; j >= 0 && j < p.shots.length; j += dir) {
      const x = p.shots[j];
      if (!spokenShot(x)) continue;
      return { v: dir < 0 ? (x.extra?.length ? x.extra[x.extra.length - 1] : x) : x, label: `parte ${j + 1}` };
    }
    return null;
  };
  const applyNeighbour = (v: ShotView) => patchView({ pageId: v.pageId, focus: v.focus, fit: v.fit, rotate: v.rotate, stretch: v.stretch, zoom: v.zoom, bgBand: v.bgBand });
  // a página e o recorte mostrados à esquerda são os da imagem que está na tela (pode ser a 2ª da mesma fala)
  const pg = curView && pageById.get(curView.pageId ?? shot.pageId);
  jumpToCrop.current = () => {
    if (!curView || !pg) return;
    pageBox.current?.scrollIntoView({ block: 'center' });
    zoomToFocus(curView.focus, pg, 0.55);
  };
  followKey.current = () => (curView && tab === 'parte' ? `${sel}|${curView.pageId}|${playing ? JSON.stringify(curView.focus) : ''}` : '');
  followNow.current = () => {
    if (curView?.focus) centerCrop(curView.focus);
  };
  stageCrop.current = (dir, axis) => {
    const f = curView?.focus;
    if (!f || playing) return;
    setAdjusting(true);
    const k = dir > 0 ? 1.06 : 1 / 1.06;
    const [a0, a1] = axis === 'y' ? [f.y0, f.y1] : [f.x0, f.x1];
    const size = Math.min(1, Math.max(0.03, (a1 - a0) * k));
    const c = (a0 + a1) / 2;
    const n0 = Math.max(0, Math.min(1 - size, c - size / 2));
    patchView({ focus: axis === 'y' ? { ...f, y0: n0, y1: n0 + size } : { ...f, x0: n0, x1: n0 + size } });
  };
  stageZoom.current = (dir: number) => {
    if (!shot || playing) return;
    setAdjusting(true);
    patchView({ zoom: Math.round(Math.min(5, Math.max(0.3, (curView?.zoom ?? 1) * (dir > 0 ? 1.08 : 1 / 1.08))) * 100) / 100 });
  };

  // ações nas partes
  const split = () => {
    if (!item) return;
    const u = time - item.start;
    if (u < 0.3 || u > item.dur - 0.3) return setErr('Ponha o cursor (linha amarela) no meio da parte para dividir.');
    const f = u / item.dur;
    edit((d) => {
      const s = d.shots[sel];
      const words = s.text.split(/\s+/).filter(Boolean);
      const k = Math.round(words.length * f);
      const b: Shot = { ...s, id: newId(), duration: Math.max(0.5, +(s.duration * (1 - f)).toFixed(2)), text: words.slice(k).join(' '), audioCuts: undefined };
      s.duration = Math.max(0.5, +(s.duration * f).toFixed(2));
      s.text = words.slice(0, k).join(' ');
      s.audioCuts = undefined;
      d.shots.splice(sel + 1, 0, b);
    });
    setErr('Parte dividida: as duas falas novas precisam de voz nova (desmarque "só voz em cache" ao renderizar).');
  };
  const merge = () => {
    if (sel >= p.shots.length - 1) return;
    edit((d) => {
      const [a, b] = [d.shots[sel], d.shots[sel + 1]];
      a.text = [a.text, b.text].filter((x) => x.trim()).join(' ');
      a.duration = +(a.duration + b.duration).toFixed(2);
      a.audioCuts = undefined;
      d.shots.splice(sel + 1, 1);
    });
    setErr('Partes juntadas: a fala nova precisa de voz nova (desmarque "só voz em cache" ao renderizar).');
  };
  const move = (dir: -1 | 1) => {
    const j = sel + dir;
    if (j < 0 || j >= p.shots.length) return;
    edit((d) => ([d.shots[sel], d.shots[j]] = [d.shots[j], d.shots[sel]]));
    setSel(j);
  };
  const remove = () => {
    edit((d) => d.shots.splice(sel, 1));
    setSel((s) => Math.max(0, Math.min(s, p.shots.length - 2)));
  };
  deleteRef.current = remove; // tecla Delete apaga a parte selecionada
  const duplicate = () => edit((d) => d.shots.splice(sel + 1, 0, { ...d.shots[sel], id: newId(), text: '', audioCuts: undefined, duration: 2 }));
  const insertImage = (f: File, pos: number) => {
    const fd = new FormData();
    fd.append('files', f);
    fd.append('chapter', 'Imagens');
    fd.append('intro', '1');
    fd.append('at', String(pos));
    start(fd);
  };
  // troca a imagem da parte selecionada por um arquivo novo (a fala e a duração ficam)
  const replaceImage = (f: File) => {
    const fd = new FormData();
    fd.append('files', f);
    fd.append('chapter', 'Imagens');
    fd.append('replace', shot.id);
    start(fd);
  };
  // partes só com imagem, sem fala nenhuma
  const silentCount = p.shots.filter((s) => !s.text.trim()).length;
  const removeSilent = () => {
    if (!silentCount || !confirm(`Excluir ${silentCount} parte(s) que estão só com imagem, sem fala? Dá para desfazer com Ctrl+Z.`)) return;
    const keepSel = p.shots[sel];
    edit((d) => (d.shots = d.shots.filter((s) => s.text.trim())));
    const rest = p.shots.filter((s) => s.text.trim());
    setSel(Math.max(0, Math.min(keepSel ? rest.indexOf(keepSel) : 0, rest.length - 1)));
  };
  const cutRange = () => {
    if (!range) return;
    const it = items[range.i];
    const raw: [number, number] = [+localToRaw(it, range.a - it.start).toFixed(3), +localToRaw(it, range.b - it.start).toFixed(3)];
    edit((d) => (d.shots[range.i].audioCuts = [...(d.shots[range.i].audioCuts ?? []), raw].sort((x, y) => x[0] - y[0])));
    setRange(null);
  };
  const cutWordEverywhere = () => {
    const w = filter.trim();
    if (!w || (p.cutWords ?? []).some((x) => norm(x) === norm(w))) return;
    edit((d) => (d.cutWords = [...(d.cutWords ?? []), w]), false);
  };

  // zoom mantendo o cursor amarelo no mesmo lugar da tela
  const zoomTo = (n: number) => {
    const el = tl.current;
    const off = el ? time * pps - el.scrollLeft : 0;
    setPps(n);
    requestAnimationFrame(() => el && (el.scrollLeft = Math.max(0, time * n - off)));
  };
  const speedRange = (v: number) => {
    const [a, b] = [Math.min(spFrom, spTo), Math.max(spFrom, spTo)];
    if (b - a < 0.1) return setErr('Coloque o início e o fim do trecho para acelerar.');
    const f = at(a), t = at(Math.max(a, b - 0.01));
    edit((d) => {
      for (let k = f; k <= t; k++) d.shots[k].speed = v === 1 ? undefined : v;
    });
    setErr(`Velocidade ${String(v).replace('.', ',')}x nas partes ${f + 1} a ${t + 1}; vale no próximo render.`);
  };

  // velocidade do vídeo inteiro: mesma velocidade em todas as partes (substitui as velocidades por parte/trecho)
  const speedAll = (v: number) => {
    if (!Number.isFinite(v) || v < 0.25 || v > 4) return setErr('Velocidade do vídeo todo: use um valor de 0,25 a 4 (ex.: 1,4).');
    v = Math.round(v * 100) / 100;
    edit((d) => {
      for (const s of d.shots) s.speed = v === 1 ? undefined : v;
    });
    setErr(`Vídeo todo em ${String(v).replace('.', ',')}x; renderize para o vídeo sair nessa velocidade.`);
  };

  // apaga o trecho marcado: partes inteiras dentro dele somem; nas pontas, corta só o pedaço (fala ou duração)
  const deleteRange = () => {
    const [a, b] = [Math.min(aiFrom, aiTo), Math.max(aiFrom, aiTo)];
    if (b - a < 0.1) return setErr('Marque o trecho com "[ início" e "fim ]" antes de apagar.');
    const hit = items.filter((it) => it.start < b && it.start + it.dur > a);
    const drop = new Set<string>();
    const partial: { id: string; u0: number; u1: number; it: Item }[] = [];
    for (const it of hit) {
      const u0 = Math.max(0, a - it.start), u1 = Math.min(it.dur, b - it.start);
      if (u0 < 0.05 && u1 > it.dur - 0.05) drop.add(it.shot.id);
      else partial.push({ id: it.shot.id, u0, u1, it });
    }
    edit((d) => {
      for (const { id: sid, u0, u1, it } of partial) {
        const s = d.shots.find((x) => x.id === sid);
        if (!s) continue;
        if (s.text.trim()) s.audioCuts = [...(s.audioCuts ?? []), [+localToRaw(it, u0).toFixed(3), +localToRaw(it, u1).toFixed(3)] as [number, number]].sort((x, y) => x[0] - y[0]);
        s.duration = Math.max(0.5, +(s.duration - (u1 - u0)).toFixed(2));
      }
      d.shots = d.shots.filter((x) => !drop.has(x.id));
    });
    setSel(Math.max(0, Math.min(at(a), p.shots.length - 1 - drop.size)));
    setAiTo(a);
    setErr(`Trecho ${fmt(a)}–${fmt(b)} apagado: ${drop.size} parte(s) inteira(s) e ${partial.length} cortada(s) nas pontas. Vale no próximo render (Ctrl+Z desfaz).`);
  };

  // janela visível da linha do tempo
  const t0 = Math.max(0, scroll.left / pps - 2);
  const t1 = (scroll.left + scroll.width) / pps + 2;
  const vis = items.length ? items.slice(at(t0), at(t1) + 1) : [];
  const width = Math.max(scroll.width, total * pps + 200);
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pps >= 60) ?? 600;
  const ticks: number[] = [];
  for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  const timeAtX = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return (e.clientX - r.left) / pps;
  };

  const narrDown = (e: React.PointerEvent) => {
    const t = timeAtX(e);
    const i = at(t);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setRange({ i, a: t, b: t });
  };
  const narrMove = (e: React.PointerEvent) => {
    if (!range || !e.buttons) return;
    const it = items[range.i];
    const t = Math.max(it.start, Math.min(it.start + it.dur, timeAtX(e)));
    setRange({ ...range, b: t });
  };
  const narrUp = () => {
    if (!range) return;
    const [a, b] = [Math.min(range.a, range.b), Math.max(range.a, range.b)];
    if (b - a < 0.08) {
      // clique simples: abre o texto da fala
      setRange(null);
      setSel(range.i);
      seek(a, false);
      setTab('texto');
    } else setRange({ i: range.i, a, b });
  };

  const runningJobs = jobs.filter((j) => j.status === 'running');
  const lastJob = runningJobs[runningJobs.length - 1] ?? [...jobs].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))[jobs.length - 1];
  const KIND: Record<string, string> = { render: 'Renderizando', polish: 'Polindo com IA', import: 'Importando', publish: 'Publicação', edit: 'Edição com IA', script: 'Roteiro', context: 'Resumos', shorts: 'Criando shorts', restyle: 'Aplicando seu estilo', audit: 'Auditoria do gestor' };
  const tabBtn = (t: Tab, label: string) => (
    <button className={`flex-1 rounded px-2 py-1 text-xs ${tab === t ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`} onClick={() => setTab(t)}>
      {label}
    </button>
  );
  const num = (label: string, v: number, ch: (n: number) => void, stepV = 0.05, min = 0.1, max = 10) => (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-16 text-muted-foreground">{label}</span>
      <input type="range" min={min} max={max} step={stepV} value={v} onChange={(e) => ch(Number(e.target.value))} className="flex-1" />
      <input type="number" min={min} max={max} step={stepV} value={v} onChange={(e) => ch(Number(e.target.value) || v)} className="field w-16 px-1 py-0.5 text-xs" />
    </label>
  );

  const doubts = p.doubts ?? [];
  return (
    <div className="space-y-3">
    {dq.queued && (
      <p className="flex items-center gap-2 rounded border border-amber-400 p-2 text-xs text-amber-300">
        ⏳ Suas respostas das dúvidas vão ser aplicadas quando o processo em andamento terminar{dq.queued.render ? ' (e renderiza só o que mudou)' : ''}.
        <button className="btn px-2 py-0.5" onClick={dq.cancel}>cancelar</button>
      </p>
    )}
    {doubtsOpen && doubts.length > 0 && (
      <DoubtsModal
        p={p}
        busy={running}
        onClose={() => setDoubtsOpen(false)}
        onQueue={dq.queue}
        onGoTo={(part, link) => {
          if (link) edit((d) => {
            // a parte da dúvida passa a repetir a imagem da anterior (é a opção escolhida)
            const j = d.shots.findIndex((x) => x.id === link), pv = d.shots[part - 1];
            if (j >= 0 && pv) Object.assign(d.shots[j], { pageId: pv.pageId, focus: pv.focus, stretch: pv.stretch, zoom: pv.zoom, rotate: pv.rotate });
          });
          setDoubtsOpen(false); keepAdjusting.current = part - 1 !== sel; setAdjusting(true); setTab('parte'); goTo(part - 1); setJumpTick((n) => n + 1); }}
        onDone={(shots, render) => {
          syncBase(shots);
          history.current = [...history.current.slice(-99), p.shots];
          dirty.current = false;
          setP({ ...p, shots, doubts: [] });
          setDoubtsOpen(false);
          if (render) start({ kind: 'render', cacheOnly: true });
        }}
      />
    )}
    <div className="flex h-[calc(100vh-4.5rem)] flex-col gap-2 text-sm" data-testid="video-editor">
      {/* barra de cima */}
      <div className="flex flex-wrap items-center gap-2">
        <a href={`/p/${id}`} className="btn">
          ← Estúdio
        </a>
        {doubts.length > 0 && (
          <button className="btn border-amber-400 text-amber-300" onClick={() => setDoubtsOpen(true)}>
            ❓ Dúvidas da IA ({doubts.length})
          </button>
        )}
        <h1 className="font-semibold">{p.title} · Editor de vídeo</h1>
        <span className="text-xs text-muted-foreground">
          {p.shots.length} partes · {fmtDuration(total)}
        </span>
        {(() => {
          const ids = new Set(p.shots.map((x) => x.id));
          const edited = Object.entries(editStats).filter(([k]) => ids.has(k));
          const sameImg = (x: Shot, y?: Shot) => !!y && x.pageId === y.pageId && JSON.stringify(x.focus) === JSON.stringify(y.focus);
          const spoken = (x: Shot) => p.narration === 'mic' || !!x.text.trim();
          let prevN = 0, nextN = 0, swapped = 0, crop = 0;
          for (const [sid, fields] of edited) {
            const i = p.shots.findIndex((x) => x.id === sid), x = p.shots[i];
            let pv: Shot | undefined, nx: Shot | undefined;
            for (let j = i - 1; j >= 0 && !pv; j--) if (spoken(p.shots[j])) pv = p.shots[j];
            for (let j = i + 1; j < p.shots.length && !nx; j++) if (spoken(p.shots[j])) nx = p.shots[j];
            if (sameImg(x, pv)) prevN++;
            if (sameImg(x, nx)) nextN++;
            if (fields.includes('pageId') || x.newImage) swapped++;
            if (fields.includes('focus')) crop++;
          }
          const multi = p.shots.filter((x) => (x.extra?.length ?? 0) > 0).length;
          const chip = (n: number, label: string, tip: string, cls: string) =>
            n > 0 ? (
              <span key={label} title={tip} className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${cls}`}>
                {n} {label}
              </span>
            ) : null;
          return (
            <>
              <span title="Partes em que você mexeu (recorte, zoom, imagem, texto, tempo…). Mudanças em massa do app não contam." className="rounded border border-green-500 bg-green-600/20 px-1.5 py-0.5 text-[11px] font-semibold text-green-300">
                ✏️ {edited.length} de {p.shots.length} editadas por você ({Math.round((edited.length / Math.max(1, p.shots.length)) * 100)}%)
              </span>
              {chip(crop, '✂ recorte ajustado', 'Partes em que você mudou o recorte', 'border-sky-500 text-sky-300')}
              {chip(prevN, '◀ com a imagem anterior', 'Partes suas que mostram a mesma imagem da parte anterior', 'border-amber-500 text-amber-300')}
              {chip(nextN, 'com a imagem posterior ▶', 'Partes suas que mostram a mesma imagem da parte seguinte', 'border-amber-500 text-amber-300')}
              {chip(swapped, '🖼 imagem trocada', 'Partes em que você trocou a página/imagem', 'border-purple-500 text-purple-300')}
              {chip(multi, '🎞 com várias imagens', 'Partes que mostram mais de uma imagem durante a fala', 'border-purple-500 text-purple-300')}
            </>
          );
        })()}
        <button className="btn" onClick={undo} disabled={!history.current.length} title="Ctrl+Z">
          ↶ Desfazer
        </button>
        <button className="btn" onClick={redo} disabled={!future.current.length} title="Ctrl+Y">
          ↷ Refazer
        </button>
        {p.lastRender && (
          <>
            <a className="btn text-xs" href={`/api/file?project=${p.id}&video=1&download=1`} title={`Último render: ${fmtDuration(p.lastRender.duration)} · ${new Date(p.lastRender.at).toLocaleString('pt-BR')}`}>
              Baixar MP4
            </a>
            <a className="btn text-xs" href={`/p/${id}/final`}>
              Publicação →
            </a>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <LastRenderInfo p={p} />
          <label className="flex items-center gap-1 text-xs" title="Segundos de silêncio no fim do vídeo, com a última imagem parada e saindo com fade (não termina seco). 0 = sem.">
            silêncio final
            <input className="field w-14 py-0.5" type="number" min={0} max={30} step={0.5} value={p.endSilence ?? 3} onChange={(e) => edit((d) => (d.endSilence = Math.min(30, Math.max(0, Number(e.target.value) || 0))), false)} />s
          </label>
          <label className="flex items-center gap-1 text-xs" title="Folga depois da última palavra da última fala (segundos). Aumente se o final da narração ainda estiver cortando.">
            folga da última fala
            <input className="field w-14 py-0.5" type="number" min={0} max={10} step={0.5} value={p.endTalkPad ?? 0.8} onChange={(e) => edit((d) => (d.endTalkPad = Math.min(10, Math.max(0, Number(e.target.value) || 0))), false)} />s
          </label>
          <label className="flex items-center gap-1 text-xs" title="Usa só a voz já gerada; se faltar alguma fala, para sem gastar">
            <input type="checkbox" checked={cacheOnly} onChange={(e) => setCacheOnly(e.target.checked)} /> só voz em cache
          </label>
          <button className="btn-primary" disabled={running || starting || !p.shots.length} onClick={() => start({ kind: 'render', cacheOnly })}>
            {starting ? 'Enviando…' : running ? 'Renderizando…' : 'Renderizar vídeo'}
          </button>
        </div>
      </div>
      {/* andamento do render/IA, bem visível */}
      {lastJob && (lastJob.status === 'running' || Date.now() - (lastJob.endedAt ?? 0) < 120_000) && (
        <div className={`rounded-lg border p-2 text-xs ${lastJob.status === 'error' ? 'border-destructive' : lastJob.status === 'done' ? 'border-emerald-500' : 'border-primary'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {lastJob.status === 'running' ? `⏳ ${KIND[lastJob.kind] ?? lastJob.kind}` : lastJob.status === 'done' ? '✅ Pronto' : '⚠ Falhou'}: {lastJob.message}
            </span>
            <PaidAsk job={lastJob} projectId={id} />
            <span className="font-mono">{Math.round(lastJob.progress * 100)}%{jobEta(lastJob) ? ` · ${jobEta(lastJob)}` : ''}</span>
            {(lastJob.quotaUsed ?? quotaFromLogs(lastJob.logs)) !== undefined && (
              <span className="rounded border border-amber-400/60 bg-amber-400/10 px-2 py-0.5 text-xs font-semibold text-amber-300" title="Quanto do limite de 5 h do seu plano do Claude este processo gastou (soma do medidor enquanto ele rodou; inclui qualquer outro uso do plano no mesmo período).">
                ⚡ {quotaText(lastJob.quotaUsed ?? quotaFromLogs(lastJob.logs) ?? 0)}{lastJob.quotaUsed === undefined ? ' (estimado)' : ''} do plano
              </span>
            )}
            {lastJob.status === 'running' && (
              <button className="btn px-2 py-0.5 text-xs" onClick={() => fetch(`/api/projects/${id}/jobs?job=${lastJob.id}`, { method: 'DELETE' })}>
                Cancelar
              </button>
            )}
            {runningJobs.filter((j) => j.kind === 'render').length > 1 && (
              <button
                className="btn px-2 py-0.5 text-xs text-destructive"
                onClick={async () => {
                  const renders = runningJobs.filter((j) => j.kind === 'render').sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
                  for (const j of renders.slice(0, -1)) await fetch(`/api/projects/${id}/jobs?job=${j.id}`, { method: 'DELETE' });
                }}
                title="Vários renders iguais rodando ao mesmo tempo deixam tudo lento: mantém só o mais recente"
              >
                {runningJobs.filter((j) => j.kind === 'render').length} renders rodando · cancelar os repetidos (deixa só o último)
              </button>
            )}
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded bg-muted">
            <div className={`h-full ${lastJob.status === 'error' ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${Math.max(2, lastJob.progress * 100)}%` }} />
          </div>
          {lastJob.status !== 'done' && <p className="mt-1 truncate text-muted-foreground">{lastJob.logs.slice(-1)[0]}</p>}
        </div>
      )}
      {err && (
        <p className="text-xs text-amber-400">
          {err}{' '}
          <button className="underline" onClick={() => setErr('')}>
            ok
          </button>
        </p>
      )}

      {/* meio: ferramentas · prévia · vídeo final */}
      <div className="grid min-h-0 flex-1 grid-cols-[460px_1fr] gap-2">
        <aside className="flex min-h-0 flex-col rounded-lg border bg-card p-2">
          <div className="mb-2 flex gap-1">
            {tabBtn('ia', '✨ IA')}
            {tabBtn('parte', 'Parte')}
            {tabBtn('texto', 'Fala')}
            {tabBtn('inserir', 'Inserir')}
            {tabBtn('aprender', `🧠${learn?.questions.some((q) => !q.answer) ? ` (${learn.questions.filter((q) => !q.answer).length})` : ''}`)}
          </div>
          <div ref={sideRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {!shot ? (
              <p className="text-muted-foreground">Linha do tempo vazia.</p>
            ) : tab === 'parte' ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Parte {sel + 1} · {fmt(item?.start ?? 0)} · {item?.dur.toFixed(1)} s{item && !item.rendered ? ' · (ainda não renderizada)' : ''}
                </p>
                <div className="rounded border bg-black/40 p-1">
                  <Preview projectId={p.id} format={p.format} shots={p.shots} pages={p.pages} selected={sel} onSelect={setSel} subtitles={!!p.subtitles} onEditShot={patch} />
                </div>
                <p className="text-[11px] text-muted-foreground">Acima: como a parte fica na tela (puxe as alças para esticar/aproximar). Abaixo: escolha o recorte na página.</p>
                {pg && (
                  <div className="rounded border">
                    <div className="flex items-center gap-1 border-b px-1 py-0.5 text-xs">
                      <span className="text-muted-foreground">Zoom da página (Ctrl + rolagem):</span>
                      <button className="btn px-2 py-0" onClick={() => setPageZoom((z) => Math.max(1, +(z / 1.25).toFixed(2)))}>−</button>
                      <span className="w-10 text-center font-mono">{Math.round(pageZoom * 100)}%</span>
                      <button className="btn px-2 py-0" onClick={() => setPageZoom((z) => Math.min(12, +(z * 1.25).toFixed(2)))}>+</button>
                      <button className="btn px-2 py-0" onClick={() => setPageZoom(1)}>ajustar</button>
                      <button className="btn px-2 py-0" onClick={() => zoomToFocus((curView ?? shot).focus, pg)} title="Aproxima no recorte atual">no recorte</button>
                    </div>
                    <div ref={pageBox} className="overflow-x-auto">
                      <FocusEditor src={pageUrl(p.id, pg)} width={pg.width} height={pg.height} focus={(curView ?? shot).focus} onChange={(focus) => { setAdjusting(true); patchView({ focus }); }} zoom={pageZoom} />
                    </div>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">Arraste na página para escolher o recorte; puxe as alças para ajustar.</p>
                  {(() => {
                    const opts = ([-1, 1] as const).map((d) => ({ d, n: neighbour(d) })).filter((x) => x.n);
                    if (!opts.length) return null;
                    return (
                      <div className="space-y-1 rounded border p-2 text-xs">
                        <p className="font-medium">Usar outra imagem aqui{nViews > 1 ? ` (na imagem ${viewIdx + 1} desta fala, a que está passando)` : ''}</p>
                        <p className="text-[11px] text-muted-foreground">Clique para trocar o que aparece neste ponto do vídeo pela imagem de antes ou pela de depois (mesmo recorte e ajustes dela).</p>
                        <div className="flex flex-wrap gap-2">
                          {opts.map(({ d, n }) => {
                            const vp = pageById.get(n!.v.pageId);
                            // selecionada = o que aparece neste ponto já é essa imagem (vale o último clique)
                            const on = !!curView && curView.pageId === n!.v.pageId && JSON.stringify(curView.focus) === JSON.stringify(n!.v.focus);
                            return (
                              <button key={d} type="button" className={`relative space-y-1 rounded border-2 p-1 text-left ${on ? 'border-green-500 bg-green-500/10' : 'border-transparent hover:border-primary'}`} onClick={() => { applyNeighbour(n!.v); setAdjusting(true); }} title={d < 0 ? 'Usar a imagem anterior' : 'Usar a imagem posterior'}>
                                {on && <span className="absolute right-1 top-1 z-10 flex size-6 items-center justify-center rounded-full bg-green-600 text-sm font-bold text-white">✔</span>}
                                {vp && <CropThumb src={pageUrl(p.id, vp)} page={vp} focus={n!.v.focus} scale={0.6} />}
                                <span className="block">
                                  {d < 0 ? '◀ Usar a anterior' : 'Usar a posterior ▶'} · {n!.label}
                                  {on ? ' · selecionada (entra no próximo render)' : ''}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                <div className="space-y-1 rounded border p-2 text-xs">
                  <p className="font-medium">🎞 Imagens durante a fala ({1 + (shot.extra?.length ?? 0)})</p>
                  <p className="text-[11px] text-muted-foreground">Enquanto a voz fala esta parte, as imagens vão trocando, nesta ordem. O tempo da parte é dividido entre elas.</p>
                  <div className="flex flex-wrap gap-1">
                    {[{ pageId: shot.pageId }, ...(shot.extra ?? [])].map((v, k) => {
                      const vp = pageById.get(v.pageId);
                      return (
                        <div key={k} className="relative">
                          {vp && <img src={pageUrl(p.id, vp, 96)} alt="" className="h-16 w-12 rounded-sm border object-cover" />}
                          <span className="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[10px]">{k + 1}</span>
                          {k > 0 && (
                            <button className="absolute -right-1 -top-1 rounded-full bg-destructive px-1 text-[10px] text-white" title="Tirar esta imagem" onClick={() => patch({ extra: shot.extra!.filter((_, j) => j !== k - 1) })}>
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <select className="field w-full py-1 text-xs" value="" onChange={(e) => e.target.value && patch({ extra: [...(shot.extra ?? []), { pageId: e.target.value, focus: { x0: 0, y0: 0, x1: 1, y1: 1 }, fit: 'contain', motion: 'zoom-in' }] })}>
                    <option value="">＋ Adicionar imagem durante a fala…</option>
                    {p.pages.map((x, k) => (
                      <option key={x.id} value={x.id}>
                        {x.chapter} · página {p.pages.filter((y, i) => i <= k && y.chapter === x.chapter).length}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1 rounded border p-2 text-xs">
                  <p className="font-medium">🖼 Trocar a imagem desta parte</p>
                  <p className="text-[11px] text-muted-foreground">A fala e a duração continuam iguais; só a imagem muda.</p>
                  <label className="block space-y-1">
                    <span className="text-muted-foreground">Enviar outra imagem do computador</span>
                    <input type="file" accept="image/*" disabled={running} onChange={(e) => e.target.files?.[0] && replaceImage(e.target.files[0])} />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-muted-foreground">Ou usar outra página do projeto</span>
                    <select className="field w-full py-1 text-xs" value={shot.pageId} onChange={(e) => patch({ pageId: e.target.value, focus: { x0: 0, y0: 0, x1: 1, y1: 1 }, newImage: true })}>
                      {p.pages.map((x, k) => (
                        <option key={x.id} value={x.id}>
                          {x.chapter} · página {p.pages.filter((y, i) => i <= k && y.chapter === x.chapter).length}
                        </option>
                      ))}
                    </select>
                  </label>
                  {running && <p className="text-muted-foreground">Espere o job atual terminar para enviar uma imagem.</p>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {(['contain', 'cover'] as const).map((f) => (
                    <button key={f} className={`btn px-2 py-0.5 text-xs ${(shot.fit ?? 'contain') === f ? 'border-primary' : ''}`} onClick={() => patch({ fit: f })}>
                      {f === 'contain' ? 'Encaixar' : 'Tela cheia'}
                    </button>
                  ))}
                  <button className="btn px-2 py-0.5 text-xs" onClick={() => patch({ rotate: ((shot.rotate ?? 0) + 90) % 360 })}>
                    ↻ Girar ({shot.rotate ?? 0}°)
                  </button>
                  <button className="btn px-2 py-0.5 text-xs" onClick={() => patch({ focus: { x0: 0, y0: 0, x1: 1, y1: 1 } })}>
                    Página inteira
                  </button>
                </div>
                <select className="field py-1 text-xs" value={shot.motion} onChange={(e) => patch({ motion: e.target.value as Shot['motion'] })}>
                  {Object.entries(MOTIONS).map(([k, v]) => (
                    <option key={k} value={k}>
                      Movimento: {v}
                    </option>
                  ))}
                </select>
                <select className="field py-1 text-xs" value={shot.bgBand ?? 'top'} onChange={(e) => patch({ bgBand: e.target.value as Shot['bgBand'] })}>
                  <option value="top">Fundo desfocado: topo do recorte</option>
                  <option value="bottom">Fundo desfocado: base do recorte</option>
                  <option value="full">Fundo desfocado: recorte inteiro</option>
                </select>
                {num('Esticar', shot.stretch ?? 1, (n) => patch({ stretch: n }), 0.05, 0.25, 6)}
                {num('Zoom', shot.zoom ?? 1, (n) => patch({ zoom: n }), 0.05, 0.3, 5)}
                {num('Duração', shot.duration, (n) => patch({ duration: Math.max(0.5, n) }), 0.1, 0.5, 30)}
                <div className="flex flex-wrap items-center gap-1 text-xs">
                  <span className="w-16 text-muted-foreground">Velocidade</span>
                  {SPEEDS.map((v) => (
                    <button key={v} className={`btn px-1.5 py-0.5 text-xs ${(shot.speed ?? 1) === v ? 'border-primary bg-primary/20' : ''}`} onClick={() => patch({ speed: v === 1 ? undefined : v })}>
                      {String(v).replace('.', ',')}x
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">Com voz, a parte dura no mínimo a fala.</p>
                <div className="grid grid-cols-2 gap-1">
                  <button className="btn justify-center text-xs" onClick={split} title="Divide no cursor amarelo">
                    ✂ Dividir no cursor
                  </button>
                  <button className="btn justify-center text-xs" onClick={merge} disabled={sel >= p.shots.length - 1}>
                    ⧉ Juntar com a próxima
                  </button>
                  <button className="btn justify-center text-xs" onClick={() => move(-1)} disabled={sel === 0}>
                    ← Mover antes
                  </button>
                  <button className="btn justify-center text-xs" onClick={() => move(1)} disabled={sel >= p.shots.length - 1}>
                    Mover depois →
                  </button>
                  <button className="btn justify-center text-xs" onClick={duplicate}>
                    ＋ Parte sem fala depois
                  </button>
                  <button className="btn justify-center text-xs text-destructive" onClick={remove}>
                    🗑 Apagar parte
                  </button>
                  <button className="btn col-span-2 justify-center text-xs text-destructive" onClick={removeSilent} disabled={!silentCount}>
                    🗑 Excluir todas as partes sem fala ({silentCount})
                  </button>
                </div>
              </>
            ) : tab === 'ia' ? (
              (() => {
                const f = at(Math.min(aiFrom, aiTo)) + 1;
                const t = at(Math.max(aiFrom, aiTo) - 0.01) + 1;
                const secs = (v: string) => {
                  const m = v.trim().match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
                  return m ? Number(m[1]) * 60 + Number(m[2]) : Math.max(0, Number(v) || 0);
                };
                const mmss = (x: number) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
                return (
                  <>
                    <p className="text-xs text-muted-foreground">Descreva o ajuste; a IA muda recortes, zoom, duração, apaga partes ou reescreve falas (introdução, textos) e renderiza de novo.</p>
                    <textarea className="field h-28 text-sm" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="Ex.: deixa a introdução mais impactante; corta as conversas longas; estica as cenas de ação" />
                    <div className="space-y-1 rounded border p-2 text-xs">
                      <label className="flex items-center gap-2">
                        <input type="radio" checked={aiAll} onChange={() => setAiAll(true)} /> Vídeo todo ({p.shots.length} partes)
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="radio" checked={!aiAll} onChange={() => setAiAll(false)} /> Só um trecho
                      </label>
                      {!aiAll && (
                        <div className="space-y-1 pl-5">
                          <div className="flex items-center gap-1">
                            de
                            <input key={`f${aiFrom}`} className="field px-1 py-0.5 text-xs" style={{ width: 64 }} defaultValue={mmss(aiFrom)} onBlur={(e) => setAiFrom(secs(e.target.value))} />
                            até
                            <input key={`t${aiTo}`} className="field px-1 py-0.5 text-xs" style={{ width: 64 }} defaultValue={mmss(aiTo)} onBlur={(e) => setAiTo(secs(e.target.value))} />
                          </div>
                          <div className="flex flex-wrap gap-1">
                            <button className="btn px-2 py-0.5 text-xs" onClick={() => setAiFrom(time)}>início = cursor</button>
                            <button className="btn px-2 py-0.5 text-xs" onClick={() => setAiTo(time)}>fim = cursor</button>
                            <button className="btn px-2 py-0.5 text-xs" onClick={() => { setAiFrom(0); setAiTo(120); }}>2 primeiros min</button>
                          </div>
                          <p className="text-muted-foreground">Partes {f} a {t}. A IA vê o que vem antes e depois como contexto, mas só mexe nesse trecho.</p>
                        </div>
                      )}
                    </div>
                    <button className="btn-primary w-full justify-center" disabled={running || !aiPrompt.trim()} onClick={() => start(aiAll ? { kind: 'polish', prompt: aiPrompt } : { kind: 'polish', prompt: aiPrompt, from: f, to: t })}>
                      ✨ Polir com IA e renderizar de novo
                    </button>
                    <p className="text-[11px] text-muted-foreground">Falas reescritas precisam de voz nova; o resto reaproveita a voz em cache.</p>
                  </>
                );
              })()
            ) : tab === 'aprender' ? (
              <>
                <p className="text-xs text-muted-foreground">Tudo o que você muda aqui é anotado. Depois de cada render, a IA analisa suas correções, transforma em regras para os próximos vídeos (usadas na “2 · Editar com IA”) e pergunta quando não entende o motivo.</p>
                <LearnQuestions learn={learn} post={postLearn} currentProjectId={p.id} onGoTo={(part) => goTo(part - 1)} />
                <p className="pt-1 text-xs font-medium">Regras aprendidas ({learn?.rules.length ?? 0})</p>
                {!learn?.rules.length && <p className="text-xs text-muted-foreground">Nenhuma ainda: edite e renderize que a IA começa a aprender.</p>}
                {learn?.rules.map((r, k) => (
                  <div key={k} className="flex gap-1 rounded border p-1 text-xs">
                    <span className="flex-1">{r}</span>
                    <button className="text-destructive" onClick={() => postLearn({ removeRule: k })} title="Apagar regra">
                      ×
                    </button>
                  </div>
                ))}
                <div className="flex gap-1">
                  <DictateButton onText={(t) => setNewRule((r) => `${r ? `${r} ` : ''}${t}`)} />
                  <input className="field text-xs" value={newRule} onChange={(e) => setNewRule(e.target.value)} placeholder="Ensinar uma regra (ex.: cenas de luta sempre em tela cheia)" />
                  <button className="btn px-2 text-xs" disabled={!newRule.trim()} onClick={() => postLearn({ addRule: newRule }).then(() => setNewRule(''))}>
                    +
                  </button>
                </div>
                {(learn?.questions ?? []).some((q) => q.answer) && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Suas respostas anteriores</summary>
                    {learn!.questions.filter((q) => q.answer).map((q) => (
                      <p key={q.id} className="mt-1">
                        <span className="text-muted-foreground">{q.question}</span> → {q.answer}
                      </p>
                    ))}
                  </details>
                )}
              </>
            ) : tab === 'texto' ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Fala da parte {sel + 1} ({fmt(item?.start ?? 0)}). Mudar o texto exige gerar voz nova para esta fala.
                </p>
                <textarea className="field h-48 text-sm" value={shot.text} onChange={(e) => patch({ text: e.target.value })} />
                <div className="space-y-1">
                  <p className="text-xs font-medium">Trechos cortados desta fala</p>
                  {!(shot.audioCuts ?? []).length && <p className="text-xs text-muted-foreground">Nenhum. Arraste sobre a fala na trilha Narração para selecionar um trecho e cortar.</p>}
                  {(shot.audioCuts ?? []).map(([a, b], k) => (
                    <div key={k} className="flex items-center gap-2 text-xs">
                      <button className="underline" onClick={() => item && seek(item.start + Math.max(0, r2e(item, item.rendered ? toRendered(a, item.cuts) / item.gs : a) - 0.5), false)}>
                        {a.toFixed(2)}s – {b.toFixed(2)}s
                      </button>
                      <span className="text-muted-foreground">({(b - a).toFixed(2)} s)</span>
                      <button className="ml-auto text-destructive" onClick={() => edit((d) => (d.shots[sel].audioCuts = d.shots[sel].audioCuts?.filter((_, x) => x !== k)))}>
                        desfazer corte
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">Envie uma imagem (entra inteira, 3 s, sem fala) ou repita a página desta parte.</p>
                {(
                  [
                    ['No começo', 0],
                    [`Antes da parte ${sel + 1}`, sel],
                    [`Depois da parte ${sel + 1}`, sel + 1],
                    ['No fim', p.shots.length],
                  ] as const
                ).map(([label, pos]) => (
                  <label key={label} className="block space-y-1 rounded border p-2 text-xs">
                    <span>{label}</span>
                    <input type="file" accept="image/*" disabled={running} onChange={(e) => e.target.files?.[0] && insertImage(e.target.files[0], pos)} />
                  </label>
                ))}
                {running && <p className="text-xs text-muted-foreground">Espere o job atual terminar para inserir.</p>}
              </>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-black/40 p-2">
          {p.lastRender ? (
            <>
              <div ref={stage} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
                {shot && !playing && (
                  <span className="pointer-events-none absolute left-1 top-1 z-30 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-amber-300">
                    Editando a parte {sel + 1}{nViews > 1 ? ` · imagem ${viewIdx + 1} de ${nViews} desta fala` : ''}
                  </span>
                )}
                {shot && !playing && (
                  <div
                    className="absolute inset-0 z-20 cursor-grab touch-none active:cursor-grabbing"
                    title="Arraste para mostrar outra parte da imagem · Ctrl + rolagem para aproximar · clique para tocar"
                    onPointerDown={(e) => {
                      (e.currentTarget as Element).setPointerCapture(e.pointerId);
                      dragRef.current = { x: e.clientX, y: e.clientY, moved: false, focus: (curView ?? shot).focus };
                    }}
                    onPointerMove={(e) => {
                      const d = dragRef.current;
                      if (!d || !e.buttons) return;
                      const dx = e.clientX - d.x, dy = e.clientY - d.y;
                      if (!d.moved && Math.hypot(dx, dy) < 4) return;
                      d.moved = true;
                      setAdjusting(true);
                      const r = e.currentTarget.getBoundingClientRect();
                      const f = d.focus, fw = f.x1 - f.x0, fh = f.y1 - f.y0;
                      // a mão "puxa" a imagem: arrastar para a direita mostra o que está à esquerda na página
                      const x0 = Math.max(0, Math.min(1 - fw, f.x0 - (dx / r.width) * fw));
                      const y0 = Math.max(0, Math.min(1 - fh, f.y0 - (dy / r.height) * fh));
                      patchView({ focus: { x0, y0, x1: x0 + fw, y1: y0 + fh } });
                    }}
                    onPointerUp={() => {
                      const d = dragRef.current;
                      dragRef.current = null;
                      if (d && !d.moved) {
                        setAdjusting(false);
                        togglePlay();
                      }
                    }}
                  />
                )}
                {shot && !playing && adjusting && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black">
                    <div style={{ width: Math.min(stageSize.w, stageSize.h * (p.format === 'vertical' ? 9 / 16 : 16 / 9)) }}>
                      <Preview projectId={p.id} format={p.format} shots={viewIdx > 0 && curView ? p.shots.map((x, j) => (j === sel ? { ...x, ...curView } : x)) : p.shots} pages={p.pages} selected={sel} onSelect={setSel} subtitles={!!p.subtitles} onEditShot={patchView} hideControls />
                    </div>
                    <p className="absolute bottom-1 rounded bg-black/70 px-2 py-0.5 text-[11px] text-amber-300">✋ Ajustando a parte {sel + 1}: arraste para mover · Ctrl + rolagem: zoom · Shift + rolagem: recorte mais alto · Alt + rolagem: mais largo · clique ou ▶ Tocar volta ao vídeo</p>
                  </div>
                )}
                {shot?.newImage && !playing && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 overflow-hidden bg-black p-2">
                    {pg && <img src={pageUrl(p.id, pg)} alt="Imagem nova da parte" className="h-[calc(100%-2rem)] max-w-full rounded object-contain" />}
                    <p className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">🖼 Imagem nova desta parte: entra no vídeo quando você renderizar de novo</p>
                  </div>
                )}
                <video
                  ref={video}
                  key={p.lastRender.at}
                  src={`/api/file?project=${p.id}&video=1&v=${encodeURIComponent(p.lastRender.at)}`}
                  className="max-h-full max-w-full cursor-pointer rounded bg-black"
                  onClick={togglePlay}
                  onPlay={() => {
                    setPlaying(true);
                    setAdjusting(false);
                  }}
                  onPause={() => setPlaying(false)}
                  onSeeked={() => {
                    if (ownSeek.current) ownSeek.current = false;
                    else if (video.current?.paused) onVideoTick();
                  }}
                />
              </div>
              {/* barra do tempo do vídeo (tempo já editado): clique ou arraste para ir a qualquer ponto */}
              <input type="range" min={0} max={Math.max(0.1, total)} step={0.1} value={Math.min(time, total)} onChange={(e) => seek(Number(e.target.value))} className="mt-2 w-full accent-amber-400" title="Arraste para ir a qualquer ponto do vídeo" />
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                <button className="btn px-2 py-0.5" onClick={() => seek(0)} title="Voltar ao início">⏮</button>
                <button className="btn px-2 py-0.5" onClick={() => goTo(Math.max(0, sel - 1))} title="Parte anterior">⏪ parte</button>
                <button className="btn px-2 py-0.5" onClick={() => seek(time - 5)} title="Voltar 5 s">−5s</button>
                <button className="btn px-2 py-0.5" onClick={() => seek(time - 1)} title="Voltar 1 s">−1s</button>
                <button className="btn px-2 py-0.5" onClick={() => seek(time - 0.5)} title="Voltar meio segundo">−0,5s</button>
                <button className="btn-primary px-4" onClick={togglePlay} title="Espaço">
                  {playing ? '❚❚ Pausar' : '▶ Tocar'}
                </button>
                <button className="btn px-2 py-0.5" onClick={() => seek(time + 0.5)} title="Avançar meio segundo">+0,5s</button>
                <button className="btn px-2 py-0.5" onClick={() => seek(time + 1)} title="Avançar 1 s">+1s</button>
                <button className="btn px-2 py-0.5" onClick={() => seek(time + 5)} title="Avançar 5 s">+5s</button>
                <button className="btn px-2 py-0.5" onClick={() => goTo(Math.min(p.shots.length - 1, sel + 1))} title="Próxima parte">parte ⏩</button>
                <button className="btn px-2 py-0.5" onClick={() => seek(total - 0.5)} title="Ir para o fim">⏭</button>
                <span className="font-mono">
                  {fmtClock(time, true)} / {fmtDuration(total)}
                </span>
                <span className="ml-auto text-muted-foreground">Ver em:</span>
                {SPEEDS.map((v) => (
                  <button key={v} className={`rounded px-1.5 py-0.5 ${viewRate === v ? 'bg-primary text-primary-foreground' : 'border hover:bg-muted'}`} onClick={() => setViewRate(v)} title="Velocidade só para assistir (não muda o vídeo)">
                    {String(v).replace('.', ',')}x
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">Prévia com as edições (cortes, partes apagadas, velocidade) sobre o último render; partes novas só aparecem depois de renderizar.</p>
            </>
          ) : (
            <p className="m-auto text-muted-foreground">Ainda não renderizado: clique em Renderizar vídeo.</p>
          )}
        </section>

      </div>

      {/* linha do tempo */}
      <div className="flex h-[290px] shrink-0 flex-col rounded-lg border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1 text-xs">
          <span className="font-medium">Linha do tempo</span>
          <span className="text-muted-foreground">{fmtClock(time, true)} / {fmtDuration(total)}</span>
          <span className="text-muted-foreground">· clique na régua para ir ao ponto · arraste sobre a fala para cortar um trecho · clique na fala para ver o texto</span>
          <label className="ml-auto flex items-center gap-1">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> seguir o vídeo
          </label>
          <span>Mostrar</span>
          {SPANS.map((sec) => (
            <button key={sec} className={`btn px-1.5 py-0.5 text-xs ${Math.abs(pps - Math.max(0.5, (scroll.width - 20) / sec)) < 0.5 ? 'border-primary bg-primary/20' : ''}`} onClick={() => zoomTo(Math.max(0.5, (scroll.width - 20) / sec))}>
              {sec < 60 ? `${sec}s` : `${sec / 60}min`}
            </button>
          ))}
          <button className="btn px-1.5 py-0.5 text-xs" onClick={() => zoomTo(Math.max(0.5, (scroll.width - 20) / Math.max(1, total)))}>
            tudo
          </button>
          <span>Zoom</span>
          <input type="range" min={0.5} max={80} step={0.5} value={pps} onChange={(e) => zoomTo(Number(e.target.value))} className="w-32" />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1 text-xs">
          <span>Filtro por palavra:</span>
          <input
            className="field px-2 py-0.5 text-xs" style={{ width: 160 }}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setHit(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches.length) {
                const n = (hit + 1) % matches.length;
                setHit(n);
                goTo(matches[n]);
              }
            }}
            placeholder="ex.: cara"
          />
          {filter.trim() && (
            <>
              <span className="text-muted-foreground">{matches.length} fala(s)</span>
              <button className="btn px-2 py-0.5 text-xs" disabled={!matches.length} onClick={() => { const n = (hit - 1 + matches.length) % matches.length; setHit(n); goTo(matches[n]); }}>
                ‹
              </button>
              <button className="btn px-2 py-0.5 text-xs" disabled={!matches.length} onClick={() => { const n = (hit + 1) % matches.length; setHit(n); goTo(matches[n]); }}>
                ›
              </button>
              <button className="btn px-2 py-0.5 text-xs" disabled={!matches.length || filter.trim().includes(' ')} onClick={cutWordEverywhere} title="Corta a palavra do áudio em todas as falas no próximo render (Whisper acha o tempo exato; não gasta voz)">
                ✂ Cortar “{filter.trim()}” em todas ({matches.length})
              </button>
            </>
          )}
          {(p.cutWords ?? []).length > 0 && (
            <span className="flex items-center gap-1">
              Cortadas no render:
              {(p.cutWords ?? []).map((w) => (
                <span key={w} className="rounded bg-destructive/30 px-1.5">
                  {w}{' '}
                  <button onClick={() => edit((d) => (d.cutWords = (d.cutWords ?? []).filter((x) => x !== w)), false)} title="Parar de cortar">
                    ×
                  </button>
                </span>
              ))}
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-1 rounded border px-2 py-0.5">
            <span className="font-medium">Corte:</span> início
            <input key={`ci${aiFrom}`} className="field px-1 py-0.5 text-xs" style={{ width: 70 }} defaultValue={fmt(aiFrom)} onBlur={(e) => setAiFrom(parseTime(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} title="mm:ss (ex.: 0:01) ou segundos (ex.: 1)" />
            <button className="btn px-1.5 py-0.5 text-xs" onClick={() => setAiFrom(time)} title="Início do corte = cursor amarelo">
              ⇤ cursor
            </button>
            fim
            <input key={`cf${aiTo}`} className="field px-1 py-0.5 text-xs" style={{ width: 70 }} defaultValue={fmt(aiTo)} onBlur={(e) => setAiTo(parseTime(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} title="mm:ss (ex.: 0:05) ou segundos (ex.: 5)" />
            <button className="btn px-1.5 py-0.5 text-xs" onClick={() => setAiTo(time)} title="Fim do corte = cursor amarelo">
              cursor ⇥
            </button>
            <button className="btn px-1.5 py-0.5 text-xs" onClick={() => { seek(Math.min(aiFrom, aiTo), false); video.current?.play(); setTimeout(() => video.current?.pause(), Math.abs(aiTo - aiFrom) * 1000 + 50); }} title="Toca o trecho marcado no vídeo final">
              ▶
            </button>
            <button className="btn-primary px-2 py-0.5 text-xs" onClick={deleteRange} title="Tira do vídeo o pedaço entre início e fim">
              ✂ Cortar {(Math.abs(aiTo - aiFrom)).toFixed(1)} s
            </button>
          </span>
          <span className="flex flex-wrap items-center gap-1 rounded border border-amber-400/60 px-2 py-0.5">
            <span className="font-medium">Acelerar:</span> início
            <input key={`si${spFrom}`} className="field px-1 py-0.5 text-xs" style={{ width: 70 }} defaultValue={fmt(spFrom)} onBlur={(e) => setSpFrom(parseTime(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} title="mm:ss (ex.: 1:30) ou segundos" />
            <button className="btn px-1.5 py-0.5 text-xs" onClick={() => setSpFrom(time)} title="Início = cursor amarelo">
              ⇤ cursor
            </button>
            fim
            <input key={`sf${spTo}`} className="field px-1 py-0.5 text-xs" style={{ width: 70 }} defaultValue={fmt(spTo)} onBlur={(e) => setSpTo(parseTime(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} title="mm:ss (ex.: 2:00) ou segundos" />
            <button className="btn px-1.5 py-0.5 text-xs" onClick={() => setSpTo(time)} title="Fim = cursor amarelo">
              cursor ⇥
            </button>
            <span className="text-muted-foreground">velocidade:</span>
            {SPEEDS.map((v) => (
              <button key={v} className={`px-1.5 py-0.5 text-xs ${v === 1 ? 'btn' : 'btn-primary'}`} onClick={() => speedRange(v)} title={v === 1 ? 'Volta ao normal' : `Deixa o trecho ${v}x`}>
                {String(v).replace('.', ',')}x
              </button>
            ))}
          </span>
          <span className="flex flex-wrap items-center gap-1 rounded border border-primary/40 px-2 py-1">
            <span className="font-medium">Vídeo todo:</span>
            {(() => {
              const sp = new Set(p.shots.map((s) => s.speed ?? 1));
              return <span className="text-muted-foreground">agora {sp.size === 1 ? `${String([...sp][0]).replace('.', ',')}x` : 'velocidades mistas'}</span>;
            })()}
            <input
              key={`all${p.shots[0]?.speed ?? 1}`}
              className="field px-1 py-0.5 text-xs"
              style={{ width: 60 }}
              defaultValue={String(p.shots[0]?.speed ?? 1).replace('.', ',')}
              onKeyDown={(e) => e.key === 'Enter' && speedAll(Number((e.target as HTMLInputElement).value.replace(',', '.')))}
              id="speed-all"
              title="Qualquer valor de 0,25 a 4 (ex.: 1,4). Enter aplica."
            />
            <button className="btn-primary px-2 py-0.5 text-xs" onClick={() => speedAll(Number((document.getElementById('speed-all') as HTMLInputElement).value.replace(',', '.')))}>
              Aplicar no vídeo todo
            </button>
            <button className="btn px-2 py-0.5 text-xs" onClick={() => speedAll(1)} title="Tudo na velocidade normal">
              Normal (1x)
            </button>
          </span>
          {range && (
            <span className="flex items-center gap-1 rounded bg-primary/20 px-2 py-0.5">
              Trecho da parte {range.i + 1}: {(range.b - range.a).toFixed(2)} s
              <button className="btn px-2 py-0.5 text-xs" onClick={() => { seek(range.a, false); video.current?.play(); setTimeout(() => video.current?.pause(), (range.b - range.a) * 1000 + 50); }}>
                ▶ Ouvir
              </button>
              <button className="btn-primary px-2 py-0.5 text-xs" onClick={cutRange}>
                ✂ Cortar trecho
              </button>
              <button className="btn px-2 py-0.5 text-xs" onClick={() => setRange(null)}>
                ×
              </button>
            </span>
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="shrink-0 border-r text-xs text-muted-foreground" style={{ width: LABEL_W }}>
            <div className="h-6 border-b" />
            {['Vídeo', 'Narração', 'Cortes', 'Imagens'].map((l) => (
              <div key={l} className="flex items-center border-b px-2" style={{ height: TRACK_H }}>
                {l}
              </div>
            ))}
          </div>
          <div ref={tl} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden" data-testid="timeline">
            <div className="relative" style={{ width, height: 24 + TRACK_H * 4 }}>
              {/* régua */}
              <div className="absolute inset-x-0 top-0 h-6 cursor-pointer border-b" onPointerDown={(e) => seek(timeAtX(e))}>
                {ticks.map((t) => (
                  <div key={t} className="pointer-events-none absolute top-0 h-full border-l pl-1 text-[10px] text-muted-foreground" style={{ left: t * pps }}>
                    {t >= 3600 ? `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60) || t % 60 ? `${Math.floor((t % 3600) / 60)}m` : ''}${t % 60 ? `${t % 60}s` : ''}` : t >= 60 ? `${Math.floor(t / 60)}m${t % 60 ? `${t % 60}s` : ''}` : `${t}s`}
                  </div>
                ))}
              </div>
              <div className="pointer-events-none absolute top-0 h-6 border-x border-sky-400 bg-sky-400/20" style={{ left: Math.min(aiFrom, aiTo) * pps, width: Math.max(2, Math.abs(aiTo - aiFrom) * pps) }} />
              {spTo !== spFrom && <div className="pointer-events-none absolute top-3 h-3 border-x border-amber-400 bg-amber-400/40" style={{ left: Math.min(spFrom, spTo) * pps, width: Math.max(2, Math.abs(spTo - spFrom) * pps) }} />}
              {/* vídeo / partes */}
              <div className="absolute inset-x-0 border-b" style={{ top: 24, height: TRACK_H }}>
                {vis.map((it) => {
                  const w = Math.max(1, it.dur * pps - 1);
                  const page = w > 40 ? pageById.get(it.shot.pageId) : undefined;
                  return (
                    <button
                      key={it.shot.id}
                      className={`absolute top-0.5 flex h-[30px] items-center gap-1 overflow-hidden rounded-sm border px-0.5 text-left text-[10px] ${it.i === sel ? 'border-primary bg-primary/40' : it.rendered ? 'bg-violet-900/70' : 'border-dashed bg-violet-900/40'}`}
                      style={{ left: it.start * pps, width: w }}
                      onClick={() => {
                        setSel(it.i);
                        setTab('parte');
                        seek(it.start + 0.01, false);
                      }}
                      title={`Parte ${it.i + 1} · ${it.dur.toFixed(1)} s${it.rendered ? '' : ' · não renderizada'}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {page && <img src={pageUrl(p.id, page, 96)} alt="" loading="lazy" decoding="async" className="h-6 w-5 shrink-0 rounded-sm object-cover" />}
                      {w > 24 && <span className="truncate">{it.i + 1}</span>}
                      {it.shot.speed && it.shot.speed !== 1 && <span className="rounded bg-amber-400 px-0.5 text-black">{String(it.shot.speed).replace('.', ',')}x</span>}
                    </button>
                  );
                })}
              </div>
              {/* narração: uma fala por bloco; arrastar seleciona um trecho */}
              <div className="absolute inset-x-0 cursor-text border-b" style={{ top: 24 + TRACK_H, height: TRACK_H }} onPointerDown={narrDown} onPointerMove={narrMove} onPointerUp={narrUp}>
                {vis.map((it) =>
                  it.shot.text.trim() ? (
                    <div
                      key={it.shot.id}
                      className={`pointer-events-none absolute top-0.5 h-[30px] overflow-hidden rounded-sm border px-1 text-[10px] leading-[14px] ${matchSet.has(it.i) ? 'border-amber-300 bg-amber-500/60 text-black' : it.i === sel ? 'border-primary bg-sky-700/70' : 'bg-sky-900/60'}`}
                      style={{ left: it.start * pps, width: Math.max(1, it.dur * pps - 1) }}
                      title={it.shot.text}
                    >
                      {it.dur * pps > 30 && it.shot.text}
                    </div>
                  ) : null,
                )}
                {range && <div className="pointer-events-none absolute top-0 h-full bg-red-500/40 ring-1 ring-red-400" style={{ left: Math.min(range.a, range.b) * pps, width: Math.max(1, Math.abs(range.b - range.a) * pps) }} />}
              </div>
              {/* cortes */}
              <div className="absolute inset-x-0 border-b" style={{ top: 24 + TRACK_H * 2, height: TRACK_H }}>
                {vis.flatMap((it) =>
                  (it.shot.audioCuts ?? []).map(([a, b], k) => {
                    const done = it.cuts.some(([x, y]) => x === a && y === b);
                    const x = it.start + (it.rendered ? r2e(it, toRendered(a, it.cuts) / it.gs) : a / (it.shot.speed ?? 1));
                    const w = 4;
                    return (
                      <button
                        key={`${it.shot.id}-${k}`}
                        className={`absolute top-1 h-[26px] rounded-sm ${done ? 'bg-red-500' : 'bg-red-400 ring-1 ring-white/60'}`}
                        style={{ left: x * pps, width: w }}
                        title={`Parte ${it.i + 1}: corte ${a.toFixed(2)}–${b.toFixed(2)} s${done ? ' (já aplicado no vídeo)' : ' (a prévia já pula; entra no vídeo no próximo render)'} · clique para desfazer`}
                        onClick={() => edit((d) => (d.shots[it.i].audioCuts = d.shots[it.i].audioCuts?.filter((_, z) => z !== k)))}
                      />
                    );
                  }),
                )}
                {(p.cutWords ?? []).length > 0 &&
                  vis
                    .filter((it) => (p.cutWords ?? []).some((w) => ` ${norm(it.shot.text)} `.includes(` ${norm(w)} `)))
                    .map((it) => (
                      <div key={`w-${it.shot.id}`} className="pointer-events-none absolute bottom-0.5 h-1.5 rounded-sm bg-amber-400" style={{ left: it.start * pps, width: Math.max(2, it.dur * pps - 1) }} title="Palavra cortada no render" />
                    ))}
              </div>
              {/* imagens (partes sem fala) */}
              <div className="absolute inset-x-0 border-b" style={{ top: 24 + TRACK_H * 3, height: TRACK_H }}>
                {vis
                  .filter((it) => !it.shot.text.trim())
                  .map((it) => (
                    <button key={it.shot.id} className={`absolute top-0.5 h-[30px] rounded-sm border text-[10px] ${it.i === sel ? 'border-primary bg-emerald-600/60' : 'bg-emerald-900/60'}`} style={{ left: it.start * pps, width: Math.max(2, it.dur * pps - 1) }} onClick={() => goTo(it.i)} title={`Parte ${it.i + 1} sem fala`}>
                      {it.dur * pps > 40 && 'imagem'}
                    </button>
                  ))}
              </div>
              {/* playhead */}
              <div className="pointer-events-none absolute top-0 w-0.5 bg-amber-400" style={{ left: time * pps, height: 24 + TRACK_H * 4 }}>
                <div className="absolute -left-1.5 -top-0.5 size-3.5 rounded-full bg-amber-400" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}
