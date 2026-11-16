'use client';
// Painel "Minha narração": gravar a própria voz parte por parte, como um jornal.
//  - Esquerda: prévia do vídeo andando junto com a sua voz (com os efeitos) + efeitos de voz.
//  - Meio: a imagem da parte atual.  - Direita: o texto para ler + gravar.
// ESPAÇO: termina a parte atual e já começa a gravar a próxima, sem parar (o microfone continua aberto).
// ESC: para. Cada parte pode ser ouvida, regravada ou apagada na lista de baixo.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cropPx, cleanRect } from '@/lib/camera';
import type { Shot, StudioProject } from '@/lib/types';
import { FX_NEUTRAL, FX_PRESETS, normalizeFx, type NarrationData, type VoiceFx } from '@/lib/voice-fx';
import { pageUrl, Preview } from './preview';
import { fmtDuration } from '@/lib/duration';

type Up = 'uploading' | 'ok' | 'error';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function pickMime(): string {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export function NarrationPanel({ id }: { id: string }) {
  const [p, setP] = useState<StudioProject | null>(null);
  const [nar, setNar] = useState<NarrationData>({ fx: FX_NEUTRAL, items: {} });
  const [sel, setSel] = useState(0);
  const [err, setErr] = useState('');
  const [up, setUp] = useState<Record<string, Up>>({});
  // gravação
  const [recIdx, setRecIdx] = useState<number | null>(null);
  const [continuous, setContinuous] = useState(true);
  const [recStart, setRecStart] = useState(0);
  const [now, setNow] = useState(0);
  // nível do microfone: escrito direto na barra (sem estado), para não redesenhar o painel 60x/s
  const meterBar = useRef<HTMLDivElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const meterRaf = useRef(0);
  // reprodução
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<'one' | 'all' | 'loop' | 'loopAll' | null>(null);
  const [tPlay, setTPlay] = useState<number | undefined>(undefined);
  const playToken = useRef(0);
  const prompter = useRef<HTMLDivElement>(null);
  // microfone: supressão de ruído do navegador (opcional) e teste de volume
  const [browserNs, setBrowserNs] = useState(false);
  const levelDb = useRef(-90);
  const peakDb = useRef(-90);
  const [micTest, setMicTest] = useState<{ running: boolean; msg: string; ok?: boolean }>({ running: false, msg: '' });

  // teleprompter: todas as partes ficam na lista; a caixa só rola quando a parte atual sai da vista
  // (gravando, ela sobe para o topo para você ler as próximas; clicando numa parte, nada pula)
  useEffect(() => {
    const box = prompter.current;
    const el = box?.querySelector<HTMLElement>(`[data-part="${sel}"]`);
    if (!box || !el) return;
    const top = el.offsetTop; // a caixa é "relative": offsetTop já é relativo a ela
    const visible = top >= box.scrollTop && top + el.offsetHeight <= box.scrollTop + box.clientHeight;
    if (recRef.current !== null) box.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' });
    else if (!visible) box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: 'smooth' });
  }, [sel]);

  const loadNar = useCallback(async () => {
    const r = await fetch(`/api/projects/${id}/narration`);
    if (r.ok) setNar(await r.json());
  }, [id]);
  useEffect(() => {
    fetch(`/api/projects/${id}`).then(async (r) => (r.ok ? setP(await r.json()) : setErr('Projeto não encontrado')));
    loadNar();
  }, [id, loadNar]);

  const shots = p?.shots ?? [];
  const shot = shots[sel];
  const page = shot && p?.pages.find((x) => x.id === shot.pageId);
  const fx = normalizeFx(nar.fx);
  const fxKey = useMemo(() => JSON.stringify(fx), [fx]);
  const recOf = (s?: Shot) => (s ? nar.items[s.id] : undefined);
  const audioUrl = (s: Shot) => `/api/projects/${id}/narration?shot=${s.id}&v=${encodeURIComponent(recOf(s)?.at ?? '')}&fx=${encodeURIComponent(fxKey)}`; // fx = efeitos atuais (mesmo antes de salvar)
  // a prévia usa a duração da sua fala (com a velocidade dos efeitos) no lugar da duração planejada
  const previewShots = useMemo(() => shots.map((s) => (nar.items[s.id] ? { ...s, duration: Math.max(0.5, nar.items[s.id].dur / fx.speed) } : s)), [shots, nar, fx.speed]);
  const recorded = shots.filter((s) => nar.items[s.id]).length;
  const totalDur = previewShots.reduce((a, s) => a + s.duration, 0);

  // ---------- teste de microfone ----------
  /** Ouve 6 s de fala e diz se o volume está bom (a fala deve ficar por volta de −20 dB, sem passar de −1 dB). */
  const testMic = async () => {
    try {
      setMicTest({ running: true, msg: 'Fale normalmente por 6 segundos, como se estivesse narrando…' });
      await ensureMic();
      const vals: number[] = [];
      let peak = -90;
      const t0 = performance.now();
      while (performance.now() - t0 < 6000) {
        await new Promise((r) => setTimeout(r, 50));
        vals.push(levelDb.current);
        peak = Math.max(peak, peakDb.current);
      }
      vals.sort((a, b) => a - b);
      const speech = vals[Math.floor(vals.length * 0.9)]; // trechos com fala
      const floor = vals[Math.floor(vals.length * 0.1)]; // silêncio/ruído de fundo
      const db = (v: number) => `${v.toFixed(0)} dB`;
      let msg: string;
      let ok = false;
      if (peak > -1) msg = `Volume ALTO demais (estourando: pico ${db(peak)}). Baixe o volume de entrada do microfone no Windows ou afaste um pouco.`;
      else if (speech < -32) msg = `Volume BAIXO (fala em ${db(speech)}; o ideal é perto de −20 dB). Aumente o volume de entrada no Windows (80–100%) e fale a um palmo do microfone. Voz baixa é o que deixa o som "distante".`;
      else if (speech < -26) msg = `Volume um pouco baixo (fala em ${db(speech)}). Chegue mais perto do microfone ou aumente um pouco o volume de entrada.`;
      else (msg = `Volume bom (fala em ${db(speech)}, pico ${db(peak)}).`), (ok = true);
      if (speech - floor < 25) msg += ` Ruído de fundo alto (só ${(speech - floor).toFixed(0)} dB abaixo da voz): procure um lugar mais silencioso ou ligue "Tirar ruído".`;
      setMicTest({ running: false, msg, ok });
    } catch (e) {
      setMicTest({ running: false, msg: `Microfone: ${(e as Error).message}` });
    }
  };

  // ---------- gravação ----------
  const ensureMic = async () => {
    if (stream.current?.active) return stream.current;
    // sem cancelamento de eco/ganho automático (deixam a voz "aquática"); o tratamento é feito depois, nos efeitos
    // supressão de ruído do navegador: opcional (pode deixar a voz "abafada"); a limpeza do app faz o mesmo papel
    stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: browserNs, autoGainControl: false, channelCount: 1 } });
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream.current).connect(an);
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      const rms = Math.sqrt(s / buf.length);
      if (meterBar.current) meterBar.current.style.width = `${Math.min(1, rms * 4) * 100}%`;
      levelDb.current = 20 * Math.log10(rms + 1e-9);
      let pk = 0;
      for (const v of buf) pk = Math.max(pk, Math.abs(v));
      peakDb.current = 20 * Math.log10(pk + 1e-9);
      meterRaf.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(meterRaf.current); // medidor do microfone anterior (se reabriu)
    tick();
    return stream.current;
  };

  const upload = async (s: Shot, blob: Blob) => {
    setUp((u) => ({ ...u, [s.id]: 'uploading' }));
    try {
      const r = await fetch(`/api/projects/${id}/narration?shot=${s.id}`, { method: 'POST', body: blob, headers: { 'content-type': blob.type || 'audio/webm' } });
      if (!r.ok) throw new Error(await r.text());
      const rec = await r.json();
      setNar((n) => ({ ...n, items: { ...n.items, [s.id]: rec } }));
      setUp((u) => ({ ...u, [s.id]: 'ok' }));
    } catch (e) {
      setUp((u) => ({ ...u, [s.id]: 'error' }));
      setErr(`Parte ${shots.indexOf(s) + 1}: ${(e as Error).message}`);
    }
  };

  /** Começa a gravar a parte idx. O gravador anterior (se houver) é encerrado logo depois, sem buraco no áudio. */
  const startPart = async (idx: number) => {
    const ms = await ensureMic();
    const s = shots[idx];
    const mime = pickMime();
    const r = new MediaRecorder(ms, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => upload(s, new Blob(chunks, { type: r.mimeType || mime || 'audio/webm' }));
    r.start();
    const old = recorder.current;
    recorder.current = r;
    old?.stop();
    setRecIdx(idx);
    setSel(idx);
    setRecStart(performance.now());
  };

  const stopRec = useCallback(() => {
    recorder.current?.stop();
    recorder.current = null;
    setRecIdx(null);
  }, []);

  const start = async (idx: number, cont: boolean) => {
    setErr('');
    (document.activeElement as HTMLElement | null)?.blur(); // o botão clicado não pode ficar com o foco (o espaço o clicaria de novo)
    stopPlay();
    setContinuous(cont);
    try {
      await startPart(idx);
    } catch (e) {
      setErr(`Microfone: ${(e as Error).message}. Libere o acesso ao microfone no navegador.`);
    }
  };

  /** Próxima parte (ou termina, na regravação de uma parte só / na última). */
  const nextPart = () => {
    if (recIdx === null) return;
    if (continuous && recIdx + 1 < shots.length) startPart(recIdx + 1);
    else stopRec();
  };
  const nextRef = useRef(nextPart);
  nextRef.current = nextPart;
  const stopRef = useRef(stopRec);
  stopRef.current = stopRec;
  const recRef = useRef(recIdx);
  recRef.current = recIdx;

  // Avançar enquanto grava: ESPAÇO, seta →/↓, Enter, PageDown ou rolar o mouse para baixo. ESC para.
  // Escuta na fase de captura e engole também o "soltar" do espaço: assim nenhum botão com foco é clicado por engano.
  useEffect(() => {
    const isField = (t: EventTarget | null) => ['INPUT', 'TEXTAREA', 'SELECT'].includes((t as HTMLElement)?.tagName);
    const NEXT = ['Space', 'ArrowRight', 'ArrowDown', 'Enter', 'NumpadEnter', 'PageDown'];
    const onKeyDown = (e: KeyboardEvent) => {
      if (recRef.current === null || isField(e.target)) return;
      if (NEXT.includes(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) nextRef.current();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        stopRef.current();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (recRef.current !== null && (e.code === 'Space' || e.code === 'Enter') && !isField(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    let lastWheel = 0;
    const onWheel = (e: WheelEvent) => {
      if (recRef.current === null) return;
      e.preventDefault(); // gravando: a rolagem serve só para avançar
      if (e.deltaY > 20 && performance.now() - lastWheel > 700) {
        lastWheel = performance.now();
        nextRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('wheel', onWheel, true);
    };
  }, []);

  // cronômetro da parte gravando
  useEffect(() => {
    if (recIdx === null) return;
    const t = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(t);
  }, [recIdx]);

  // fecha o microfone ao sair da página
  useEffect(
    () => () => {
      recorder.current?.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(meterRaf.current);
    },
    [],
  );

  // ---------- reprodução (sua voz com efeitos + vídeo) ----------
  function stopPlay() {
    playToken.current++;
    audio.current?.pause();
    if (audio.current) audio.current.loop = false;
    setPlaying(null);
    setTPlay(undefined);
  }
  // loop da parte atual: toca repetindo e, a cada ajuste nos efeitos, troca para a versão nova (~0,5 s depois de parar de mexer)
  useEffect(() => {
    if (playing !== 'loop' || !shot || !recOf(shot)) return;
    const t = setTimeout(() => {
      const a = audio.current ?? (audio.current = new Audio());
      a.loop = true;
      a.ontimeupdate = () => setTPlay(a.currentTime);
      a.onended = null;
      a.src = audioUrl(shot);
      a.play().catch(() => {});
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, fxKey, sel, shot && nar.items[shot.id]?.at]);

  // a sequência lê sempre os efeitos e gravações mais novos (dá para ajustar a voz com ela tocando)
  const urlRef = useRef(audioUrl);
  urlRef.current = audioUrl;
  const hasRec = useRef((s: Shot) => !!recOf(s));
  hasRec.current = (s: Shot) => !!recOf(s);

  /** Toca partes em sequência com a prévia acompanhando. repeat = volta ao começo no fim (loop de tudo). */
  const playSeq = async (list: number[], mode: 'one' | 'all' | 'loopAll', repeat = false) => {
    stopPlay();
    if (!list.length) return;
    const token = playToken.current;
    setPlaying(mode);
    do {
      for (const [k, i] of list.entries()) {
        if (token !== playToken.current) break;
        setSel(i);
        const s = shots[i];
        // prepara a próxima no servidor (efeitos aplicados) enquanto esta toca: sem pausa entre as partes
        const nxt = list[k + 1] ?? (repeat ? list[0] : undefined);
        if (nxt !== undefined && hasRec.current(shots[nxt])) fetch(urlRef.current(shots[nxt])).catch(() => {});
        if (hasRec.current(s)) {
          const a = audio.current ?? (audio.current = new Audio());
          a.loop = false;
          a.src = urlRef.current(s);
          await new Promise<void>((resolve) => {
            const stop = setInterval(() => token !== playToken.current && (clearInterval(stop), a.pause(), resolve()), 100);
            const done = () => (clearInterval(stop), resolve());
            a.ontimeupdate = () => token === playToken.current && setTPlay(a.currentTime);
            a.onended = done;
            a.onerror = done;
            a.play().catch(done);
          });
        } else {
          // parte sem gravação: mostra o tempo planejado em silêncio
          const t0 = performance.now();
          const d = previewShots[i].duration * 1000;
          await new Promise<void>((resolve) => {
            const tick = setInterval(() => {
              if (token !== playToken.current) return clearInterval(tick), resolve();
              const el = performance.now() - t0;
              setTPlay(el / 1000);
              if (el >= d) clearInterval(tick), resolve();
            }, 50);
          });
        }
      }
    } while (repeat && token === playToken.current);
    if (token === playToken.current) stopPlay();
  };
  const playFrom = (idx: number, all: boolean) => playSeq(all ? shots.map((_, i) => i).slice(idx) : [idx], all ? 'all' : 'one');
  /** Todas as partes já gravadas, em ordem, repetindo. */
  const loopAllRecorded = () => playSeq(shots.flatMap((s, i) => (recOf(s) ? [i] : [])), 'loopAll', true);

  // ---------- efeitos ----------
  const saveFx = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setFx = (patch: Partial<VoiceFx>) => {
    const next = normalizeFx({ ...fx, ...patch });
    setNar((n) => ({ ...n, fx: next }));
    clearTimeout(saveFx.current);
    saveFx.current = setTimeout(() => fetch(`/api/projects/${id}/narration`, { method: 'PUT', body: JSON.stringify({ fx: next }) }), 400);
  };

  const useMyVoice = async () => {
    await fetch(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify({ narration: 'mic' }) });
    setP((x) => (x ? { ...x, narration: 'mic' } : x));
  };

  const removeRec = async (s: Shot) => {
    if (!confirm(`Apagar a gravação da parte ${shots.indexOf(s) + 1}?`)) return;
    await fetch(`/api/projects/${id}/narration?shot=${s.id}`, { method: 'DELETE' });
    loadNar();
  };

  if (!p) return <p className="text-sm text-muted-foreground">{err || 'Carregando…'}</p>;
  if (!shots.length) return <p className="text-sm text-muted-foreground">A linha do tempo está vazia. Monte as partes no editor primeiro.</p>;

  const r = shot ? cleanRect(shot.focus) : null;
  const c = shot && page ? cropPx(shot.focus, page.width, page.height) : null;
  const elapsed = recIdx !== null ? (now - recStart) / 1000 : 0;
  const slider = (label: string, key: keyof VoiceFx, min: number, max: number, step: number, unit = '') => (
    <label className="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input type="range" min={min} max={max} step={step} value={fx[key] as number} onChange={(e) => setFx({ [key]: Number(e.target.value) })} onDoubleClick={() => setFx({ [key]: FX_NEUTRAL[key] })} />
      <span className="text-right tabular-nums">
        {(fx[key] as number).toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)}
        {unit}
      </span>
    </label>
  );
  const toggle = (label: string, key: keyof VoiceFx) => (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={fx[key] as boolean} onChange={(e) => setFx({ [key]: e.target.checked })} />
      {label}
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/p/${id}`} className="btn">
          ← Voltar ao editor
        </Link>
        <h1 className="text-lg font-semibold">Minha narração · {p.title}</h1>
        <span className="text-sm text-muted-foreground">
          {recorded}/{shots.length} partes gravadas · {fmtDuration(totalDur)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {p.narration === 'mic' ? (
            <span className="rounded-md border border-primary px-2 py-1 text-xs text-primary">O vídeo usa a sua voz</span>
          ) : (
            <button className="btn-primary" onClick={useMyVoice} title="Troca a narração do projeto para a sua voz gravada">
              Usar minha voz no vídeo
            </button>
          )}
        </div>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
        {/* ESQUERDA: prévia com a sua voz + efeitos */}
        <section className="space-y-3">
          <Preview projectId={p.id} format={p.format} shots={previewShots} pages={p.pages} selected={sel} onSelect={setSel} subtitles={!!p.subtitles} externalTime={tPlay} hideControls />
          <div className="flex flex-wrap gap-2 text-sm">
            <button className="btn" disabled={recIdx !== null || !recOf(shot)} onClick={() => (playing ? stopPlay() : playFrom(sel, false))}>
              {playing === 'one' ? '⏸' : '▶'} Ouvir esta parte
            </button>
            <button className="btn" disabled={recIdx !== null || !recorded} onClick={() => (playing ? stopPlay() : playFrom(sel, true))}>
              {playing === 'all' ? '⏸' : '▶'} Ouvir com o vídeo daqui
            </button>
            <button className={`btn ${playing === 'loopAll' ? 'border-primary text-primary' : ''}`} disabled={recIdx !== null || !recorded} title="Toca em sequência todas as partes que você já gravou, com o vídeo, e recomeça no fim. Ajuste os efeitos com ele tocando." onClick={() => (playing === 'loopAll' ? stopPlay() : loopAllRecorded())}>
              🔁 {playing === 'loopAll' ? 'Parar loop de tudo' : `Loop de tudo que narrei (${recorded})`}
            </button>
            <button className={`btn ${playing === 'loop' ? 'border-primary text-primary' : ''}`} disabled={recIdx !== null || !recOf(shot)} title="Repete esta parte enquanto você ajusta os efeitos; cada ajuste já entra no próximo trecho" onClick={() => (playing === 'loop' ? stopPlay() : (stopPlay(), setPlaying('loop')))}>
              🔂 {playing === 'loop' ? 'Parar loop' : 'Loop desta parte'}
            </button>
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-sm font-medium">Efeitos de voz</span>
              <button className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted" onClick={() => setFx(FX_NEUTRAL)}>
                Sem efeito
              </button>
            </div>
            {(['Limpeza'] as const).map((g) => (
              <div key={g} className="flex flex-wrap items-center gap-1">
                <span className="w-24 text-xs text-muted-foreground">{g}</span>
                {FX_PRESETS.filter((pr) => pr.group === g).map((pr) => (
                  <button key={pr.id} className="rounded-md border px-2 py-0.5 text-xs hover:bg-muted" title={pr.note} onClick={() => setFx(pr.fx)}>
                    {pr.name}
                  </button>
                ))}
              </div>
            ))}

            <div className="pt-1 text-xs font-medium text-muted-foreground">Voz</div>
            {slider('Tom', 'pitch', -6, 6, 0.5, ' st')}
            {slider('Timbre', 'timbre', -1, 1, 0.05)}
            {slider('Velocidade', 'speed', 0.75, 1.5, 0.01, '×')}
            {slider('Encurtar pausas', 'tightPauses', 0, 1, 0.05)}
            <div className="pt-1 text-xs font-medium text-muted-foreground">Cor do som</div>
            {slider('Sub-grave (cinema)', 'sub', 0, 1, 0.05)}
            {slider('Graves', 'bass', -10, 10, 1, ' dB')}
            {slider('Corpo (calor)', 'warmth', -8, 8, 1, ' dB')}
            {slider('Clareza', 'presence', -8, 8, 1, ' dB')}
            {slider('Agudos', 'treble', -10, 10, 1, ' dB')}
            {slider('Ar / brilho', 'air', 0, 1, 0.05)}
            {slider('Saturação (calor)', 'saturation', 0, 1, 0.05)}
            <div className="pt-1 text-xs font-medium text-muted-foreground">Limpeza e acabamento</div>
            {slider('Tirar ruído', 'denoise', 0, 1, 0.05)}
            {slider('Compressão', 'compress', 0, 1, 0.05)}
            {slider('Voz dobrada', 'double', 0, 1, 0.05)}
            {slider('Ambiente (eco)', 'reverb', 0, 1, 0.05)}
            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
              {toggle('Cortar som entre frases', 'gate')}
              {toggle('Tirar estalos de boca', 'declick')}
              {toggle('Suavizar "S"', 'deesser')}
              {toggle('Rádio antigo', 'radio')}
              {toggle('Volume padrão (YouTube)', 'normalize')}
            </div>
            <p className="text-xs text-muted-foreground">Clique duas vezes num controle para zerar. Ouça uma parte para conferir: a prévia e o vídeo usam exatamente estes efeitos.</p>
          </div>
        </section>

        {/* MEIO: imagem da parte */}
        <section className="space-y-2">
          <div className="text-sm text-muted-foreground">
            Parte {sel + 1} de {shots.length}
            {page ? ` · ${page.chapter}` : ''}
          </div>
          {page && r && c && (
            <div className="relative mx-auto overflow-hidden rounded-md bg-black" style={{ aspectRatio: `${c.w} / ${c.h}`, maxHeight: '70vh' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={pageUrl(p.id, page)}
                alt=""
                className="absolute max-w-none"
                style={{ width: `${100 / (r.x1 - r.x0)}%`, height: `${100 / (r.y1 - r.y0)}%`, left: `${(-r.x0 / (r.x1 - r.x0)) * 100}%`, top: `${(-r.y0 / (r.y1 - r.y0)) * 100}%` }}
              />
            </div>
          )}
        </section>

        {/* DIREITA: gravar + teleprompter (parte atual e as próximas, rolando sozinho) */}
        <section className="space-y-3">
          {recIdx !== null ? (
            <div className="space-y-2 rounded-lg border-2 border-red-500 p-3">
              <div className="flex items-center gap-2 font-medium">
                <span className="size-3 animate-pulse rounded-full bg-red-500" />
                Gravando parte {recIdx + 1} de {shots.length} · {fmt(elapsed)}
              </div>
              <div className="h-2 rounded bg-muted">
                <div ref={meterBar} className="h-2 w-0 rounded bg-red-500 transition-[width]" />
              </div>
              <div className="flex gap-2">
                <button className="btn-primary flex-1 justify-center py-3 text-base" onMouseDown={(e) => e.preventDefault()} onClick={nextPart}>
                  {continuous && recIdx + 1 < shots.length ? 'Próxima parte ⟶' : '✔ Terminar'}
                </button>
                <button className="btn" onMouseDown={(e) => e.preventDefault()} onClick={stopRec}>
                  ■ Parar
                </button>
              </div>
              <p className="text-sm text-muted-foreground">
                Para avançar: <kbd className="rounded border px-1.5">Espaço</kbd>, <kbd className="rounded border px-1.5">→</kbd>, <kbd className="rounded border px-1.5">Enter</kbd> ou <b>role o mouse para baixo</b>. <kbd className="rounded border px-1.5">Esc</kbd> para.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <button className="btn-primary py-3 text-base" onClick={() => start(sel, true)}>
                  ● Narrar a partir da parte {sel + 1}
                </button>
                <button className="btn" onClick={() => start(sel, false)}>
                  {recOf(shot) ? '↻ Refazer só esta parte' : '● Gravar só esta parte'}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Narre em sequência: leia a parte destacada e, no fim da frase, aperte <b>Espaço</b> (ou role o mouse para baixo). A próxima já começa a gravar, sem parar o microfone. Os silêncios das pontas são aparados sozinhos.
              </p>
            </div>
          )}

          {recIdx === null && (
            <div className="space-y-1 rounded-lg border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn h-8 py-0 text-xs" disabled={micTest.running} onClick={testMic}>
                  {micTest.running ? 'Ouvindo…' : '🎤 Testar microfone'}
                </button>
                <label className="flex items-center gap-1.5" title="Corta ruído já na gravação, mas pode deixar a voz abafada. Desligado, a limpeza fica com 'Tirar ruído' dos efeitos.">
                  <input
                    type="checkbox"
                    checked={browserNs}
                    onChange={(e) => {
                      setBrowserNs(e.target.checked);
                      stream.current?.getTracks().forEach((t) => t.stop()); // reabre o microfone com a nova opção
                      stream.current = null;
                    }}
                  />
                  Supressão de ruído do navegador
                </label>
              </div>
              {micTest.msg && <p className={micTest.ok ? 'text-primary' : micTest.running ? 'text-muted-foreground' : 'text-destructive'}>{micTest.msg}</p>}
            </div>
          )}

          <div ref={prompter} className="relative max-h-[60vh] space-y-2 overflow-auto rounded-lg border p-3">
            {shots.map((s, i) =>
              (
                <div
                  key={s.id}
                  data-part={i}
                  onClick={() => recIdx === null && setSel(i)}
                  className={`cursor-pointer rounded-md p-2 transition-colors ${i === sel ? (recIdx === i ? 'border-2 border-red-500 bg-red-500/10' : 'border-2 border-primary bg-primary/10') : 'opacity-60 hover:opacity-90'}`}
                >
                  <div className="mb-0.5 text-xs text-muted-foreground">
                    Parte {i + 1}
                    {recOf(s) ? ' · ✔ gravada' : ''}
                  </div>
                  <p className={`whitespace-pre-wrap leading-relaxed ${i === sel ? 'text-xl' : 'text-base'}`}>{s.text || <span className="text-muted-foreground">(sem texto: narre livremente o que acontece)</span>}</p>
                </div>
              ),
            )}
          </div>
        </section>
      </div>

      {/* LISTA DAS PARTES */}
      <section className="rounded-lg border">
        <div className="border-b px-3 py-2 text-sm font-medium">Partes</div>
        <ol className="max-h-80 divide-y overflow-auto text-sm">
          {shots.map((s, i) => {
            const rec = recOf(s);
            return (
              <li key={s.id} className={`flex items-center gap-2 px-3 py-1.5 ${i === sel ? 'bg-muted' : ''}`}>
                <button className="w-10 shrink-0 text-left tabular-nums text-muted-foreground" onClick={() => setSel(i)}>
                  {i + 1}
                </button>
                <button className="min-w-0 flex-1 truncate text-left" onClick={() => setSel(i)} title={s.text}>
                  {s.text || <span className="text-muted-foreground">(sem texto)</span>}
                </button>
                <span className="w-24 shrink-0 text-right text-xs">
                  {up[s.id] === 'uploading' ? 'salvando…' : up[s.id] === 'error' ? <span className="text-destructive">erro</span> : rec ? <span className="text-primary">✔ {rec.dur.toFixed(1)} s</span> : <span className="text-muted-foreground">—</span>}
                </span>
                <button className="rounded px-1.5 hover:bg-muted disabled:opacity-30" disabled={!rec || recIdx !== null} title="Ouvir" onClick={() => playFrom(i, false)}>
                  ▶
                </button>
                <button className="rounded px-1.5 hover:bg-muted disabled:opacity-30" disabled={recIdx !== null} title={rec ? 'Refazer esta parte' : 'Gravar esta parte'} onClick={() => start(i, false)}>
                  {rec ? '↻' : '●'}
                </button>
                <button className="rounded px-1.5 hover:bg-muted disabled:opacity-30" disabled={!rec || recIdx !== null} title="Apagar gravação" onClick={() => removeRec(s)}>
                  ✕
                </button>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
