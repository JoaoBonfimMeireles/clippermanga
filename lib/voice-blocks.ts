// Narração em blocos (todas as vozes): em vez de uma chamada por parte, junta as falas em blocos de ~5 min,
// gera um áudio só por bloco (menos chamadas = cabe na cota grátis, e a entonação fica contínua) e corta
// de volta uma fala por parte, nas pausas entre parágrafos (detecção de silêncio do FFmpeg).
// Se uma pausa não aparece, aquele corte é estimado pelo tamanho do texto. Se o bloco falha ou volta
// incompleto, ele é dividido ao meio e tentado de novo; no fim, cai para uma chamada por parte
// (synthesizeSpeech, que ainda tem a voz reserva da Microsoft).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runFfmpeg } from '@clipper/video-processing';
import { audioDuration } from './media';
import { cachedSpeechFile, GeminiQuotaError, synthesizeSpeech, synthesizeWith } from './voice';
import { DEFAULT_VOICE, VOICES } from './voices';
import { OFF_VOICE, referenceProfile, voiceDistance, voiceProfile, type VoiceProfile } from './voice-check';
import { mapPool, PROBE_CONCURRENCY } from './pool';

export interface NarrationItem {
  id: string;
  text: string;
  /** Capítulo: o bloco prefere fechar na troca de capítulo. */
  group: string;
}

/** Tamanho alvo do bloco e a folga para fechar num ponto natural. */
// blocos de ~3 min: ainda dão entonação contínua, mas o erro de alinhamento de um corte não se espalha por 5 min
const TARGET_S = 180;
const MIN_S = 120; // na troca de capítulo, já pode fechar a partir daqui
const MAX_S = 240; // nunca passa disso (a resposta do TTS tem limite de tamanho)
/** Ritmo médio de fala do Gemini em português (palavras por segundo), só para planejar os blocos. */
const WPS = 2.5;

/** Mesmo nome de arquivo do cache por texto de synthesizeSpeech (lib/voice.ts). */
const speechKey = (voiceId: string, text: string) => `${createHash('sha1').update(`${voiceId}
${text}`).digest('hex').slice(0, 20)}.wav`;

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const estSeconds = (t: string) => Math.max(0.8, words(t) / WPS);

/** Agrupa as falas em blocos de ~5 min, fechando sempre no fim de uma fala (de preferência na troca de capítulo). */
export function planBlocks(items: NarrationItem[]): NarrationItem[][] {
  const blocks: NarrationItem[][] = [];
  let cur: NarrationItem[] = [];
  let acc = 0;
  for (const [k, it] of items.entries()) {
    cur.push(it);
    acc += estSeconds(it.text);
    const next = items[k + 1];
    const chapterEnds = !next || next.group !== it.group;
    const nextWouldOverflow = next && acc + estSeconds(next.text) > MAX_S;
    if (!next || acc >= TARGET_S || (chapterEnds && acc >= MIN_S) || nextWouldOverflow) {
      blocks.push(cur);
      cur = [];
      acc = 0;
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

interface Silence {
  start: number;
  end: number;
}

export async function detectSilences(file: string, workDir: string, signal?: AbortSignal): Promise<Silence[]> {
  const name = `sil_${path.basename(file, '.wav')}.txt`;
  // limiar folgado (pausas curtas entre falas contam): quem escolhe as pausas certas é o alinhamento em cutPoints
  await runFfmpeg(['-i', file, '-af', `silencedetect=noise=-33dB:d=0.12,ametadata=mode=print:file=${name}`, '-f', 'null', '-'], { cwd: workDir, signal });
  const txt = fs.readFileSync(path.join(workDir, name), 'utf8');
  fs.rmSync(path.join(workDir, name), { force: true });
  const out: Silence[] = [];
  let start: number | null = null;
  for (const m of txt.matchAll(/lavfi\.silence_(start|end)=([\d.]+)/g)) {
    const v = Number(m[2]);
    if (m[1] === 'start') start = v;
    else if (start !== null) {
      out.push({ start, end: v });
      start = null;
    }
  }
  return out;
}

/**
 * Pontos de corte entre as falas: para cada fronteira, a pausa mais longa perto de onde ela deveria cair
 * (proporcional ao tamanho do texto). Sem pausa por perto, usa a posição estimada.
 */
export function cutPoints(texts: string[], total: number, silences: Silence[]): { cuts: number[]; estimated: number; real: boolean[] } {
  const weights = texts.map((t) => Math.max(1, t.length));
  const sum = weights.reduce((a, b) => a + b, 0);
  const K = texts.length - 1; // fronteiras entre falas
  const expected: number[] = [];
  let acc = 0;
  for (let k = 0; k < K; k++) expected.push(((acc += weights[k]) / sum) * total);
  // candidatos em ordem de tempo: as pausas detectadas + uma posição "virtual" estimada pelo texto para cada fronteira (com multa)
  type Cand = { t: number; dur: number; virtual: boolean };
  const cands: Cand[] = silences.map((s) => ({ t: (s.start + s.end) / 2, dur: s.end - s.start, virtual: false }));
  for (const e of expected) cands.push({ t: e, dur: 0, virtual: true });
  cands.sort((a, b) => a.t - b.t);
  const n = cands.length;
  // alinhamento global (programação dinâmica): escolhe K candidatos em ordem, minimizando o desvio da posição esperada de
  // cada fronteira; pausa longa é premiada, posição estimada é multada. Não deixa um erro puxar todos os cortes seguintes.
  const cost = (k: number, c: Cand) => Math.abs(c.t - expected[k]) - 4 * Math.min(c.dur, 0.8) + (c.virtual ? 2.5 : 0);
  const INF = 1e18;
  const dp: number[][] = Array.from({ length: K }, () => new Array(n).fill(INF));
  const from: number[][] = Array.from({ length: K }, () => new Array(n).fill(-1));
  for (let k = 0; k < K; k++) {
    if (k === 0) {
      for (let j = 0; j < n; j++) dp[0][j] = cost(0, cands[j]);
      continue;
    }
    // melhor anterior com ao menos 0,4 s de fala entre os cortes (candidatos já em ordem de tempo)
    let p = 0;
    let best = INF, bi = -1;
    for (let j = 0; j < n; j++) {
      while (p < j && cands[p].t <= cands[j].t - 0.4) {
        if (dp[k - 1][p] < best) (best = dp[k - 1][p]), (bi = p);
        p++;
      }
      if (bi >= 0) {
        dp[k][j] = best + cost(k, cands[j]);
        from[k][j] = bi;
      }
    }
  }
  let j = -1, bestEnd = INF;
  for (let x = 0; x < n; x++) if (K > 0 && dp[K - 1][x] < bestEnd) (bestEnd = dp[K - 1][x]), (j = x);
  const picked: Cand[] = [];
  for (let k = K - 1; k >= 0 && j >= 0; k--) {
    picked.unshift(cands[j]);
    j = from[k][j];
  }
  // sem solução (áudio muito curto/pausas coladas): tudo pelo texto
  const ok = picked.length === K;
  const pts = ok ? picked : expected.map((t) => ({ t, dur: 0, virtual: true }));
  const cuts = [0, ...pts.map((c) => Math.max(0.1, Math.min(total - 0.1, c.t))), total];
  return { cuts, estimated: pts.filter((c) => c.virtual).length, real: pts.map((c) => !c.virtual) };
}

export interface BlockOpts {
  voiceId?: string;
  cacheDir: string;
  workDir: string;
  signal?: AbortSignal;
  onNotice?: (m: string) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Uma fala pronta por parte: arquivo WAV (48 kHz) e duração. */
export type NarrationResult = Map<string, { file: string; dur: number }>;

/**
 * Narra tudo em blocos de ~5 min, com qualquer voz (Gemini, Fish, ElevenLabs, Edge...): poucas chamadas e
 * entonação contínua. O custo em caracteres é o mesmo; o que muda é a quantidade de chamadas e a fluidez.
 */
async function narrateRaw(items: NarrationItem[], opts: BlockOpts): Promise<NarrationResult> {
  const out: NarrationResult = new Map();
  const v = VOICES.find((x) => x.id === (opts.voiceId || DEFAULT_VOICE)); // sem voz escolhida no projeto: a padrão
  const todo = items.filter((x) => x.text.trim());
  if (!v || !todo.length) return out;
  // falas já narradas (cache por texto, de um bloco ou chamada anterior) não entram nos blocos:
  // mudar o texto de uma parte refaz só ela, não o bloco inteiro de ~5 min
  // (a duração de cada fala em cache vem do ffprobe: vários de uma vez, não um processo depois do outro)
  const fresh: NarrationItem[] = [];
  const hits = todo.map((it) => {
    const own = path.join(opts.cacheDir, speechKey(v.id, it.text.trim()));
    return fs.existsSync(own) ? own : cachedSpeechFile(it.text.trim(), v.id, opts.cacheDir);
  });
  const durs = await mapPool(hits, PROBE_CONCURRENCY, async (hit) => (hit ? (await audioDuration(hit)) : 0));
  for (const [k, it] of todo.entries()) {
    const hit = hits[k];
    if (hit) out.set(it.id, { file: hit, dur: durs[k] });
    else fresh.push(it);
  }
  if (!fresh.length) return out;
  // Fish/ElevenLabs/Edge: UMA chamada por fala. Em bloco longo a IA de voz "troca de voz" no meio (parece outro personagem) e os
  // cortes podem errar; fala a fala o timbre é o da voz escolhida e não há corte nenhum. (Gemini segue em blocos: cota por chamada.)
  if (v.engine !== 'gemini') {
    opts.onNotice?.(`Narração fala a fala com ${v.name}: ${fresh.length} falas novas${todo.length > fresh.length ? `, ${todo.length - fresh.length} do cache` : ''} (uma voz só em todo o vídeo)`);
    for (const [k, it] of fresh.entries()) {
      opts.onProgress?.(k, fresh.length);
      if (opts.signal?.aborted) throw new Error('cancelado');
      const f = path.join(opts.workDir, `one_${it.id}.wav`);
      const dur = await synthesizeSpeech(it.text.trim(), f, { signal: opts.signal, voice: v.id, cacheDir: opts.cacheDir, onNotice: opts.onNotice });
      out.set(it.id, { file: f, dur });
    }
    opts.onProgress?.(fresh.length, fresh.length);
    return out;
  }
  const blocks = planBlocks(fresh);
  opts.onNotice?.(`Narração em ${blocks.length} bloco(s) de ~5 min (${fresh.length} falas novas${todo.length > fresh.length ? `, ${todo.length - fresh.length} do cache` : ''}) em vez de ${fresh.length} chamadas`);
  for (const [b, block] of blocks.entries()) {
    opts.onProgress?.(b, blocks.length);
    await narrateBlock(block, v, opts, out, `${b + 1}`);
  }
  opts.onProgress?.(blocks.length, blocks.length);
  return out;
}

const MAX_FIX_TRIES = 3;

/** Perfil da fala, lembrado entre renders (a análise leva uns décimos de segundo por fala). */
function profileOf(file: string, cacheDir: string): VoiceProfile | null {
  try {
    const st = fs.statSync(file);
    const side = path.join(cacheDir, 'profiles', `${createHash('sha1').update(`${path.basename(file)}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 20)}.json`);
    if (fs.existsSync(side)) return JSON.parse(fs.readFileSync(side, 'utf8')) as VoiceProfile;
    const p = voiceProfile(file);
    if (p) {
      fs.mkdirSync(path.dirname(side), { recursive: true });
      fs.writeFileSync(side, JSON.stringify(p));
    }
    return p;
  } catch {
    return null;
  }
}

/**
 * A IA de voz às vezes "troca de voz" no meio de um bloco (timbre/tom de outro personagem). O vídeo tem UM narrador:
 * as falas que fogem do padrão do projeto são geradas de novo, uma a uma, até saírem com a voz do narrador.
 */
async function fixOffVoices(items: NarrationItem[], out: NarrationResult, opts: BlockOpts): Promise<void> {
  const v = VOICES.find((x) => x.id === (opts.voiceId || DEFAULT_VOICE));
  if (!v) return;
  const prof = new Map<string, VoiceProfile>();
  for (const it of items) {
    const r = out.get(it.id);
    const p = r && fs.existsSync(r.file) ? profileOf(r.file, opts.cacheDir) : null;
    if (p) prof.set(it.id, p);
  }
  const ref = referenceProfile([...prof.values()]);
  if (!ref) return;
  // ritmo: palavras por segundo muito fora do padrão do projeto (fala atropelada ou arrastada) também é "voz diferente"
  const wps = (it: NarrationItem) => it.text.trim().split(/\s+/).length / Math.max(0.3, out.get(it.id)?.dur ?? 1);
  const rates = items.filter((it) => out.has(it.id)).map(wps).sort((a, b) => a - b);
  const medRate = rates[rates.length >> 1] || 0;
  const badPace = (it: NarrationItem) => medRate > 0 && it.text.trim().split(/\s+/).length >= 6 && (wps(it) > medRate * 1.4 || wps(it) < medRate * 0.6);
  const off = items.filter((it) => prof.has(it.id) && (voiceDistance(prof.get(it.id)!, ref) > OFF_VOICE || badPace(it)));
  if (!off.length) return;
  opts.onNotice?.(`Voz: ${off.length} fala(s) saíram com voz diferente da do narrador; gerando de novo só essas`);
  let fixed = 0;
  for (const it of off) {
    if (opts.signal?.aborted) return;
    const text = it.text.trim();
    const paceOk = (dur: number) => !(medRate > 0 && (it.text.trim().split(/\s+/).length / Math.max(0.3, dur) > medRate * 1.4 || it.text.trim().split(/\s+/).length / Math.max(0.3, dur) < medRate * 0.6));
    let best = { d: voiceDistance(prof.get(it.id)!, ref) + (badPace(it) ? OFF_VOICE : 0), file: '' };
    for (let n = 0; n < MAX_FIX_TRIES && best.d > OFF_VOICE; n++) {
      const tmp = path.join(opts.workDir, `vfix_${it.id}_${n}.wav`);
      try {
        await synthesizeWith(v, text, tmp, opts.signal);
        const p = voiceProfile(tmp);
        const score = p ? voiceDistance(p, ref) + (paceOk(await audioDuration(tmp)) ? 0 : OFF_VOICE) : Infinity;
        if (p && score < best.d) {
          if (best.file) fs.rmSync(best.file, { force: true });
          best = { d: score, file: tmp };
        } else fs.rmSync(tmp, { force: true });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        if (e instanceof GeminiQuotaError) return; // sem cota: segue com o que já tem
        fs.rmSync(tmp, { force: true });
      }
    }
    if (best.file) {
      const dest = path.join(opts.cacheDir, speechKey(v.id, text));
      fs.copyFileSync(best.file, dest);
      fs.rmSync(best.file, { force: true });
      out.set(it.id, { file: dest, dur: await audioDuration(dest) });
      if (best.d <= OFF_VOICE) fixed++;
    }
  }
  opts.onNotice?.(`Voz: ${fixed} de ${off.length} fala(s) voltaram para a voz do narrador${fixed < off.length ? ` (${off.length - fixed} ainda diferentes depois de ${MAX_FIX_TRIES} tentativas; ficou a mais próxima)` : ''}`);
}

/** Narra tudo em blocos e confere que todas as falas saíram com a voz do narrador (refaz só as que trocaram de voz). */
export async function narrateInBlocks(items: NarrationItem[], opts: BlockOpts): Promise<NarrationResult> {
  const out = await narrateRaw(items, opts);
  await fixOffVoices(items.filter((x) => x.text.trim()), out, opts);
  return out;
}

async function narrateBlock(block: NarrationItem[], v: (typeof VOICES)[number], opts: BlockOpts, out: NarrationResult, label: string): Promise<void> {
  const texts = block.map((x) => x.text.trim());
  // "v2": cortes novos (alinhamento por programação dinâmica); blocos antigos tinham cortes estimados fora do lugar
  const key = createHash('sha1').update(`v2\n${v.id}\n${texts.join('\u0001')}`).digest('hex').slice(0, 20);
  const dir = path.join(opts.cacheDir, 'blocks', key);
  const parts = texts.map((_, k) => path.join(dir, `${k}.wav`));
  // bloco já narrado antes (render repetido ou retomado): reaproveita sem chamar a IA
  if (fs.existsSync(path.join(dir, 'ok'))) {
    const durs = await mapPool(parts, PROBE_CONCURRENCY, async (f) => (await audioDuration(f)));
    for (const [k, it] of block.entries()) out.set(it.id, { file: parts[k], dur: durs[k] });
    return;
  }
  if (block.length === 1) {
    // fala sozinha: caminho normal (com cache e voz reserva)
    const f = path.join(opts.workDir, `one_${block[0].id}.wav`);
    const dur = await synthesizeSpeech(texts[0], f, { signal: opts.signal, voice: v.id, cacheDir: opts.cacheDir, onNotice: opts.onNotice });
    out.set(block[0].id, { file: f, dur });
    return;
  }
  const full = path.join(opts.workDir, `block_${key}.wav`);
  try {
    // só o Gemini aceita instrução de estilo; nos outros, a quebra de parágrafo já vira pausa
    const style = v.engine === 'gemini' ? `${v.style}. Leia os parágrafos em sequência, como uma narração contínua, e faça uma pausa de um segundo entre um parágrafo e outro` : v.style;
    await synthesizeWith({ ...v, style }, texts.join('\n\n'), full, opts.signal);
    const total = (await audioDuration(full));
    const expected = texts.reduce((a, t) => a + estSeconds(t), 0);
    // o TTS corta respostas longas: áudio bem menor que o esperado = bloco incompleto
    if (!total || total < expected * 0.55) throw new Error(`áudio incompleto (${total.toFixed(0)} s de ~${expected.toFixed(0)} s)`);
    const { cuts, estimated, real } = cutPoints(texts, total, await detectSilences(full, opts.workDir, opts.signal));
    fs.mkdirSync(dir, { recursive: true });
    for (let k = 0; k < texts.length; k++) {
      await runFfmpeg(['-i', full, '-ss', cuts[k].toFixed(3), '-to', cuts[k + 1].toFixed(3), '-ar', '48000', '-ac', '2', parts[k]], { signal: opts.signal });
      out.set(block[k].id, { file: parts[k], dur: cuts[k + 1] - cuts[k] });
      // também no cache por texto (o mesmo de synthesizeSpeech): só quando os DOIS cortes caíram numa pausa de verdade;
      // corte estimado pelo texto pode ter pego um pedaço da fala vizinha e não pode contaminar o cache
      const sure = (k === 0 || real[k - 1]) && (k === texts.length - 1 || real[k]);
      if (sure) fs.copyFileSync(parts[k], path.join(opts.cacheDir, speechKey(v.id, texts[k])));
    }
    fs.writeFileSync(path.join(dir, 'ok'), new Date().toISOString());
    opts.onNotice?.(`Bloco ${label}: ${texts.length} falas, ${(total / 60).toFixed(1)} min${estimated ? ` (${estimated} corte(s) estimados pelo texto)` : ''}`);
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    // sem cota: dividir não adianta. Cada fala segue pelo caminho normal, que troca de voz na hora.
    if (e instanceof GeminiQuotaError) {
      for (const it of block) {
        const f = path.join(opts.workDir, `one_${it.id}.wav`);
        out.set(it.id, { file: f, dur: await synthesizeSpeech(it.text, f, { signal: opts.signal, voice: v.id, cacheDir: opts.cacheDir, onNotice: opts.onNotice }) });
      }
      return;
    }
    // falhou ou veio incompleto: divide ao meio e tenta de novo (até virar uma fala por chamada)
    const half = Math.ceil(block.length / 2);
    opts.onNotice?.(`Bloco ${label} falhou (${(e as Error).message.slice(0, 140)}); dividindo em 2`);
    await narrateBlock(block.slice(0, half), v, opts, out, `${label}a`);
    await narrateBlock(block.slice(half), v, opts, out, `${label}b`);
  } finally {
    fs.rmSync(full, { force: true });
  }
}
