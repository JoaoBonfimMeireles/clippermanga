'use client';
// Ajudas da aba 🧠 (aprendizado): "ver antes e depois" de cada ajuste (expande) e botão de ditar a resposta por voz.
import { useEffect, useRef, useState } from 'react';
import type { Rect, StudioPage } from '@/lib/types';
import { CropThumb } from './doubts-modal';
import { pageUrl } from './preview';

interface Ctx {
  shotId: string;
  text: string;
  kinds: string[];
  notes: string[];
  pageBefore: StudioPage | null;
  pageAfter: StudioPage | null;
  changes: Record<string, [unknown, unknown]>;
}

const isRect = (v: unknown): v is Rect => !!v && typeof v === 'object' && 'x0' in (v as object) && 'y1' in (v as object);
const pct = (r: Rect) => `${Math.round((r.x1 - r.x0) * 100)}% da largura × ${Math.round((r.y1 - r.y0) * 100)}% da altura da página`;
const show = (v: unknown) => (v === undefined || v === null ? 'padrão' : isRect(v) ? pct(v) : typeof v === 'string' ? v : JSON.stringify(v));
const LABEL: Record<string, string> = { focus: 'Recorte', stretch: 'Esticar', zoom: 'Zoom', fit: 'Encaixe', rotate: 'Giro', duration: 'Duração (s)', speed: 'Velocidade', text: 'Texto', pageId: 'Imagem', motion: 'Movimento', bgBand: 'Fundo' };

/** Recorte ampliado: cabe em maxW × maxH sem distorcer. */
function BigCrop({ src, page, focus, maxW, maxH, children }: { src: string; page: { width: number; height: number }; focus: Rect; maxW: number; maxH: number; children?: React.ReactNode }) {
  const fw = Math.max(0.01, focus.x1 - focus.x0), fh = Math.max(0.01, focus.y1 - focus.y0);
  const ar = (fw * page.width) / (fh * page.height);
  let W = maxW, H = W / ar;
  if (H > maxH) { H = maxH; W = H * ar; }
  const iw = W / fw, ih = (iw * page.height) / page.width;
  return (
    <div className="relative overflow-hidden rounded bg-black" style={{ width: W, height: H }}>
      <img src={src} alt="" className="absolute max-w-none" style={{ width: iw, height: ih, left: -focus.x0 * iw, top: -focus.y0 * ih }} />
      {children}
    </div>
  );
}

/** Tela cheia do ajuste: os dois recortes grandes lado a lado, ou o trecho da página com os dois retângulos desenhados. */
function Lightbox({ projectId, before, after, start, onClose }: { projectId: string; before: { page: StudioPage; focus: Rect }; after: { page: StudioPage; focus: Rect }; start: 'crops' | 'page'; onClose: () => void }) {
  const [mode, setMode] = useState<'crops' | 'page'>(start);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const vw = typeof window === 'undefined' ? 1200 : window.innerWidth, vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const pg = after.page;
  // janela da página: os dois recortes com folga em cima e embaixo
  const y0 = Math.max(0, Math.min(before.focus.y0, after.focus.y0) - 0.04), y1 = Math.min(1, Math.max(before.focus.y1, after.focus.y1) + 0.04);
  const win: Rect = { x0: 0, x1: 1, y0, y1 };
  const box = (r: Rect, color: string, label: string) => (
    <div key={label} className="absolute border-2" style={{ borderColor: color, left: `${r.x0 * 100}%`, width: `${(r.x1 - r.x0) * 100}%`, top: `${((r.y0 - y0) / (y1 - y0)) * 100}%`, height: `${((r.y1 - r.y0) / (y1 - y0)) * 100}%` }}>
      <span className="absolute left-0 top-0 px-1 text-[11px] font-semibold text-black" style={{ background: color }}>{label}</span>
    </div>
  );
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/90 p-3" onClick={onClose}>
      <div className="mb-2 flex items-center gap-2 text-sm" onClick={(e) => e.stopPropagation()}>
        <button className={`btn px-2 py-0.5 ${mode === 'crops' ? 'border-sky-400' : ''}`} onClick={() => setMode('crops')}>Recortes lado a lado</button>
        <button className={`btn px-2 py-0.5 ${mode === 'page' ? 'border-sky-400' : ''}`} onClick={() => setMode('page')}>Na página (onde cada um pega)</button>
        <span className="flex-1 text-xs text-muted-foreground">Esc ou clique fora para fechar</span>
        <button className="btn px-2 py-0.5" onClick={onClose}>✕</button>
      </div>
      <div className="flex min-h-0 flex-1 items-start justify-center gap-4 overflow-auto" onClick={(e) => e.stopPropagation()}>
        {mode === 'crops' ? (
          <>
            <div className="space-y-1">
              <p className="text-sm font-medium text-red-300">Como estava (IA)</p>
              <BigCrop src={pageUrl(projectId, before.page)} page={before.page} focus={before.focus} maxW={vw / 2 - 40} maxH={vh - 110} />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-green-300">Como ficou (você)</p>
              <BigCrop src={pageUrl(projectId, after.page)} page={after.page} focus={after.focus} maxW={vw / 2 - 40} maxH={vh - 110} />
            </div>
          </>
        ) : (
          <BigCrop src={pageUrl(projectId, pg)} page={pg} focus={win} maxW={Math.min(vw - 40, 900)} maxH={vh - 110}>
            {box(before.focus, '#fca5a5', 'estava')}
            {box(after.focus, '#86efac', 'ficou')}
          </BigCrop>
        )}
      </div>
    </div>
  );
}

/** "Ver como estava e como ficou": abre sob demanda e mostra os dois recortes lado a lado e o que mudou. */
export function BeforeAfter({ projectId, part }: { projectId: string; part: number }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Ctx | null | undefined>(undefined);
  const [big, setBig] = useState<'crops' | 'page' | null>(null);
  const [slow, setSlow] = useState(false); // servidor ocupado (render/IA rodando): não deixa o "Carregando…" eterno
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!open || data !== undefined) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      setSlow(true);
      ac.abort();
    }, 20000);
    fetch(`/api/learning/changes?project=${encodeURIComponent(projectId)}&part=${part}`, { signal: ac.signal })
      .then((r) => r.json())
      .then((d: Ctx | null) => setData(d))
      .catch(() => !ac.signal.aborted && setData(null))
      .finally(() => clearTimeout(t));
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [open, data, projectId, part, tries]);
  const focus = data?.changes.focus as [Rect, Rect] | undefined;
  const rest = Object.entries(data?.changes ?? {}).filter(([k]) => k !== 'focus');
  return (
    <details className="text-xs" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer select-none text-sky-300">▼ ver como estava e como ficou</summary>
      <div className="mt-1 space-y-2">
        {data === undefined && !slow && <p className="text-muted-foreground">Carregando…</p>}
        {data === undefined && slow && (
          <p className="text-amber-300">
            Demorou demais para carregar (o servidor está ocupado com outro processo).{' '}
            <button type="button" className="btn px-2 py-0.5" onClick={() => { setSlow(false); setTries((n) => n + 1); }}>Tentar de novo</button>
          </p>
        )}
        {data === null && <p className="text-muted-foreground">Não achei o registro desse ajuste (a parte pode ter sido apagada ou o log é de outro projeto).</p>}
        {data && (
          <>
            {data.text && <p className="italic text-muted-foreground">“{data.text}”</p>}
            {data.kinds.includes('remove') && <p className="text-amber-300">Você apagou esta parte.</p>}
            {data.kinds.includes('add') && <p className="text-amber-300">Você criou esta parte.</p>}
            {focus && isRect(focus[0]) && isRect(focus[1]) && (
              <div className="flex flex-wrap gap-3">
                <div className="space-y-1">
                  <p className="font-medium text-red-300">Como estava (IA)</p>
                  {data.pageBefore && (
                    <button type="button" className="block cursor-zoom-in" title="Clique para ampliar" onClick={() => setBig('crops')}>
                      <CropThumb src={pageUrl(projectId, data.pageBefore)} page={data.pageBefore} focus={focus[0]} />
                    </button>
                  )}
                  <p className="text-muted-foreground">{pct(focus[0])}</p>
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-green-300">Como ficou (você)</p>
                  {data.pageAfter && (
                    <button type="button" className="block cursor-zoom-in" title="Clique para ampliar" onClick={() => setBig('crops')}>
                      <CropThumb src={pageUrl(projectId, data.pageAfter)} page={data.pageAfter} focus={focus[1]} />
                    </button>
                  )}
                  <p className="text-muted-foreground">{pct(focus[1])}</p>
                </div>
              </div>
            )}
            {focus && isRect(focus[0]) && isRect(focus[1]) && data.pageBefore && data.pageAfter && (
              <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => setBig('crops')}>
                🔍 Ampliar
              </button>
            )}
            {big && focus && isRect(focus[0]) && isRect(focus[1]) && data.pageBefore && data.pageAfter && (
              <Lightbox projectId={projectId} before={{ page: data.pageBefore, focus: focus[0] }} after={{ page: data.pageAfter, focus: focus[1] }} start={big} onClose={() => setBig(null)} />
            )}
            {rest.length > 0 && (
              <ul className="space-y-0.5">
                {rest.map(([k, [a, b]]) => (
                  <li key={k}>
                    <b>{LABEL[k] ?? k}:</b> <span className="text-red-300">{show(a)}</span> → <span className="text-green-300">{show(b)}</span>
                  </li>
                ))}
              </ul>
            )}
            {data.notes.length > 0 && <p className="text-muted-foreground">{data.notes.join(' · ')}</p>}
            {!focus && !rest.length && !data.kinds.length && <p className="text-muted-foreground">Sem diferença registrada.</p>}
          </>
        )}
      </div>
    </details>
  );
}

type SR = { start: () => void; stop: () => void; lang: string; continuous: boolean; interimResults: boolean; onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };

/** Botão de ditar: grava a voz e escreve o texto na caixa (reconhecimento de voz do navegador, em português). */
export function DictateButton({ onText, className = '' }: { onText: (text: string) => void; className?: string }) {
  const [on, setOn] = useState(false);
  const [err, setErr] = useState('');
  const rec = useRef<SR | null>(null);
  const supported = typeof window !== 'undefined' && !!((window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);
  useEffect(() => () => rec.current?.stop(), []);
  const toggle = () => {
    setErr('');
    if (on) {
      rec.current?.stop();
      return;
    }
    const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return setErr('Este navegador não tem reconhecimento de voz (use o Chrome ou o Edge).');
    const r = new Ctor();
    r.lang = 'pt-BR';
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      let t = '';
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) t += e.results[i][0].transcript;
      if (t.trim()) onText(t.trim());
    };
    r.onerror = (e) => setErr(e.error === 'not-allowed' ? 'Permita o microfone no navegador.' : e.error === 'no-speech' ? '' : `Erro de voz: ${e.error}`);
    r.onend = () => setOn(false);
    rec.current = r;
    try {
      r.start();
      setOn(true);
    } catch {
      setErr('Não consegui iniciar o microfone.');
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className={`btn px-2 py-0.5 text-xs ${on ? 'border-red-500 text-red-300' : ''} ${className}`} onClick={toggle} disabled={!supported && !err} title={supported ? 'Clique, fale e clique de novo para parar: o texto aparece na caixa' : 'Seu navegador não tem reconhecimento de voz (use o Chrome ou o Edge)'}>
        {on ? '⏹ Parar' : '🎙 Ditar'}
      </button>
      {on && <span className="animate-pulse text-xs text-red-300">ouvindo…</span>}
      {err && <span className="text-xs text-amber-300">{err}</span>}
    </span>
  );
}
