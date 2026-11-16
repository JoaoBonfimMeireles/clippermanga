// Acabamento das falas narradas (qualquer voz, qualquer obra): volume parelho e bordas sem estalo.
// A IA de voz entrega cada chamada/bloco com um ganho diferente (já medimos falas ~10 dB mais altas que as vizinhas).
// Cada fala é medida (EBU R128) e levada ao MESMO volume (TARGET_LUFS) com ganho fixo, limitador de pico e fade curto:
// a troca de uma fala (ou de um bloco de voz) para a seguinte nunca muda o volume. Quem já está dentro da tolerância
// fica intacto.
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from '@clipper/video-processing';
import { audioDuration } from './media';
import { mapPool, PROBE_CONCURRENCY } from './pool';

/** Volume único da narração (LUFS integrado) e quanto a fala pode fugir dele (LU) antes de ser corrigida. */
export const TARGET_LUFS = -16;
export const TOLERANCE_LU = 0.7;
const PEAK_LIMIT = 0.84; // ≈ -1,5 dBFS
const MAX_GAIN_DB = 18;
const FADE_S = 0.008;

/** Loudness integrado da fala (LUFS) ou null quando curta/silenciosa demais para medir. */
export async function measureLufs(file: string, work: string, tag: string, signal?: AbortSignal): Promise<number | null> {
  const name = `lufs_${tag}.txt`;
  try {
    await runFfmpeg(['-i', file, '-af', `ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.I:file=${name}`, '-f', 'null', '-'], { cwd: work, signal });
    const txt = fs.readFileSync(path.join(work, name), 'utf8');
    const all = [...txt.matchAll(/lavfi\.r128\.I=(-?[\d.]+|-?inf)/g)].map((m) => Number(m[1]));
    const last = all[all.length - 1];
    return Number.isFinite(last) && last > -70 ? last : null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  } finally {
    fs.rmSync(path.join(work, name), { force: true });
  }
}

/**
 * Ganho (dB) a aplicar em cada fala para chegar ao volume único; só entra quem foge por mais que a tolerância.
 * `items`: id → arquivo da fala.
 */
export async function planSpeechGains(items: Map<string, string>, work: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const entries = [...items.entries()];
  const lufs = await mapPool(entries, PROBE_CONCURRENCY, async ([id, file], k) => [id, await measureLufs(file, work, `m${k}`, signal)] as const);
  const valid = lufs.filter((x): x is readonly [string, number] => x[1] !== null);
  const gains = new Map<string, number>();
  const ref = TARGET_LUFS;
  for (const [id, l] of valid) {
    if (Math.abs(l - ref) > TOLERANCE_LU) gains.set(id, Math.round(Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, ref - l)) * 10) / 10);
  }
  return gains;
}

/**
 * Corrige a fala no próprio arquivo (WAV 48 kHz estéreo): ganho fixo, limitador de pico e fade de 8 ms nas pontas.
 * Falha nunca derruba o render: a fala segue como estava.
 */
export async function polishSpeech(wav: string, work: string, tag: string, gainDb: number, signal?: AbortSignal): Promise<void> {
  const out = path.join(work, `audio_${tag}_polish.wav`);
  try {
    const dur = await audioDuration(wav);
    if (!dur || dur < 0.3) return;
    const fade = Math.min(FADE_S, dur / 4);
    const af = [
      `volume=${gainDb.toFixed(2)}dB`,
      `alimiter=limit=${PEAK_LIMIT}:attack=2:release=40:level=disabled`,
      `afade=t=in:st=0:d=${fade}`,
      `afade=t=out:st=${(dur - fade).toFixed(4)}:d=${fade}`,
    ].join(',');
    await runFfmpeg(['-y', '-i', wav, '-af', af, '-ar', '48000', '-ac', '2', out], { signal });
    if ((await audioDuration(out)) > dur - 0.05) fs.copyFileSync(out, wav);
  } catch (err) {
    if (signal?.aborted) throw err;
  } finally {
    fs.rmSync(out, { force: true });
  }
}
