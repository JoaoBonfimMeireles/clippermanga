// Render final: um segmento por parte (recorte do foco com laterais desfocadas + câmera do lib/camera.ts,
// a mesma da prévia), legenda queimada e áudio (silêncio no modo texto, TTS no modo voz), depois concat sem recodificar.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { MANGA_SIZES } from '@clipper/shared';
import { dataPaths, getAppSettings } from '@clipper/shared/server';
import { runFfmpeg } from '@clipper/video-processing';
import { audioDuration, fileHash } from './media';
import { cropPx, effSize, frameAt, isPan, rotateFilter, bgBandRange } from './camera';
import { projectDir, readProject, updateProject } from './store';
import { dropSilentShots, hasSpeech } from './speech-only';
import { needsPanelCrops, wholeTallPageShots } from './crop-guard';
import { cachedSpeechFile, isSpeechCached, synthesizeSpeech } from './voice';
import { narrateInBlocks } from './voice-blocks';
import { processedRecording } from './narration';
import { cutWordsFromAudio, hasCutWord, prepareWordCuts, stripWords } from './wordcut';
import type { JobCtx } from './jobs';
import type { ShotView, StudioPage, StudioProject } from './types';
import { renderSig } from './sig';
import { mapPool, renderConcurrency, serial } from './pool';
import { planSpeechGains, polishSpeech } from './speech-polish';
import { cleanSpeechText } from './speech-text';

const FPS = 30;

const srtTime = (t: number) => {
  const ms = Math.max(0, Math.round(t * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

/** Legenda em blocos de ~7 palavras, tempo proporcional ao tamanho de cada bloco. */
function srtFor(text: string, dur: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 7) chunks.push(words.slice(i, i + 7).join(' '));
  const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
  let t = 0;
  return chunks
    .map((c, i) => {
      const d = (c.length / total) * dur;
      const s = `${i + 1}\n${srtTime(t)} --> ${srtTime(t + d)}\n${c}\n`;
      t += d;
      return s;
    })
    .join('\n');
}

/**
 * extra: renderiza uma versão do projeto (ex.: um short vertical com parte da linha do tempo) num arquivo à parte,
 * sem mexer no vídeo principal (lastRender). Usa os mesmos caches de voz e de partes.
 */
export interface RenderExtra {
  project: StudioProject;
  /** Pasta de saída, relativa à pasta do projeto (ex.: videos/shorts). */
  outDir: string;
  /** Nome do arquivo (sem extensão). */
  name: string;
  /** Com o final suave (silêncio de `project.endSilence` s com a última imagem). Os shorts do Diretor usam. */
  tail?: boolean;
}

/** Corta o silêncio do começo (se não há cortes manuais, cujos tempos dependem do áudio original) e do fim da fala; devolve a duração da parte: fala + respiro de 0,06 s, nunca a duração "planejada". */
async function trimTailSilence(wav: string, work: string, n: string, fallback: number, signal?: AbortSignal, head = true, keepTail = 0): Promise<number> {
  const out = path.join(work, `audio_${n}_trim.wav`);
  const edge = 'start_periods=1:start_threshold=-38dB:start_silence=0.04';
  // última fala do vídeo (keepTail > 0): não corta o fim (o limiar de silêncio comia o final da palavra) e ganha folga
  const af = keepTail > 0 ? (head ? `silenceremove=${edge}` : 'anull') : `${head ? `silenceremove=${edge},` : ''}areverse,silenceremove=${edge},areverse`;
  try {
    await runFfmpeg(['-y', '-i', wav, '-af', af, '-ar', '48000', '-ac', '2', out], { signal });
    const d = await audioDuration(out);
    if (d > 0.3) {
      fs.copyFileSync(out, wav);
      return d + (keepTail > 0 ? keepTail : 0.06);
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return fallback + 0.1 + keepTail;
}

/** Apaga (sem travar o servidor) pastas de trabalho de renders antigos que falharam/foram cancelados: >24 h sem mexer. */
async function sweepStaleWork(): Promise<void> {
  try {
    const now = Date.now();
    for (const name of await fs.promises.readdir(dataPaths.temp)) {
      if (!name.startsWith('manga-studio-')) continue;
      const dir = path.join(dataPaths.temp, name);
      const st = await fs.promises.stat(dir).catch(() => null);
      if (st && now - st.mtimeMs > 24 * 3600_000) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  } catch {
    /* limpeza é só conveniência */
  }
}

/**
 * Poda depois de um render principal bem-sucedido (em segundo plano, nunca derruba o job):
 * - segmentos do cache que não entraram neste render e têm mais de 24 h (os recentes ficam: polir/inglês podem usá-los);
 * - versões antigas do vídeo na pasta videos/ (só o último fica; shorts e subpastas não são tocados).
 */
async function pruneAfterRender(segCache: string, outDir: string, out: string, used: string[], log: (m: string) => void): Promise<void> {
  try {
    const keep = new Set(used.flatMap((f) => [f, `${f}.json`]));
    const now = Date.now();
    let segs = 0, bytes = 0;
    for (const f of await fs.promises.readdir(segCache)) {
      if (keep.has(f)) continue;
      const full = path.join(segCache, f);
      const st = await fs.promises.stat(full).catch(() => null);
      if (!st || now - st.mtimeMs < 24 * 3600_000) continue;
      await fs.promises.rm(full, { force: true });
      bytes += st.size;
      if (f.endsWith('.mp4')) segs++;
    }
    let old = 0;
    for (const e of await fs.promises.readdir(outDir, { withFileTypes: true })) {
      if (!e.isFile() || !/\.mp4$/i.test(e.name)) continue;
      const full = path.join(outDir, e.name);
      if (path.resolve(full) === path.resolve(out)) continue;
      const st = await fs.promises.stat(full).catch(() => null);
      await fs.promises.rm(full, { force: true }).then(() => { old++; bytes += st?.size ?? 0; }).catch(() => {});
    }
    if (segs || old) log(`Limpeza: ${segs} segmento(s) e ${old} vídeo(s) antigo(s) removidos (${(bytes / 1e9).toFixed(2)} GB)`);
  } catch {
    /* limpeza é só conveniência */
  }
}

/** Render com limpeza garantida da pasta de trabalho, mesmo se falhar ou for cancelado. */
export async function renderProject(projectId: string, ctx: JobCtx, signal?: AbortSignal, opts: { cacheOnly?: boolean; extra?: RenderExtra } = {}): Promise<string> {
  const track: { work?: string } = {};
  void sweepStaleWork();
  try {
    return await renderProjectInner(projectId, ctx, signal, opts, track);
  } finally {
    if (track.work) await fs.promises.rm(track.work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

async function renderProjectInner(projectId: string, ctx: JobCtx, signal: AbortSignal | undefined, opts: { cacheOnly?: boolean; extra?: RenderExtra }, track: { work?: string }): Promise<string> {
  const p = opts.extra?.project ?? readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  if (!p.shots.length) throw new Error('A linha do tempo está vazia');
  if (p.narration !== 'mic' && !Object.keys(p.pageScript ?? {}).length) throw new Error('Faça os passos 1 (Gerar roteiro) e 2 (Editar com IA) antes de renderizar.');
  if (needsPanelCrops(p)) {
    throw new Error(`${wholeTallPageShots(p)} de ${p.shots.length} partes mostram a página inteira (tiras de webtoon ficam ilegíveis). Rode "Gerar roteiro": ele recorta por quadro (edição com IA) antes de escrever a narração.`);
  }
  // regra fixa: nenhuma imagem sem fala. Parte sem texto sai da linha do tempo (microfone é exceção)
  if (p.narration !== 'mic') {
    const kept = p.shots.filter(hasSpeech);
    if (!kept.length) throw new Error('Nenhuma parte tem narração: rode "Gerar roteiro" antes de renderizar (toda imagem precisa de fala).');
    if (kept.length !== p.shots.length) {
      ctx.log(`${p.shots.length - kept.length} parte(s) sem fala removidas: toda imagem precisa de narração`);
      if (!opts.extra) dropSilentShots(projectId);
      p.shots = kept;
    }
  }
  // texto que vai para a voz: sem sons de luta, risadas escritas nem marcações de cena (viram ruído na voz de IA)
  if (p.narration === 'voice') {
    const cleaned = new Map<string, string>();
    for (const s of p.shots) {
      const c = cleanSpeechText(s.text);
      if (c !== s.text) cleaned.set(s.id, c);
    }
    if (cleaned.size) {
      ctx.log(`${cleaned.size} texto(s) com sons/risadas escritos foram limpos antes da voz`);
      for (const s of p.shots) if (cleaned.has(s.id)) s.text = cleaned.get(s.id)!;
      if (!opts.extra) updateProject(projectId, (cur) => cur.shots.forEach((s) => cleaned.has(s.id) && (s.text = cleaned.get(s.id)!)));
    }
  }
  const { w: W, h: H } = MANGA_SIZES[p.format];
  const CW = W * 2; // tela em 2x: o zoom fica nítido e sem tremido
  const CH = H * 2;
  const nvenc = getAppSettings().hwAccel === 'nvenc';
  const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
  const enc = nvenc ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '21'] : x264;
  const work = path.join(dataPaths.temp, `manga-studio-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  track.work = work;
  const pageById = new Map(p.pages.map((x) => [x.id, x]));

  // Narração com voz do Gemini: gerada antes, em blocos de ~5 min (poucas chamadas), e cortada uma fala por parte
  const ttsCache = path.join(projectDir(p.id), '.progress', 'tts');
  // só reaproveitar a voz já gerada: se faltar alguma fala no cache, para antes de gastar
  if (opts.cacheOnly && p.narration === 'voice') {
    const missing = p.shots.filter((s) => s.text.trim() && !isSpeechCached(s.text, p.voice, ttsCache)).length;
    if (missing) throw new Error(`${missing} fala(s) não estão no cache de voz; renderizar agora gastaria voz. Nada foi feito.`);
    ctx.log('Usando só a voz já gerada (cache): nenhuma chamada de voz');
  }
  const narrated =
    p.narration === 'voice'
      ? await narrateInBlocks(
          p.shots.map((s) => ({ id: s.id, text: s.text, group: pageById.get(s.pageId)?.chapter ?? '' })),
          { voiceId: p.voice, cacheDir: ttsCache, workDir: work, signal, onNotice: ctx.log, onProgress: (d, n) => ctx.progress((d / n) * 0.3, `Gerando narração (bloco ${Math.min(d + 1, n)}/${n})`) },
        )
      : new Map();
  const base = narrated.size ? 0.3 : 0; // parte da barra que já foi da narração
  // volume único em todas as falas (troca de fala/bloco sem salto de volume)
  const gains = narrated.size ? await planSpeechGains(new Map([...narrated].map(([id, r]) => [id, r.file])), work, signal) : new Map<string, number>();
  if (gains.size) ctx.log(`Volume: ${gains.size} fala(s) serão niveladas ao volume padrão`);

  const cutWords = (p.cutWords ?? []).filter((w) => w.trim());
  let wordCuts = 0;
  if (cutWords.length && p.narration === 'voice') {
    // uma transcrição só para todas as falas com a palavra (o Whisper carregar a cada parte seria muito lento)
    const wavs = p.shots
      .filter((s) => hasCutWord(s.text, cutWords))
      .map((s) => narrated.get(s.id)?.file ?? cachedSpeechFile(s.text, p.voice, ttsCache))
      .filter((f): f is string => !!f);
    ctx.progress(base, 'Procurando as palavras a cortar');
    await prepareWordCuts(wavs, cutWords, ttsCache, ctx.log, signal).catch((err) => {
      if (signal?.aborted) throw err;
      ctx.log(`Busca das palavras em lote falhou (${String((err as Error).message).split('\n').pop()?.slice(0, 120)}); seguindo parte por parte`);
    });
  }
  const segCache = path.join(projectDir(p.id), '.progress', 'segs');
  fs.mkdirSync(segCache, { recursive: true });
  // TTS (cota/limite de chamadas) e Whisper (memória) não rodam em paralelo; o ffmpeg de cada parte, sim
  const oneAtATime = serial();
  const conc = renderConcurrency(nvenc);
  if (conc > 1 && p.shots.length > 1) ctx.log(`Renderizando até ${conc} partes ao mesmo tempo`);
  let finished = 0;
  const tick = (i: number, cached: boolean) => {
    finished++;
    ctx.progress(base + (finished / p.shots.length) * (0.95 - base), cached ? `Parte ${i + 1}/${p.shots.length} sem mudança (cache)` : `Renderizando parte ${i + 1}/${p.shots.length} (${finished}/${p.shots.length} prontas)`);
  };
  type SegOut = { seg: string; D: number; wordCuts: number; cached: boolean; sp: number } | null;

  const renderShot = async (shot: (typeof p.shots)[number], i: number): Promise<SegOut> => {
    if (signal?.aborted) throw new Error('cancelado');
    const pg = pageById.get(shot.pageId);
    if (!pg) return null;
    const n = String(i).padStart(4, '0');
    const img = path.join(projectDir(p.id), pg.file);
    const sp = Math.min(4, Math.max(0.25, shot.speed ?? 1));
    const isLast = i === p.shots.length - 1;
    const endPad = Math.min(10, Math.max(0, p.endTalkPad ?? 0.8));
    // 0) Cache por parte: mesma parte (recorte, câmera, texto, cortes, velocidade, áudio) = reaproveita o segmento
    //    já renderizado e pula direto; só as partes mexidas são renderizadas de novo.
    const pre = narrated.get(shot.id);
    // (antes processedRecording rodava duas vezes por parte, cada uma com um ffprobe)
    const mine = p.narration === 'mic' ? await processedRecording(p.id, shot.id) : null;
    const audioSig = [pre?.file, mine?.file].filter((f): f is string => !!f && fs.existsSync(f)).map(fileHash).join(',') // mesmo sha1 do conteúdo, mas lembrado entre renders;
    const segKey = createHash('sha1')
      .update(JSON.stringify({ v: 3, ...(isLast ? { endPad } : {}), ...(gains.get(shot.id) ? { gain: gains.get(shot.id) } : {}), W, H, sub: !!p.subtitles, nar: p.narration, voice: p.voice, page: [pg.file, pg.width, pg.height], audioSig, cut: hasCutWord(shot.text, cutWords) ? cutWords : [], s: { ...shot, id: undefined, kind: undefined, impact: undefined, newImage: undefined } }))
      .digest('hex')
      .slice(0, 24);
    const cachedSeg = path.join(segCache, `${segKey}.mp4`);
    if (fs.existsSync(cachedSeg) && fs.existsSync(`${cachedSeg}.json`)) {
      const meta = JSON.parse(fs.readFileSync(`${cachedSeg}.json`, 'utf8')) as { D: number; wordCuts?: number };
      // entra no concat direto do cache (sem copiar o arquivo para a pasta de trabalho)
      tick(i, true);
      return { seg: cachedSeg, D: meta.D, wordCuts: meta.wordCuts ?? 0, cached: true, sp };
    }
    let wordCuts = 0;
    // 1) Cada imagem da parte: a principal e as extras mostradas DURANTE a mesma fala (a voz não para).
    //    Recorte do foco na resolução original. Parado/zoom leve: tela pronta (recorte + laterais desfocadas)
    //    e a câmera aproxima/afasta sobre ela. Pan: o recorte em tela cheia, percorrido por uma janela.
    const views: ShotView[] = [shot, ...(shot.extra ?? [])];
    const prepared: { canvas: string; pan: boolean; vpg: StudioPage; v: ShotView; adj: { rotate?: number; stretch?: number; zoom?: number } }[] = [];
    for (const [k, v] of views.entries()) {
      const vpg = pageById.get(v.pageId) ?? pg;
      const vimg = path.join(projectDir(p.id), vpg.file);
      const c = cropPx(v.focus, vpg.width, vpg.height);
      const adj = { rotate: v.rotate, stretch: v.stretch, zoom: v.zoom };
      const ef = effSize(c, adj);
      // recorte → girar (0/90/180/270)
      const crop = `crop=${c.w}:${c.h}:${c.x}:${c.y}${rotateFilter(adj)}`;
      const pan = isPan(v.focus, v.motion, v.fit, vpg.width, vpg.height, W / H, adj);
      const canvas = path.join(work, `canvas_${n}_${k}.jpg`);
      if (pan) {
        const tall = ef.w / ef.h < W / H;
        const stretchF = ef.s !== 1 ? `,scale=trunc(iw*${ef.s.toFixed(3)}/2)*2:ih:flags=lanczos` : '';
        await runFfmpeg(['-i', vimg, '-vf', `${crop}${stretchF},${tall ? `scale=${CW}:-2` : `scale=-2:${CH}`}:flags=lanczos`, '-frames:v', '1', '-q:v', '2', canvas], { signal });
      } else {
        // mesmo quadro da prévia: o recorte (girado) escalado para a caixa exata (esticar/aproximar/encaixe) e posto no lugar
        const box = frameAt(v.focus, v.motion, v.fit, vpg.width, vpg.height, W / H, 0, adj).content;
        const ev = (x: number) => Math.max(2, Math.round(x / 2) * 2);
        const fw = ev(box.w * CW), fh = ev(box.h * CH);
        const [b0, b1] = bgBandRange(v.bgBand);
        const bgCrop = b1 - b0 < 1 ? `crop=iw:trunc(ih*${(b1 - b0).toFixed(3)}/2)*2:0:trunc(ih*${b0.toFixed(3)}),` : '';
        const ox = Math.round(box.x * CW), oy = Math.round(box.y * CH);
        await runFfmpeg(['-i', vimg, '-filter_complex', `[0:v]${crop},split[a][b];[a]${bgCrop}scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH},boxblur=30:3,eq=brightness=-0.15[bg];[b]scale=${fw}:${fh}:flags=lanczos[fg];[bg][fg]overlay=${ox}:${oy}`, '-frames:v', '1', '-q:v', '2', canvas], { signal });
      }
      prepared.push({ canvas, pan, vpg, v, adj });
    }

    // 2) Áudio: fala (modo voz) ou silêncio
    let D = Math.max(0.5, shot.duration);
    const wav = path.join(work, `audio_${n}.wav`);
    if (mine) {
      // sua voz gravada (com os efeitos): a parte dura exatamente a fala, para a narração seguir sem cortes
      fs.copyFileSync(mine.file, wav);
      D = Math.max(0.5, mine.dur);
    } else if (pre) {
      fs.copyFileSync(pre.file, wav);
      // a parte dura só a fala (sem silêncio sobrando): acabou a fala, já entra a próxima
      D = await trimTailSilence(wav, work, n, pre.dur, signal, !shot.audioCuts?.length, isLast ? endPad : 0);
    } else if (p.narration === 'voice' && shot.text.trim()) {
      const speech = await oneAtATime(() => synthesizeSpeech(shot.text, wav, { signal, voice: p.voice, cacheDir: ttsCache, onNotice: ctx.log }));
      D = await trimTailSilence(wav, work, n, speech, signal, !shot.audioCuts?.length, isLast ? endPad : 0);
    }
    // trechos cortados à mão no editor (tempos do áudio original da fala)
    const aCuts = (shot.audioCuts ?? []).filter(([a, b]) => b - a > 0.02);
    if (aCuts.length && fs.existsSync(wav)) {
      const before = (await audioDuration(wav));
      const cutWav = path.join(work, `audio_${n}_acut.wav`);
      const expr = aCuts.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+');
      await runFfmpeg(['-y', '-i', wav, '-af', `aselect='not(${expr})',asetpts=N/SR/TB`, '-ar', '48000', '-ac', '2', cutWav], { signal });
      fs.copyFileSync(cutWav, wav);
      D = Math.max(0.5, D - Math.max(0, before - (await audioDuration(wav))));
    }
    // velocidade da parte (acelerar/desacelerar): voz com atempo (sem mudar o tom) e parte mais curta
    if (Math.abs(sp - 1) > 0.01) {
      if (fs.existsSync(wav)) {
        const fast = path.join(work, `audio_${n}_speed.wav`);
        // atempo aceita 0,5–2 por filtro: encadeia para 0,25x ou 4x
        const parts: number[] = [];
        let rest = sp;
        while (rest > 2) (parts.push(2), (rest /= 2));
        while (rest < 0.5) (parts.push(0.5), (rest /= 0.5));
        parts.push(rest);
        const chain = parts.map((x) => `atempo=${x.toFixed(4)}`).join(',');
        await runFfmpeg(['-y', '-i', wav, '-af', chain, '-ar', '48000', '-ac', '2', fast], { signal });
        fs.copyFileSync(fast, wav);
      }
      D = Math.max(0.3, D / sp);
    }
    // palavras proibidas (ex.: "cara"): saem do áudio já narrado, sem gastar voz de novo
    if (cutWords.length && fs.existsSync(wav) && hasCutWord(shot.text, cutWords)) {
      const before = (await audioDuration(wav));
      const cutWav = path.join(work, `audio_${n}_cut.wav`);
      // falha no corte nunca derruba o render: a parte segue com o áudio original
      const r = await oneAtATime(() => cutWordsFromAudio(wav, cutWords, ttsCache, cutWav, signal)).catch((err) => {
        if (signal?.aborted) throw err;
        ctx.log(`Parte ${i + 1}: corte de palavras falhou (${String((err as Error).message).split('\n').pop()?.slice(0, 120)}); áudio mantido`);
        return null;
      });
      if (r) {
        fs.copyFileSync(cutWav, wav);
        D = Math.max(0.5, D - Math.max(0, before - r.dur));
        wordCuts += r.cuts;
      }
    }
    // voz de IA: volume parelho entre as falas (cada chamada/bloco vem com um ganho diferente) e fade curto nas pontas.
    // Por último, depois de cortes/velocidade, para medir e dar fade no áudio que realmente vai pro vídeo.
    const fixGain = gains.get(shot.id);
    if (!mine && fixGain && fs.existsSync(wav)) await polishSpeech(wav, work, n, fixGain, signal);
    const audioIn = fs.existsSync(wav) ? ['-i', wav] : ['-f', 'lavfi', '-t', D.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'];

    // 3) Câmera, com a mesma suavização da prévia (lib/camera.ts); com várias imagens, o tempo é dividido entre elas
    const Dk = D / prepared.length;
    const camOf = ({ pan, vpg, v, adj }: (typeof prepared)[number]) => {
      const N = Math.max(2, Math.round(Dk * FPS));
      const e = `(min(on/${N - 1},1)*min(on/${N - 1},1)*(3-2*min(on/${N - 1},1)))`;
      if (pan) {
        // janela do tamanho da tela andando pelo recorte; "t" do crop é o tempo desta imagem
        const et = `(min(t/${Dk.toFixed(3)},1)*min(t/${Dk.toFixed(3)},1)*(3-2*min(t/${Dk.toFixed(3)},1)))`;
        return `crop=w='min(iw,ih*${W}/${H})':h='min(ih,iw*${H}/${W})':x='(iw-ow)*${et}':y='(ih-oh)*${et}',scale=${W}:${H}:flags=lanczos,fps=${FPS}`;
      }
      const a = frameAt(v.focus, v.motion, v.fit, vpg.width, vpg.height, W / H, 0, adj).cam;
      const b = frameAt(v.focus, v.motion, v.fit, vpg.width, vpg.height, W / H, 1, adj).cam;
      const lerp = (u: number, w: number) => `(${u.toFixed(5)}+${(w - u).toFixed(5)}*${e})`;
      return `zoompan=z='1/${lerp(a.w, b.w)}':x='${lerp(a.x, b.x)}*iw':y='${lerp(a.y, b.y)}*ih':d=1:s=${W}x${H}:fps=${FPS}`;
    };
    let vf = prepared.map((x, k) => `[${k}:v]${camOf(x)},format=yuv420p,setsar=1[p${k}]`).join(';') + `;${prepared.map((_, k) => `[p${k}]`).join('')}concat=n=${prepared.length}:v=1:a=0`;
    const subText = cutWords.length ? stripWords(shot.text, cutWords) : shot.text;
    if (p.subtitles && subText.trim()) {
      fs.writeFileSync(path.join(work, `sub_${n}.srt`), srtFor(subText, D), 'utf8');
      const style = `FontName=Arial,FontSize=${p.format === 'vertical' ? 13 : 20},Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=${p.format === 'vertical' ? 60 : 28}`;
      vf += `,subtitles=sub_${n}.srt:force_style='${style}'`;
    }
    vf += `[v];[${prepared.length}:a]apad,aformat=sample_rates=48000:channel_layouts=stereo[aud]`;
    const imgIn = prepared.flatMap((x) => ['-loop', '1', '-framerate', String(FPS), '-t', Dk.toFixed(3), '-i', x.canvas]);
    const seg = path.join(work, `seg_${n}.mp4`);
    const args = (venc: string[]) => [...imgIn, ...audioIn, '-filter_complex', vf, '-map', '[v]', '-map', '[aud]', ...venc, '-r', String(FPS), '-c:a', 'aac', '-b:a', '160k', '-t', D.toFixed(3), seg];
    try {
      await runFfmpeg(args(enc), { cwd: work, signal });
    } catch (err) {
      if (!nvenc || signal?.aborted) throw err;
      await runFfmpeg(args(x264), { cwd: work, signal });
    }
    try {
      fs.copyFileSync(seg, cachedSeg);
      fs.writeFileSync(`${cachedSeg}.json`, JSON.stringify({ D, wordCuts }));
    } catch {
      /* cache é só otimização */
    }
    tick(i, false);
    return { seg, D, wordCuts, cached: false, sp };
  };

  // várias partes ao mesmo tempo; o resultado volta na ordem da linha do tempo
  const results = await mapPool(p.shots, conc, renderShot);
  const segs: string[] = [];
  const segments: { id: string; start: number; dur: number; cuts?: [number, number][]; speed?: number }[] = [];
  let total = 0, reused = 0, rendered = 0;
  for (const [i, r] of results.entries()) {
    if (!r) continue;
    const shot = p.shots[i];
    segs.push(r.seg);
    segments.push({ id: shot.id, start: total, dur: r.D, ...(shot.audioCuts?.length ? { cuts: shot.audioCuts } : {}), ...(Math.abs(r.sp - 1) > 0.01 ? { speed: r.sp } : {}) });
    total += r.D;
    wordCuts += r.wordCuts;
    if (r.cached) reused++;
    else rendered++;
  }

  // Final suave (só no vídeo principal, só no fim): silêncio com a última imagem e fade (padrão 3 s), para não terminar seco.
  const endSil = Math.min(30, Math.max(0, p.endSilence ?? 3));
  if ((!opts.extra || opts.extra.tail) && segs.length && endSil > 0) {
    try {
      const last = segs[segs.length - 1];
      const png = path.join(work, 'tail.png');
      const tail = path.join(work, 'tail.mp4');
      await runFfmpeg(['-y', '-sseof', '-0.2', '-i', last, '-frames:v', '1', png], { signal });
      const targs = (venc: string[]) => ['-y', '-loop', '1', '-framerate', String(FPS), '-t', endSil.toFixed(2), '-i', png, '-f', 'lavfi', '-t', endSil.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo', '-vf', `scale=${W}:${H},format=yuv420p,setsar=1,fade=t=out:st=${Math.max(0, endSil - 1).toFixed(2)}:d=${Math.min(1, endSil).toFixed(2)}`, ...venc, '-r', String(FPS), '-c:a', 'aac', '-b:a', '160k', '-t', endSil.toFixed(2), tail];
      try {
        await runFfmpeg(targs(enc), { cwd: work, signal });
      } catch (err) {
        if (!nvenc || signal?.aborted) throw err;
        await runFfmpeg(targs(x264), { cwd: work, signal });
      }
      segs.push(tail);
    } catch (err) {
      if (signal?.aborted) throw err;
      ctx.log(`Final suave não gerado (${String((err as Error).message).split('\n').pop()?.slice(0, 120)}); vídeo termina como antes`);
    }
  }

  // 4) Junta sem recodificar
  const outDir = path.join(projectDir(p.id), opts.extra?.outDir ?? 'videos'); // o vídeo fica junto do projeto, na pasta do app
  fs.mkdirSync(outDir, { recursive: true });
  const name = opts.extra ? `${opts.extra.name}.mp4` : `${p.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 60) || 'manga'}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`;
  fs.writeFileSync(path.join(work, 'list.txt'), segs.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`).join('\n'), 'utf8');
  const out = path.join(outDir, name);
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', out], { cwd: work, signal });
  const dur = (await audioDuration(out)) || total;
  if (opts.extra) {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    return out;
  }
  updateProject(projectId, (cur) => {
    cur.lastRender = { file: out, at: new Date().toISOString(), duration: dur, segments, sig: renderSig(p) };
    // as imagens trocadas já estão no vídeo: tira a marca das partes que entraram neste render
    const done = new Set(p.shots.map((s) => s.id));
    for (const s of cur.shots) if (s.newImage && done.has(s.id)) delete s.newImage;
  });
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  void pruneAfterRender(segCache, outDir, out, results.flatMap((r) => (r ? [path.basename(r.seg)] : [])), ctx.log);
  ctx.log(`${rendered} parte(s) renderizada(s), ${reused} reaproveitada(s) do cache`);
  return `Vídeo pronto: ${dur.toFixed(1)} s (${rendered} parte(s) refeita(s), ${reused} do cache) → ${out}${wordCuts ? ` · ${wordCuts} palavra(s) cortada(s) (${cutWords.join(', ')})` : ''}`;
}
