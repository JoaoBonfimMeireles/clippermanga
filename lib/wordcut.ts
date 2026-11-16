// Corta palavras proibidas (ex.: "cara") direto do áudio já narrado, sem gerar a voz de novo:
// o Whisper (local) acha o tempo exato de cada palavra e o FFmpeg remove só esses trechos.
// Resultado guardado em cache (mesmo áudio + mesmas palavras = não transcreve de novo).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { transcribe } from '@clipper/ai-providers';
import { getAppSettings } from '@clipper/shared/server';
import { runFfmpeg } from '@clipper/video-processing';
import { audioDuration } from './media';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/**
 * "cara" como rosto/pessoa ("na cara dele", "o cara", "cara de medo", "minha cara") fica; só sai o "cara" de
 * bordão/vocativo ("Cara, olha isso", "e aí, cara,"). Decide pelas palavras vizinhas.
 */
const BEFORE_FACE = new Set(['a', 'o', 'na', 'no', 'da', 'do', 'pela', 'pelo', 'sua', 'seu', 'minha', 'meu', 'tua', 'teu', 'nossa', 'essa', 'esse', 'aquela', 'aquele', 'uma', 'um', 'cuja', 'mesma', 'mesmo', 'outra', 'outro', 'ela', 'em', 'de', 'com', 'que', 'ta', 'fechou', 'fechar', 'quebrar', 'quebrou']);
const punct = (w?: string) => !!w && /[,.!?…:;]$/.test(w.trim());
export function isFaceCara(prev: string | undefined, cur: string, next?: string): boolean {
  if (prev && !punct(prev) && BEFORE_FACE.has(norm(prev))) return true; // "na cara", "o cara", "minha cara"
  if (!punct(cur) && next && (norm(next) === 'de' || norm(next).startsWith('del'))) return true; // "cara de medo", "cara dele"
  return false;
}

/** O texto tem alguma das palavras (palavra inteira, sem diferenciar maiúsculas/acentos)? */
export function hasCutWord(text: string, words: string[]): boolean {
  const set = new Set(words.map(norm).filter(Boolean));
  return text.split(/\s+/).some((w) => set.has(norm(w)));
}

/** Tira as palavras do texto (para a legenda). */
export function stripWords(text: string, words: string[]): string {
  const set = new Set(words.map(norm).filter(Boolean));
  const toks = text.split(/\s+/).filter(Boolean);
  return toks
    .filter((w, i) => !(set.has(norm(w)) && !(norm(w) === 'cara' && isFaceCara(toks[i - 1], w, toks[i + 1]))))
    .join(' ')
    .replace(/\s+([,.!?…])/g, '$1')
    .replace(/^[\s,]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Remove as palavras do áudio `wav`, gravando em `out`. Devolve a nova duração, ou null se nada foi cortado.
 */
export async function cutWordsFromAudio(wav: string, words: string[], cacheDir: string, out: string, signal?: AbortSignal): Promise<{ dur: number; cuts: number } | null> {
  const set = new Set(words.map(norm).filter(Boolean));
  if (!set.size) return null;
  const key = keyOf(wav, set);
  const dir = path.join(cacheDir, 'wordcut');
  const cached = path.join(dir, `${key}.wav`);
  const none = path.join(dir, `${key}.none`);
  if (fs.existsSync(none)) return null;
  if (fs.existsSync(cached)) {
    fs.copyFileSync(cached, out);
    return { dur: (await audioDuration(out)), cuts: Number(fs.readFileSync(`${cached}.n`, 'utf8')) || 1 };
  }
  fs.mkdirSync(dir, { recursive: true });
  const s = getAppSettings();
  const json = path.join(dir, `${key}.json`);
  // o Whisper do app espera WAV PCM 16-bit, 16 kHz, mono
  const w16 = path.join(dir, `${key}.16k.wav`);
  await runFfmpeg(['-y', '-i', wav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', w16], { signal });
  const tr = await transcribe({ audioPath: w16, outputJson: json, model: s.whisperModel || 'small', device: s.whisperDevice || 'auto', language: 'pt', signal });
  fs.rmSync(json, { force: true });
  fs.rmSync(w16, { force: true });
  return applyCuts(wav, tr.segments.flatMap((sg) => sg.words ?? []), set, cached, none, out, signal);
}

const keyOf = (wav: string, set: Set<string>) =>
  createHash('sha1').update(`v2|${[...set].sort().join(',')}|${fs.statSync(wav).size}|${fs.readFileSync(wav).subarray(0, 65536).toString('base64')}`).digest('hex').slice(0, 20);

async function applyCuts(wav: string, all: { word: string; start: number; end: number }[], set: Set<string>, cached: string, none: string, out: string | null, signal?: AbortSignal) {
  const hits = all.filter((w, i) => set.has(norm(w.word)) && !(norm(w.word) === 'cara' && isFaceCara(all[i - 1]?.word, w.word, all[i + 1]?.word)));
  if (!hits.length) {
    fs.writeFileSync(none, '');
    return null;
  }
  const expr = hits.map((w) => `between(t,${Math.max(0, w.start - 0.03).toFixed(3)},${(w.end + 0.06).toFixed(3)})`).join('+');
  await runFfmpeg(['-y', '-i', wav, '-af', `aselect='not(${expr})',asetpts=N/SR/TB`, '-ar', '48000', '-ac', '2', cached], { signal });
  fs.writeFileSync(`${cached}.n`, String(hits.length));
  if (!out) return { dur: 0, cuts: hits.length };
  fs.copyFileSync(cached, out);
  return { dur: (await audioDuration(out)), cuts: hits.length };
}

/**
 * Prepara os cortes de muitas falas com UMA transcrição só (o Whisper carrega uma vez): junta os áudios em
 * sequência, transcreve e reparte as palavras de volta. Depois, cutWordsFromAudio acha tudo pronto no cache.
 */
export async function prepareWordCuts(wavs: string[], words: string[], cacheDir: string, log: (m: string) => void, signal?: AbortSignal): Promise<void> {
  const set = new Set(words.map(norm).filter(Boolean));
  const dir = path.join(cacheDir, 'wordcut');
  fs.mkdirSync(dir, { recursive: true });
  const todo = [...new Set(wavs)]
    .filter((w) => fs.existsSync(w))
    .map((wav) => ({ wav, key: keyOf(wav, set) }))
    .filter(({ key }) => !fs.existsSync(path.join(dir, `${key}.wav`)) && !fs.existsSync(path.join(dir, `${key}.none`)));
  if (!todo.length) return;
  const tmp = fs.mkdtempSync(path.join(dir, 'batch-'));
  try {
    const GAP = 1.0; // silêncio entre as falas, para o Whisper não grudar palavras de falas vizinhas
    const gap = path.join(tmp, 'gap.wav');
    await runFfmpeg(['-y', '-f', 'lavfi', '-t', String(GAP), '-i', 'anullsrc=r=16000:cl=mono', '-c:a', 'pcm_s16le', gap], { signal });
    const spans: { start: number; end: number }[] = [];
    const list: string[] = [];
    let t = 0;
    for (const [k, it] of todo.entries()) {
      const f = path.join(tmp, `${k}.wav`);
      await runFfmpeg(['-y', '-i', it.wav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', f], { signal });
      const d = (await audioDuration(f));
      spans.push({ start: t, end: t + d });
      list.push(`file '${k}.wav'`, `file 'gap.wav'`);
      t += d + GAP;
    }
    fs.writeFileSync(path.join(tmp, 'list.txt'), list.join('\n'));
    const all = path.join(tmp, 'all.wav');
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', all], { cwd: tmp, signal });
    log(`Procurando as palavras (${words.join(', ')}) em ${todo.length} fala(s), ${(t / 60).toFixed(1)} min de áudio, numa transcrição só`);
    const s = getAppSettings();
    const tr = await transcribe({ audioPath: all, outputJson: path.join(tmp, 'tr.json'), model: s.whisperModel || 'small', device: s.whisperDevice || 'auto', language: 'pt', signal });
    const ws = tr.segments.flatMap((sg) => sg.words ?? []);
    let cuts = 0;
    for (const [k, it] of todo.entries()) {
      const sp = spans[k];
      const mine = ws.filter((w) => w.start >= sp.start - 0.2 && w.start < sp.end + 0.2).map((w) => ({ word: w.word, start: Math.max(0, w.start - sp.start), end: Math.min(sp.end - sp.start, w.end - sp.start) }));
      const r = await applyCuts(it.wav, mine, set, path.join(dir, `${it.key}.wav`), path.join(dir, `${it.key}.none`), null, signal);
      if (r) cuts += r.cuts;
    }
    log(`${cuts} ocorrência(s) para cortar encontradas`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
