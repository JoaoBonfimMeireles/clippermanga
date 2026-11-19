'use client';
// Estúdio do projeto: importar páginas → montar a linha do tempo (ordem, duração, foco, movimento, texto)
// com a prévia ao lado → escolher a narração → gerar roteiro pela IA (opcional) → renderizar.
import { LastRenderInfo } from './last-render';
import { PaidAsk } from './paid-ask';
import { useStickBottom } from './use-stick-bottom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MANGA_SIZES, type MangaFormat } from '@clipper/shared';
import { FULL, jobEta, quotaFromLogs, quotaText, MOTIONS, type JobInfo, type Motion, type Rect, type Shot, type StudioPage, type StudioProject } from '@/lib/types';
import { expandChapters, hasVar, numbersIn, parseRange } from '@/lib/ranges';
import { addPagesToTimeline, buildTimeline, chapterNum, chaptersInOrder } from '@/lib/timeline';
import { DEFAULT_VOICE } from '@/lib/voices';
import { needsPanelCrops } from '@/lib/crop-guard';
import { VoicePicker } from './voice-picker';
import { FocusEditor } from './focus-editor';
import { DoubtsModal, useQueuedDoubts } from './doubts-modal';
import { baseOf, shotsDelta, type ShotsBase } from '@/lib/shots-merge';
import { ImportPause } from './import-pause';
import { pageUrl, Preview } from './preview';
import { fmtDuration } from '@/lib/duration';

const fmtTime = (t: number) => fmtDuration(t);
const srtT = (t: number) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const z = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${z(Math.floor(ms / 3600000))}:${z(Math.floor(ms / 60000) % 60)}:${z(Math.floor(ms / 1000) % 60)},${z(ms % 1000, 3)}`;
};
/** Baixa o roteiro em inglês (txt) ou a legenda (srt, com os tempos do último render em português). */
/** Nome do passo + posição na ordem 1 roteiro → 2 edição → 3 validação → 4 render. */
const STEP_NO: Record<string, number> = { script: 1, edit: 2, check: 3, render: 4 };
const JOB_NAMES: Record<string, string> = { test: 'Teste finalizado', import: 'Importar', script: 'Roteiro', edit: 'Edição', check: 'Validação', render: 'Render', context: 'Resumos', polish: 'Polir', publish: 'Publicação', subs: 'Legendas', shorts: 'Shorts', english: 'Inglês' };
const jobLabel = (kind: string) => `${JOB_NAMES[kind] ?? kind}${STEP_NO[kind] ? ` (${STEP_NO[kind]}/4)` : ''}`;

function dl(p: StudioProject, kind: 'txt' | 'srt') {
  const en = p.englishTexts ?? {};
  let out = '';
  if (kind === 'txt') out = p.shots.map((s) => en[s.id]).filter(Boolean).join('\n\n') + '\n';
  else {
    let n = 0;
    for (const g of p.lastRender?.segments ?? []) {
      const text = en[g.id];
      if (!text) continue;
      const w = text.split(/\s+/).filter(Boolean);
      const cs: string[] = [];
      for (let i = 0; i < w.length; i += 7) cs.push(w.slice(i, i + 7).join(' '));
      const tot = cs.reduce((a, c) => a + c.length, 0) || 1;
      let t = g.start;
      for (const c of cs) {
        const d = (c.length / tot) * g.dur;
        out += `${++n}\n${srtT(t)} --> ${srtT(t + d - 0.02)}\n${c}\n\n`;
        t += d;
      }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([out], { type: 'text/plain;charset=utf-8' }));
  a.download = `${p.title || 'manga'}_EN.${kind}`;
  a.click();
  URL.revokeObjectURL(a.href);
}
const uid =() => Math.random().toString(36).slice(2, 10);

/** Aproxima (k < 1) ou afasta (k > 1) o foco em volta do centro dele, sem sair da página. */
function zoomRect(r: Rect, k: number): Rect {
  const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
  const w = Math.min(1, Math.max(0.05, (r.x1 - r.x0) * k)), h = Math.min(1, Math.max(0.05, (r.y1 - r.y0) * k));
  const x0 = Math.min(1 - w, Math.max(0, cx - w / 2)), y0 = Math.min(1 - h, Math.max(0, cy - h / 2));
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

export function Studio({ id }: { id: string }) {
  const [p, setP] = useState<StudioProject | null>(null);
  const [sel, setSel] = useState(0);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [url, setUrl] = useState('');
  // o último link baixado neste projeto já vem preenchido
  const savedUrl = p?.lastImportUrl ?? '';
  useEffect(() => {
    if (savedUrl) setUrl((u) => u || savedUrl);
  }, [savedUrl]);
  const [html, setHtml] = useState('');
  const [chapter, setChapter] = useState('');
  const [chapterSeq, setChapterSeq] = useState('');
  const [pageSeq, setPageSeq] = useState('');
  // capítulos de teste do lote (0 = sem teste); null = padrão: 1 quando o lote tem mais de um capítulo
  const [testSel, setTestSel] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'edit' | 'pages'>('edit');
  const dirty = useRef(false);
  const finalVideo = useRef<HTMLVideoElement>(null);
  const [videoTime, setVideoTime] = useState(0);
  const [polishPrompt, setPolishPrompt] = useState('');
  const [ctxSaved, setCtxSaved] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const [loadError, setLoadError] = useState('');

  // retrato das partes como o servidor as conhece: o salvamento manda só o que mudou em relação a ele (lib/shots-merge.ts)
  const base = useRef<ShotsBase | null>(null);
  const load = useCallback(async () => {
    // servidor ocupado ou arquivo sendo gravado: resposta vazia/erro não derruba a tela, tenta de novo (até ~30 s)
    for (let i = 0; i < 12; i++) {
      try {
        const r = await fetch(`/api/projects/${id}`);
        if (r.status === 404) return setLoadError('Projeto não encontrado.');
        if (r.ok) {
          const j = (await r.json()) as StudioProject;
          base.current = baseOf(j.shots ?? []);
          partKey.current = `${j.part?.number ?? 0}`;
          setLoadError('');
          return setP(j);
        }
      } catch {
        /* resposta cortada: tenta de novo */
      }
      await new Promise((res) => setTimeout(res, Math.min(4000, 500 * (i + 1))));
    }
    setLoadError('O servidor não respondeu. Ele pode estar ocupado com um processo pesado: tente de novo em instantes.');
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const partKey = useRef<string | null>(null);
  const save = useCallback(async (cur: StudioProject) => {
    dirty.current = false;
    const r = await fetch(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify({ title: cur.title, context: cur.context, format: cur.format, narration: cur.narration, voice: cur.voice, subtitles: !!cur.subtitles, chapterContexts: cur.chapterContexts, shots: cur.shots, ...shotsDelta(base.current, cur.shots), cutWords: cur.cutWords, targetMinutes: cur.targetMinutes ?? 0, englishAudio: !!cur.englishAudio, autoPaid: !!cur.autoPaid, series: cur.series ?? '', part: cur.part?.number ? { number: cur.part.number, recapUrl: cur.part.recapUrl ?? '' } : null }) });
    if (r.ok) base.current = baseOf(cur.shots);
    // número da parte mudou: o servidor pôs ou tirou as partes de gancho da linha do tempo, então recarrega
    const pk = `${cur.part?.number ?? 0}`;
    if (r.ok && pk !== partKey.current) {
      const first = partKey.current === null;
      partKey.current = pk;
      if (!first) void load();
    }
  }, [id, load]);

  // projeto com páginas e linha do tempo vazia: monta sozinha, em ordem cronológica
  useEffect(() => {
    if (p && !p.shots.length && p.pages.length && !jobs.some((j) => j.status === 'running')) edit((d) => (d.shots = buildTimeline(d)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.pages.length, p?.shots.length]);

  // salva 600 ms depois da última mudança
  useEffect(() => {
    if (!p || !dirty.current) return;
    const t = setTimeout(() => save(p), 600);
    return () => clearTimeout(t);
  }, [p, save]);

  // cada tecla no texto passava por structuredClone do projeto inteiro (centenas de páginas e partes);
  // as edições só mexem nas partes, nos resumos e em campos simples, então basta copiar esses níveis
  const edit = (fn: (d: StudioProject) => void) =>
    setP((cur) => {
      if (!cur) return cur;
      const d: StudioProject = { ...cur, shots: cur.shots.map((s) => ({ ...s })), chapterContexts: cur.chapterContexts && { ...cur.chapterContexts } };
      fn(d);
      dirty.current = true;
      return d;
    });
  const editShot = (i: number, patch: Partial<Shot>) => edit((d) => Object.assign(d.shots[i], patch));

  // ao abrir/recarregar a página, retoma os jobs que o servidor já está rodando (eles não param com o recarregamento)
  useEffect(() => {
    fetch(`/api/projects/${id}/jobs`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: JobInfo[]) => setJobs((cur) => (cur.length ? cur : list)))
      .catch(() => {});
  }, [id]);

  // acompanha jobs em andamento; quando um termina, recarrega o projeto (páginas novas, textos, vídeo)
  const running = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const list = (await (await fetch(`/api/projects/${id}/jobs`)).json()) as JobInfo[];
        setJobs(list);
        if (!list.some((j) => j.status === 'running')) await load();
      } catch {
        /* servidor ocupado: tenta de novo no próximo ciclo */
      }
    }, 800);
    return () => clearInterval(t);
  }, [running, id, load]);

  // modo automático: o passo terminou bem → emenda o próximo (roteiro → edição → validação → render).
  // Fica num efeito sobre `jobs` (não no intervalo) e a cadeia sobrevive a recarregar a página.
  useEffect(() => {
    if (!chain.current) {
      try {
        const raw = sessionStorage.getItem(`chain:${id}`);
        if (raw && jobs.length) chain.current = JSON.parse(raw);
      } catch {
        /* sem storage */
      }
    }
    const a = chain.current;
    if (!a) return;
    const done = jobs.find((j) => j.id === a.jobId);
    if (!done || done.status === 'running') return;
    chain.current = null;
    try {
      sessionStorage.removeItem(`chain:${id}`);
    } catch {
      /* sem storage */
    }
    const next = NEXT[a.kind];
    const forced = a.kind === 'check' && forceRender.current;
    forceRender.current = false;
    if (done.status === 'done' && next && (forced || (a.kind === 'render' ? englishRef.current : autoRef.current))) {
      load().then(() => startRef.current?.({ kind: next }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

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

  // dúvidas da IA nos recortes (fim do passo 2): abre sozinho quando chegam novas
  const [doubtsOpen, setDoubtsOpen] = useState(false);
  const doubtKey = (p?.doubts ?? []).map((d) => d.id).join(',');
  // as dúvidas só aparecem depois da validação com IA (passo 3) terminar depois da última edição
  const lastDone = (k: string) => Math.max(0, ...jobs.filter((j) => j.kind === k && j.status === 'done').map((j) => j.endedAt ?? 0));
  const validated = lastDone('check') > 0 && lastDone('check') >= Math.max(lastDone('edit'), lastDone('script'));
  useEffect(() => {
    if (doubtKey && validated && !running) setDoubtsOpen(true);
  }, [doubtKey, validated, running]);
  const [auto, setAuto] = useState(false);
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const englishRef = useRef(false);
  englishRef.current = !!p?.englishAudio;
  const forceRender = useRef(false);
  const chain = useRef<{ jobId: string; kind: string } | null>(null);
  const startRef = useRef<((b: object) => Promise<void>) | null>(null);

  const start = async (body: object | FormData) => {
    setErr('');
    if (p && dirty.current) await save(p);
    const r = await fetch(`/api/projects/${id}/jobs`, body instanceof FormData ? { method: 'POST', body } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    if (!r.ok) return setErr(await r.text());
    const j = (await r.json()) as JobInfo;
    const kind = !(body instanceof FormData) && (body as { kind?: string }).kind;
    chain.current = kind && NEXT[kind] ? { jobId: j.id, kind } : null;
    try {
      if (chain.current) sessionStorage.setItem(`chain:${id}`, JSON.stringify(chain.current));
      else sessionStorage.removeItem(`chain:${id}`);
    } catch {
      /* sem storage */
    }
    setJobs((cur) => [...cur.filter((x) => x.id !== j.id), j]);
  };
  startRef.current = start;

  const addIntro = (f: File) => {
    const fd = new FormData();
    fd.append('files', f);
    fd.append('chapter', 'Abertura');
    fd.append('intro', '1');
    start(fd);
  };

  const pageById = useMemo(() => new Map((p?.pages ?? []).map((x) => [x.id, x])), [p?.pages]);
  const segById = useMemo(() => new Map((p?.lastRender?.segments ?? []).map((g) => [g.id, g])), [p?.lastRender]);

  const dq = useQueuedDoubts(p, running, async (_, render) => {
    await load();
    if (render) {
      if (stepDone('check')) start({ kind: 'render', cacheOnly: true });
      else {
        forceRender.current = true; // a validação é obrigatória antes do render
        start({ kind: 'check' });
      }
    }
  });
  if (!p)
    return loadError ? (
      <div className="space-y-2">
        <p className="text-destructive">{loadError}</p>
        <button className="btn" onClick={() => { setLoadError(''); void load(); }}>Tentar de novo</button>
      </div>
    ) : (
      <p className="text-muted-foreground">Carregando…</p>
    );
  const segs = p.lastRender?.segments ?? [];
  const playingId = segs.find((g) => videoTime >= g.start && videoTime < g.start + g.dur)?.id;
  const seekTo = (shotId: string) => {
    const g = segs.find((x) => x.id === shotId);
    if (g && finalVideo.current) finalVideo.current.currentTime = g.start + 0.01;
  };
  const shot = p.shots[sel];
  const shotPage = shot && p.pages.find((x) => x.id === shot.pageId);
  // clicar numa página: entra na linha do tempo no lugar cronológico e abre no editor
  const addShot = (pageId: string) => {
    const pg = p.pages.find((x) => x.id === pageId)!;
    const d = structuredClone(p);
    addPagesToTimeline(d, [pg]);
    const idx = d.shots.findLastIndex((s) => s.pageId === pageId);
    edit((cur) => (cur.shots = d.shots));
    setSel(idx);
    setTab('edit');
  };
  const rebuild = () => {
    edit((d) => (d.shots = buildTimeline(d)));
    setSel(0);
    setTab('edit');
  };
  const chapters = [...new Set(p.pages.map((x) => x.chapter))];
  let plan: { list: ReturnType<typeof expandChapters>; pages: number[]; error: string } = { list: [], pages: [], error: '' };
  try {
    plan = { list: expandChapters(url, chapterSeq, chapter, (i) => `Capítulo ${chapters.length + i + 1}`), pages: parseRange(pageSeq), error: '' };
  } catch (e) {
    plan.error = (e as Error).message;
  }
  const firstLine = url.split(/\r?\n/)[0] ?? '';
  const markVar = (a: number, b: number) => setUrl(firstLine.slice(0, a) + '{n}' + firstLine.slice(b) + url.slice(firstLine.length));
  // duração estimada do vídeo: soma das partes (depois da edição) ou palavras do roteiro ÷ 2,5 por segundo (depois do roteiro)
  const estimate = (() => {
    if (!p) return '';
    const sec = p.shots.length ? p.shots.reduce((n, s) => n + (s.duration || 0), 0) : Object.values(p.pageScript ?? {}).reduce((n, t) => n + (t.trim() ? t.trim().split(/\s+/).length : 0), 0) / 2.5;
    if (!sec) return '';
    const m = Math.round(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${Math.max(1, m)} min`;
  })();
  // o que está rodando fica no topo; depois o que já terminou, do mais recente para o mais antigo
  // passo concluído (verde): o último job daquele tipo terminou sem erro e é mais novo que o do passo anterior
  // o que está rodando vale mais que um job antigo (cancelado/com erro) que calhou de estar depois na lista
  const pickKind = (k: string) => jobs.filter((j) => j.kind === k).sort((a, b) => Number(a.status === 'running') - Number(b.status === 'running') || (a.startedAt ?? 0) - (b.startedAt ?? 0)).at(-1);
  const lastOf = pickKind;
  const ORDER = ['script', 'edit', 'check', 'render'];
  const stepDone = (k: string): boolean => {
    const j = lastOf(k);
    if (j?.status !== 'done') return false;
    const prev = ORDER[ORDER.indexOf(k) - 1];
    if (!prev) return true;
    return stepDone(prev) && (j.endedAt ?? 0) >= (lastOf(prev)?.endedAt ?? 0); // só vale se todos os passos anteriores também estão prontos
  };
  const stepCls = (k: string, _prev?: string) => (stepDone(k) ? 'btn border-green-500 bg-green-600/25 text-green-300' : 'btn');
  const lastJobs = [...new Set(jobs.map((j) => j.kind))].flatMap((k) => pickKind(k) ?? []).sort(
    (a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0),
  );

  return (
    <div className="space-y-4">
      {/* Cabeçalho: título, formato, narração, ações */}
      <div className="flex flex-wrap items-end gap-3">
        <input className="field max-w-xs text-base font-semibold" value={p.title} onChange={(e) => edit((d) => (d.title = e.target.value))} />
        <select className="field w-auto" value={p.format} onChange={(e) => edit((d) => (d.format = e.target.value as MangaFormat))}>
          {Object.entries(MANGA_SIZES).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-md border text-sm" role="radiogroup" aria-label="Narração">
          {(['text', 'voice', 'mic'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={p.narration === m} className={`px-3 py-1.5 ${p.narration === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`} onClick={() => edit((d) => (d.narration = m))}>
              {m === 'text' ? 'Narração normal (texto)' : m === 'voice' ? 'Narração com voz (IA)' : 'Minha voz'}
            </button>
          ))}
        </div>
        <a href={`/p/${id}/narrar`} className="btn" title="Gravar a sua própria narração, parte por parte, com efeitos de voz">
          🎙 Minha narração
        </a>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!p.subtitles} onChange={(e) => edit((d) => (d.subtitles = e.target.checked))} />
          Legenda no vídeo
        </label>
        <label className="flex items-center gap-2 text-sm" title="Projetos com a mesma série compartilham a memória da IA: o vídeo dos capítulos 7-12 continua de onde o dos 1-6 parou, com os mesmos nomes e jeito de contar. Vazio = usa o título sem os números.">
          Série
          <input className="field w-40" placeholder={p.title.replace(/\d+(\s*-\s*\d+)?/g, '').trim() || 'mesmo do título'} value={p.series ?? ''} onChange={(e) => edit((d) => (d.series = e.target.value))} />
        </label>
        <label className="flex items-center gap-2 text-sm" title="Este vídeo é uma PARTE da história (ex.: capítulos 16-22 = parte 3). Com o número, o roteiro ganha um gancho de abertura (esta é a parte N + o que houve antes + link na descrição) e um de fechamento (o que vem na parte N+1). Vazio = vídeo comum.">
          Parte
          <input
            type="number"
            min={0}
            step={1}
            className="field w-16"
            placeholder="não"
            value={p.part?.number || ''}
            onChange={(e) => edit((d) => { const n = Math.max(0, Math.floor(Number(e.target.value) || 0)); d.part = n ? { ...d.part, number: n } : undefined; })}
          />
        </label>
        {!!p.part?.number && (
          <>
            <label className="flex items-center gap-2 text-sm" title="Link das partes anteriores no YouTube: entra na descrição do vídeo (o gancho de abertura diz para procurar lá).">
              Link das partes anteriores
              <input className="field w-56" placeholder="https://youtube.com/..." value={p.part.recapUrl ?? ''} onChange={(e) => edit((d) => { if (d.part) d.part.recapUrl = e.target.value; })} />
            </label>
            <button className="btn" disabled={running || !p.shots.some((s) => !s.hook && s.text.trim())} onClick={() => start({ kind: 'hooks' })} title="A IA escreve (de novo) o gancho de abertura (parte N, resumo do que houve antes, link na descrição) e o de fechamento (o que vem na parte seguinte). Ficam no começo e no fim da linha do tempo e você pode editar o texto como qualquer fala.">
              🪝 Gerar ganchos
            </button>
            <button className="btn" disabled={running} onClick={() => start({ kind: 'join' })} title="Emenda os vídeos já renderizados de todas as partes desta série (pela ordem do número), SEM os ganchos de abertura e fechamento, num vídeo completo só. Cada parte precisa ter sido renderizada.">
              🔗 Juntar partes
            </button>
            {p.joined && (
              <a className="text-sm text-sky-400 hover:underline" href={`/api/file?project=${id}&f=${encodeURIComponent(p.joined.file.replace(/\\/g, '/').split(`${id}/`).pop() ?? '')}`} target="_blank" rel="noreferrer" title={`${p.joined.labels?.join(' + ') ?? `Partes ${p.joined.parts.join(', ')}`} · gerado em ${new Date(p.joined.at).toLocaleString('pt-BR')}`}>
                ▶ Vídeo completo ({Math.round(p.joined.duration / 60)} min)
              </a>
            )}
          </>
        )}
        <label className="flex items-center gap-2 text-sm" title="Duração máxima do vídeo final. Vazio = automático: sem teto, a IA decide pela relevância de cada capítulo (importante é destrinchado, enchimento é resumido). Preencha só se quiser forçar um máximo.">
          Duração
          <input
            type="number"
            min={0}
            step={5}
            className="field w-20"
            placeholder="auto"
            value={p.targetMinutes || ''}
            onChange={(e) => edit((d) => (d.targetMinutes = Math.max(0, Number(e.target.value) || 0)))}
          />
          min
          {!!p.targetMinutes && p.targetMinutes >= 60 && <span className="text-muted-foreground">({Math.floor(p.targetMinutes / 60)}h{String(Math.round(p.targetMinutes % 60)).padStart(2, '0')})</span>}
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-sm" title="Ao terminar um passo sem erro, já começa o próximo: roteiro → editar com IA → validar → renderizar. Clique no passo de onde quer começar.">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Automático
          </label>
          <label className="flex cursor-pointer items-center gap-1 text-sm" title="Se a OmniRoute acabar, usa o Claude direto, sem perguntar na tela (gasta o seu plano). Desligado: pergunta Sim/Não em cada processo.">
            <input type="checkbox" checked={!!p?.autoPaid} onChange={(e) => edit((d) => (d.autoPaid = e.target.checked))} />
            Usar o Claude se a OmniRoute acabar
          </label>
          <button className={stepCls('script')} disabled={running || !p.pages.length} onClick={() => start({ kind: 'script' })} title="Passo 1: a IA lê as páginas, avalia a relevância de cada capítulo e escreve a história do vídeo (sem teto de duração): capítulo importante é destrinchado, enchimento é resumido.">
            1 · Gerar roteiro (IA)
          </button>
          {/* ordem obrigatória: cada passo só libera depois do anterior */}
          <button className={stepCls('edit', 'script')} disabled={running || !p.pages.length || !Object.keys(p.pageScript ?? {}).length} onClick={() => start({ kind: 'edit' })} title={!Object.keys(p.pageScript ?? {}).length ? 'Travado: faça o passo 1 (Gerar roteiro) antes' : 'Passo 2: a IA casa o roteiro com as imagens do capítulo e recorta cada cena inteira (balão quase nunca; nada ilegível ou espremido).'}>
            2 · Editar com IA
          </button>
          <button className={stepCls('check', 'edit')} disabled={running || !p.shots.length || needsPanelCrops(p)} onClick={() => start({ kind: 'check' })} title={!p.shots.length ? 'Travado: faça o passo 2 (Editar com IA) antes' : 'Passo 3: uma IA leve confere se o texto bate com a imagem, se não é só balão e se a cena não ficou cortada ou pequena; troca o que estiver errado.'}>
            3 · Validar (IA)
          </button>
          <LastRenderInfo p={p} />
          <button
            className={stepDone('render') ? 'btn border-green-500 bg-green-600 text-white' : 'btn-primary'}
            disabled={running || !p.shots.length || needsPanelCrops(p) || !Object.keys(p.pageScript ?? {}).length}
            title={needsPanelCrops(p) ? 'Travado: faça o passo 2 (Editar com IA) antes' : !Object.keys(p.pageScript ?? {}).length ? 'Travado: faça o passo 1 (Gerar roteiro) antes' : 'Passo 4: renderiza o vídeo'}
            onClick={() => start({ kind: 'render' })}
          >
            4 · Renderizar vídeo
          </button>
          {/* opcional: depois do vídeo em português, a IA traduz o roteiro e gera também o áudio em inglês */}
          <label className="flex cursor-pointer items-center gap-1 text-sm" title="Depois que o vídeo em português ficar pronto, traduz o roteiro para inglês e gera também a versão com narração em inglês (arquivo à parte). Opcional.">
            <input type="checkbox" checked={!!p.englishAudio} onChange={(e) => edit((d) => (d.englishAudio = e.target.checked))} />
            Fazer também o áudio em inglês
          </label>
          <button className="btn" disabled={running || !p.shots.some((s) => s.text.trim())} onClick={() => start({ kind: 'english', textOnly: true })} title="Só traduz a narração para inglês (sem renderizar), para baixar o roteiro e a legenda.">
            Texto em inglês
          </button>
          {p.englishTexts && (
            <>
              <button className="btn" onClick={() => dl(p, 'txt')}>⬇ Roteiro EN (.txt)</button>
              <button className="btn" disabled={!p.lastRender?.segments?.length} title="Usa os tempos do último render em português" onClick={() => dl(p, 'srt')}>⬇ Legenda EN (.srt)</button>
            </>
          )}
          {!!p.lastRender && (
            <button className="btn" disabled={running} onClick={() => start({ kind: 'english' })} title="Traduz o roteiro para inglês e renderiza a versão com voz em inglês, usando o último render em português.">
              🇺🇸 Gerar áudio em inglês
            </button>
          )}
          {p.english && (
            <a className="btn" href={`/api/file?project=${p.id}&f=${encodeURIComponent(p.english.file)}&v=${encodeURIComponent(p.english.at)}`} target="_blank" rel="noreferrer" title={`Gerado em ${new Date(p.english.at).toLocaleString('pt-BR')}`}>
              ▶ Vídeo em inglês ({fmtTime(p.english.duration)})
            </a>
          )}
        </div>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <DownloadedChapters pages={p.pages} />
      {p.test && (
        <div className="space-y-2 rounded-lg border border-violet-500/60 bg-violet-500/10 p-3 text-sm">
          <p className="font-medium">🧪 Modo teste: {p.test.chapters.join(', ')}</p>
          <p className="text-xs text-muted-foreground">
            Rode os passos 1 a 3 só nesses capítulos, confira os cortes e a ordem das imagens (modal de dúvidas e editor) e ajuste o que não gostar.
            {!!p.parked?.length && ` Aguardando o fim do teste: ${p.parked.map((x) => x.chapter).join(', ')} (${p.parked.reduce((n, x) => n + x.pages.length, 0)} páginas já baixadas).`}
            {' '}Ao clicar em Teste finalizado, o gestor aprende com o que você mudou e o resto entra no fluxo normal.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-primary"
              disabled={running}
              onClick={() => {
                if (confirm('Finalizar o teste? O gestor vai aprender com os seus ajustes e os capítulos que esperam entram no fluxo normal.')) start({ kind: 'finalizeTest' });
              }}
            >
              ✅ Teste finalizado
            </button>
            <button
              className="btn"
              disabled={running}
              title="Libera os capítulos que esperam sem o gestor aprender nada com este teste"
              onClick={() => {
                if (confirm('Finalizar sem aprender? Nada do que você ajustou vira regra.')) start({ kind: 'finalizeTest', skipLearning: true });
              }}
            >
              finalizar sem aprender
            </button>
          </div>
        </div>
      )}
      {!p.test && !!p.testSummary && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">🧪 O que o último teste ensinou ao gestor (<a className="underline" href="/perfis">ver e apagar regras</a>)</summary>
          <p className="mt-1 whitespace-pre-line">{p.testSummary}</p>
        </details>
      )}
      {!!p.lockedPages?.length && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>🔒 {new Set(p.pages.filter((x) => p.lockedPages!.includes(x.id)).map((x) => x.chapter)).size} capítulo(s) prontos e protegidos: roteiro, edição e validação só mexem nos capítulos novos.</span>
          <button
            className="underline"
            disabled={running}
            onClick={async () => {
              if (!confirm('Desproteger? Os passos 1, 2 e 3 vão refazer também os capítulos prontos e seus ajustes podem se perder.')) return;
              await fetch(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify({ lockedPages: [] }) });
              load();
            }}
          >
            desproteger
          </button>
        </p>
      )}
      {dq.queued && (
        <p className="flex items-center gap-2 rounded border border-amber-400 p-2 text-xs text-amber-300">
          ⏳ Suas respostas das dúvidas vão ser aplicadas quando o processo em andamento terminar{dq.queued.render ? ' (e renderiza só o que mudou)' : ''}.
          <button className="btn px-2 py-0.5" onClick={dq.cancel}>cancelar</button>
        </p>
      )}
      {doubtsOpen && !!p.doubts?.length && (
        <DoubtsModal
          p={p}
          busy={running}
          onClose={() => setDoubtsOpen(false)}
          onQueue={dq.queue}
          onDone={async (_, render) => {
            setDoubtsOpen(false);
            await load();
            // no automático, "renderizar depois" não pula a validação: valida primeiro (a cadeia segue para o render sozinha)
            if (render) {
              if (stepDone('check')) start({ kind: 'render', cacheOnly: true });
              else {
                forceRender.current = true; // a validação é obrigatória: valida e só então renderiza
                start({ kind: 'check' });
              }
            }
          }}
        />
      )}
      {!!lastJobs.length && (
      <details open className="group/procs rounded-lg border p-2 text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
          <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-muted-foreground transition-transform group-open/procs:rotate-90" aria-hidden="true">
            <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="flex-1">Processos ({lastJobs.length})</span>
          {lastJobs.some((j) => (j.quotaUsed ?? quotaFromLogs(j.logs)) !== undefined) && (
            <span className="rounded border border-amber-400/60 bg-amber-400/10 px-2 py-0.5 text-xs font-semibold text-amber-300" title="Quanto do limite de 5 h do seu plano do Claude este processo gastou (soma do medidor enquanto ele rodou; inclui qualquer outro uso do plano no mesmo período). Soma dos processos listados.">
              ⚡ {quotaText(lastJobs.reduce((n, j) => n + (j.quotaUsed ?? quotaFromLogs(j.logs) ?? 0), 0))} do plano (5 h) nestes processos
            </span>
          )}
          {!!p.doubts?.length && (
            <button className="btn border-amber-400 px-2 py-0.5 text-xs text-amber-300 disabled:opacity-50" disabled={!validated} title={validated ? undefined : 'As dúvidas só abrem depois da validação com IA (passo 3)'} onClick={(e) => { e.preventDefault(); setDoubtsOpen(true); }}>
              ❓ Dúvidas da IA ({p.doubts.length})
            </button>
          )}
          {lastJobs
            .filter((j) => j.status === 'running')
            .map((j) => (
              <span key={j.id} className="text-xs text-muted-foreground">
                {jobLabel(j.kind)} rodando · {Math.round(j.progress * 100)}%{jobEta(j) ? ` · ${jobEta(j)}` : ''}{estimate ? ` · vídeo ≈ ${estimate}` : ''}
              </span>
            ))}
        </summary>
        <div className="mt-2 space-y-2">
      {lastJobs.map((j) => (
        <details key={j.id} className="group rounded-md border p-2 text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-2">
            <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true">
              <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className={`flex-1 ${j.status === 'error' ? 'text-destructive' : ''}`}>
              {jobLabel(j.kind)}: {j.message}
              {j.status === 'running' && estimate ? <span className="ml-2 text-xs text-muted-foreground">· vídeo ≈ {estimate}</span> : null}
            </span>
            <PaidAsk job={j} projectId={id} />
            {(j.quotaUsed ?? quotaFromLogs(j.logs)) !== undefined && (
              <span className="rounded border border-amber-400/60 bg-amber-400/10 px-2 py-0.5 text-xs font-semibold text-amber-300" title="Quanto do limite de 5 h do seu plano do Claude este processo gastou (soma do medidor enquanto ele rodou; inclui qualquer outro uso do plano no mesmo período).">
                ⚡ {quotaText(j.quotaUsed ?? quotaFromLogs(j.logs) ?? 0)}{j.quotaUsed === undefined ? ' (estimado)' : ''} do plano
              </span>
            )}
            {j.status === 'running' && (
              <span className="h-2 w-32 shrink-0 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(j.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span className="block h-full rounded-full bg-green-500 transition-[width] duration-500" style={{ width: `${Math.max(2, Math.round(j.progress * 100))}%` }} />
              </span>
            )}
            <span className="tabular-nums text-muted-foreground">
              {j.startedAt ? `${Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000)} s · ` : ''}
              {Math.round(j.progress * 100)}%{jobEta(j) ? ` · ${jobEta(j)}` : ''}
            </span>
            {j.status === 'done' && (
              <span className="rounded border border-green-600/40 bg-green-600/15 px-2 py-0.5 text-xs font-medium text-green-500">✔ Processo finalizado</span>
            )}
            {j.status === 'running' && (
              <button
                className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                onClick={(e) => {
                  e.preventDefault();
                  if (confirm('Cancelar este job? O que já foi feito fica salvo e é reaproveitado ao rodar de novo.')) fetch(`/api/projects/${id}/jobs?job=${j.id}`, { method: 'DELETE' });
                }}
              >
                Cancelar
              </button>
            )}
          </summary>
          <div className="mt-1 h-1 rounded bg-muted">
            <div className="h-1 rounded bg-primary transition-all" style={{ width: `${j.progress * 100}%` }} />
          </div>
          <JobLogList logs={j.logs} running={j.status === 'running'} />
        </details>
      ))}
        </div>
      </details>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Esquerda: painel de edição do que está na prévia (ou importar/páginas) */}
        <aside className="space-y-3 rounded-lg border p-3">
          <div className="flex gap-1 text-sm" role="tablist">
            {(['edit', 'pages'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`rounded-md px-3 py-1.5 ${tab === t ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`} onClick={() => setTab(t)}>
                {t === 'edit' ? `Editar parte${shot ? ` ${sel + 1}/${p.shots.length}` : ''}` : `Importar e páginas (${p.pages.length})`}
              </button>
            ))}
          </div>

          {tab === 'edit' &&
            (shot && shotPage ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <button className="btn" disabled={sel === 0} onClick={() => setSel(sel - 1)}>
                    ← Anterior
                  </button>
                  <button className="btn" disabled={sel >= p.shots.length - 1} onClick={() => setSel(sel + 1)}>
                    Próxima →
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {shotPage.chapter} · página {p.pages.filter((x) => x.chapter === shotPage.chapter).indexOf(shotPage) + 1}
                  </span>
                  <div className="ml-auto flex gap-1">
                    <button className="btn" title="Afastar (mostra mais da página)" onClick={() => editShot(sel, { focus: zoomRect(shot.focus, 1 / 0.85) })}>
                      − Zoom
                    </button>
                    <button className="btn" title="Aproximar no centro do foco" onClick={() => editShot(sel, { focus: zoomRect(shot.focus, 0.85) })}>
                      + Zoom
                    </button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Arraste sobre a página para desenhar onde a câmera foca; arraste dentro do quadro para mover. A prévia à direita mostra o resultado.</p>
                <FocusEditor src={pageUrl(p.id, shotPage)} width={shotPage.width} height={shotPage.height} focus={shot.focus} onChange={(f) => editShot(sel, { focus: f })} />
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Duração (s)</span>
                    <input type="number" min={0.5} step={0.5} className="field" value={shot.duration} onChange={(e) => editShot(sel, { duration: Math.max(0.5, Number(e.target.value) || 0.5) })} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Enquadramento</span>
                    <select className="field" value={shot.fit ?? 'contain'} onChange={(e) => editShot(sel, { fit: e.target.value as 'contain' | 'cover' })}>
                      <option value="contain">Quadro + laterais desfocadas</option>
                      <option value="cover">Tela cheia (ação)</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Câmera</span>
                    <select className="field" value={shot.motion} onChange={(e) => editShot(sel, { motion: e.target.value as Motion })}>
                      {Object.entries(MOTIONS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block space-y-1 text-sm">
                  <span className="text-muted-foreground">{p.narration === 'voice' ? 'Texto falado' : 'Texto na tela (legenda)'}</span>
                  <textarea className="field h-20" value={shot.text} onChange={(e) => editShot(sel, { text: e.target.value })} placeholder="Escreva ou use “1 · Gerar roteiro (IA)”" />
                </label>
                <div className="flex flex-wrap gap-3 text-xs">
                  <button className="text-primary hover:underline" onClick={() => editShot(sel, { focus: { ...FULL } })}>
                    Página inteira
                  </button>
                  <button className="text-primary hover:underline" title="Mais uma parte com a mesma página (outro foco)" onClick={() => edit((d) => d.shots.splice(sel + 1, 0, { ...structuredClone(d.shots[sel]), id: uid(), text: '' }))}>
                    Duplicar (outro foco na mesma página)
                  </button>
                  <button
                    className="text-destructive hover:underline"
                    onClick={() => {
                      edit((d) => d.shots.splice(sel, 1));
                      setSel((x) => Math.max(0, Math.min(x, p.shots.length - 2)));
                    }}
                  >
                    Tirar esta tela do vídeo
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>A linha do tempo está vazia.</p>
                {p.pages.length > 0 ? (
                  <button className="btn-primary" onClick={rebuild}>
                    Montar linha do tempo (capítulo 1 → {chaptersInOrder(p.pages).length})
                  </button>
                ) : (
                  <button className="btn" onClick={() => setTab('pages')}>
                    Importar capítulos
                  </button>
                )}
              </div>
            ))}

          {tab === 'pages' && (
            <div className="space-y-3">
          {jobs.filter((j) => j.kind === 'import' && j.status === 'running').map((j) => (
            <ImportPause key={j.id} projectId={id} job={j} />
          ))}
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">Importar capítulo</p>
            {/* um campo por link; ao preencher o último, aparece outro embaixo (o estado `url` segue sendo um link por linha) */}
            {(() => {
              const rows = url.split(/\r?\n/);
              while (rows.length > 1 && !rows[rows.length - 1].trim()) rows.pop();
              if (rows[rows.length - 1].trim()) rows.push('');
              const filled = rows.filter((r) => r.trim()).length;
              const setRow = (i: number, v: string) => {
                const next = [...rows];
                next.splice(i, 1, ...v.split(/\r?\n/).map((s) => s.trim())); // colar vários links de uma vez também separa em campos
                setUrl(next.join('\n'));
              };
              return (
                <div className="space-y-1.5">
                  {rows.map((r, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
                      <input
                        className="field font-mono text-xs"
                        placeholder={i === 0 ? 'Link do capítulo 1 (ou com {n} para vários: site.com/manga/chapter-{n}/)' : `Link do capítulo ${i + 1}`}
                        value={r}
                        onChange={(e) => setRow(i, e.target.value)}
                        onPaste={(e) => {
                          const t = e.clipboardData.getData('text');
                          if (/\r?\n/.test(t.trim())) {
                            e.preventDefault();
                            setRow(i, t.trim());
                          }
                        }}
                      />
                      {r.trim() && filled > 1 && (
                        <button className="rounded border px-1.5 text-xs hover:bg-muted" title="Remover este link" onClick={() => setUrl(rows.filter((_, k) => k !== i).join('\n'))}>
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })()}
            {firstLine && !hasVar(firstLine) && numbersIn(firstLine).length > 0 && (
              <div className="text-xs text-muted-foreground">
                Qual número é o capítulo?{' '}
                {numbersIn(firstLine).slice(-6).map((m) => (
                  <button key={m.start} className="mr-1 rounded border px-1 font-mono hover:bg-muted" title="Trocar por {n}" onClick={() => markVar(m.start, m.end)}>
                    {m.value}
                  </button>
                ))}
              </div>
            )}
            {hasVar(url) && <input className="field" placeholder="Capítulos: 1-10, 12, 15.5" value={chapterSeq} onChange={(e) => setChapterSeq(e.target.value)} />}
            <input className="field" placeholder="Páginas: todas (ou 1-20, 25)" value={pageSeq} onChange={(e) => setPageSeq(e.target.value)} />
            <input className="field" placeholder={hasVar(url) ? 'Nome: Capítulo {n} (opcional)' : 'Nome do capítulo (opcional)'} value={chapter} onChange={(e) => setChapter(e.target.value)} />
            {url.trim() && (
              <p className={`text-xs ${plan.error ? 'text-destructive' : 'text-muted-foreground'}`}>
                {plan.error ||
                  `${plan.list.length} capítulo(s)${plan.pages.length ? `, páginas ${pageSeq.trim()}` : ', todas as páginas'}` +
                    (plan.list.length > 1 ? ` — ${plan.list[0].url} … ${plan.list[plan.list.length - 1].url}` : '')}
              </p>
            )}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">HTML da página (se o link falhar)</summary>
              {plan.list.length > 1 && <p className="mt-1">Vários capítulos: cole um HTML por capítulo, na ordem, separados por uma linha só com ---</p>}
              <textarea className="field mt-1 h-16" value={html} onChange={(e) => setHtml(e.target.value)} />
            </details>
            {p.test ? (
              <p className="text-xs text-amber-300">🧪 Teste em andamento: os capítulos novos ficam baixados e esperam o "Teste finalizado".</p>
            ) : (
              <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Só estes primeiros capítulos passam pelo fluxo (roteiro, edição, validação). Você ajusta os cortes e clica em Teste finalizado: o gestor aprende com o que você mudou e o resto do lote segue com isso.">
                Capítulos de teste:
                <select className="field w-auto py-0.5" value={testSel ?? (plan.list.length > 1 ? 1 : 0)} onChange={(e) => setTestSel(Number(e.target.value))}>
                  <option value={0}>sem teste</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
                {(testSel ?? (plan.list.length > 1 ? 1 : 0)) > 0 && plan.list.length > (testSel ?? 1) && <span>os outros {plan.list.length - (testSel ?? 1)} ficam baixados, esperando</span>}
              </label>
            )}
            <button className="btn-primary w-full justify-center" disabled={running || !plan.list.length || !!plan.error} onClick={() => start({ kind: 'import', url, html: html || undefined, chapter, chapters: chapterSeq, pages: pageSeq, testCount: p.test ? 0 : (testSel ?? (plan.list.length > 1 ? 1 : 0)) })}>
              {plan.list.length > 1 ? `Baixar ${plan.list.length} capítulos` : 'Baixar páginas'}
            </button>
            <label className="btn w-full cursor-pointer justify-center">
              Enviar imagens do computador
              <input
                type="file"
                multiple
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const fd = new FormData();
                  for (const f of e.target.files ?? []) fd.append('files', f);
                  fd.append('chapter', chapter);
                  start(fd);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">Resumo da obra</p>
            <p className="text-xs text-muted-foreground">
              Cole o resumo do webtoon ou do anime: personagens principais (nomes certos), a trama e o tom. A IA usa desde a leitura das páginas, no recorte e na narração, para acertar quem é quem e o que importa.
            </p>
            <textarea className="field h-32 text-sm" placeholder="Ex.: Joo-heon é um caçador de relíquias que volta 15 anos no tempo..." value={p.context} onChange={(e) => (setCtxSaved(false), edit((d) => (d.context = e.target.value)))} />
            <div className="flex items-center gap-2">
              <button
                className="btn-primary"
                onClick={async () => {
                  await save(p);
                  setCtxSaved(true);
                }}
              >
                Salvar resumo da obra
              </button>
              <span className="text-xs text-muted-foreground">{ctxSaved ? '✓ salvo' : `${p.context.length} caracteres (usa até 2.000)`}</span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Páginas ({p.pages.length})</span>
              {p.pages.length > 0 && (
                <button className="text-xs text-primary hover:underline" onClick={() => edit((d) => d.pages.forEach((pg) => d.shots.push({ id: uid(), pageId: pg.id, duration: 4, focus: { ...FULL }, motion: 'zoom-in', text: '' })))}>
                  Adicionar todas
                </button>
              )}
            </div>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              {chaptersInOrder(p.pages).map((c) => (
                <div key={c}>
                  <p className="mb-1 text-xs text-muted-foreground">{c}</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {p.pages
                      .filter((pg) => pg.chapter === c)
                      .map((pg, i) => (
                        <button key={pg.id} title="Adicionar à linha do tempo" className="group relative overflow-hidden rounded border hover:border-primary" onClick={() => addShot(pg.id)}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={pageUrl(p.id, pg, 240)} alt="" loading="lazy" decoding="async" className="aspect-[2/3] w-full object-cover" />
                          <span className="absolute bottom-0 left-0 bg-black/70 px-1 text-[10px]">{i + 1}</span>
                          <span className="absolute inset-0 hidden place-items-center bg-black/50 text-lg group-hover:grid">+</span>
                        </button>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
            </div>
          )}
        </aside>

        {/* Direita: prévia da montagem + voz + contexto + último vídeo */}
        <section className="space-y-3">
          <Preview projectId={p.id} format={p.format} shots={p.shots} pages={p.pages} selected={sel} onSelect={setSel} subtitles={!!p.subtitles} onEditShot={(patch) => editShot(sel, patch)} />
          {p.narration === 'voice' && <VoicePicker value={p.voice ?? DEFAULT_VOICE} onChange={(v) => edit((d) => (d.voice = v))} />}
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Contexto da obra (ajuda a IA)</span>
            <textarea className="field h-16" value={p.context} onChange={(e) => edit((d) => (d.context = e.target.value))} />
          </label>
          <details className="rounded-lg border p-2 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Resumo de cada capítulo (IA) · {Object.keys(p.chapterContexts ?? {}).length}/{chaptersInOrder(p.pages).length}</summary>
            <div className="mt-2 space-y-2">
              {chaptersInOrder(p.pages).map((c) => (
                <label key={c} className="block space-y-1">
                  <span className="text-xs text-muted-foreground">{c}</span>
                  <textarea className="field h-14 text-xs" value={p.chapterContexts?.[c] ?? ''} placeholder="Gerado junto com o roteiro" onChange={(e) => edit((d) => ((d.chapterContexts ??= {})[c] = e.target.value))} />
                </label>
              ))}
              <button className="btn" disabled={running || !p.pages.length} onClick={() => start({ kind: 'context' })}>
                Gerar resumos dos capítulos
              </button>
            </div>
          </details>
        </section>
      </div>

      {/* Etapa 3: vídeo final, polir e publicação ficam numa página própria (/p/<id>/final). */}
      {p.lastRender && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3" data-testid="final-video">
          <p className="text-sm font-medium">3 · Vídeo final ({fmtTime(p.lastRender.duration)})</p>
          <span className="text-xs text-muted-foreground">assistir, polir, renderizar de novo e gerar thumb/descrição/tags</span>
          <a className="btn-primary ml-auto" href={`/p/${p.id}/editor`}>
            ✂ Editar vídeo (linha do tempo) →
          </a>
          <a className="btn" href={`/p/${p.id}/final`}>
            Abrir vídeo final e publicação →
          </a>
        </div>
      )}

      {/* Linha do tempo: ordem (arrastar), seleção, remover */}
      <div className="rounded-lg border p-3">
        <p className="mb-2 text-sm font-medium">
          Linha do tempo · {p.shots.length} partes · {fmtDuration(p.shots.reduce((n, s) => n + s.duration, 0))}
        </p>
        <div className="flex gap-2 overflow-x-auto pb-2" data-testid="timeline">
          {p.shots.map((s, i) => {
            const pg = pageById.get(s.pageId);
            return (
              <div
                key={s.id}
                draggable
                onDragStart={() => (dragFrom.current = i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  const from = dragFrom.current;
                  if (from === null || from === i) return;
                  edit((d) => d.shots.splice(i, 0, d.shots.splice(from, 1)[0]));
                  setSel(i);
                }}
                onClick={() => (setSel(i), seekTo(s.id))}
                style={{ width: Math.max(64, Math.min(200, (segById.get(s.id)?.dur ?? s.duration) * 14)) }}
                className={`relative shrink-0 cursor-pointer overflow-hidden rounded border-2 ${i === sel ? 'border-primary' : s.id === playingId ? 'border-amber-400' : 'border-transparent'}`}
              >
                {pg && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={pageUrl(p.id, pg, 320)} alt="" loading="lazy" decoding="async" className="h-36 w-full object-cover" draggable={false} />
                )}
                <span className="absolute left-0 top-0 bg-black/70 px-1 text-[10px]">
                  {i + 1} · {s.duration}s
                </span>
                <button
                  title="Remover"
                  className="absolute right-0 top-0 bg-black/70 px-1 text-[10px] hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    edit((d) => d.shots.splice(i, 1));
                    setSel((x) => Math.max(0, Math.min(x, p.shots.length - 2)));
                  }}
                >
                  ✕
                </button>
                {s.text && <span className="absolute bottom-0 left-0 right-0 truncate bg-black/70 px-1 text-[10px]">{s.text}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const NEXT: Record<string, string | undefined> = { script: 'edit', edit: 'check', check: 'render', render: 'english' };

function JobLogList({ logs, running }: { logs: string[]; running: boolean }) {
  const ref = useStickBottom<HTMLOListElement>(logs.length);
  return (
    <ol ref={ref} className="mt-2 max-h-60 space-y-0.5 overflow-auto font-mono text-xs text-muted-foreground">
      {logs.map((l, k) => (
        <li key={k} className={k === logs.length - 1 && running ? 'text-foreground' : ''}>
          {l}
        </li>
      ))}
    </ol>
  );
}

/** Faixa "Baixados": quais capítulos do mangá já estão no projeto (ex.: 1–10), com a contagem de páginas. */
function DownloadedChapters({ pages }: { pages: StudioPage[] }) {
  const names = chaptersInOrder(pages);
  if (!names.length) return <p className="text-xs text-muted-foreground">Nenhum capítulo baixado ainda.</p>;
  const nums = names.map((n) => chapterNum(n)).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const others = names.filter((n) => chapterNum(n) === null);
  // agrupa números consecutivos em faixas: 1,2,3,5 → "1–3, 5"
  const ranges: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] - nums[j] === 1) j++;
    ranges.push(j > i ? `${nums[i]}–${nums[j]}` : `${nums[i]}`);
    i = j + 1;
  }
  const label = [...ranges, ...others].join(', ');
  return (
    <p className="text-sm" title="Capítulos que já estão baixados neste projeto">
      <span className="text-muted-foreground">Baixados:</span> <b>{nums.length ? `capítulos ${label}` : label}</b>{' '}
      <span className="text-xs text-muted-foreground">
        ({names.length} {names.length === 1 ? 'capítulo' : 'capítulos'} · {pages.length} páginas)
      </span>
    </p>
  );
}
