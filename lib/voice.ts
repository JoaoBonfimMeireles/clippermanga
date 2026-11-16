// Narração com voz (TTS). Três motores, escolhidos por voz no catálogo de lib/voices.ts:
//  - edge:   Microsoft Edge neural (edge-tts no .venv do monorepo). Grátis, sem limite, sem tokens.
//  - gemini: Gemini TTS (GEMINI_API_KEY). Mais expressiva; usa a cota grátis do Gemini.
//  - omni:   /v1/audio/speech do OmniRoute (qualquer provedor de fala conectado lá; hoje: Google Tradutor).
// Contrato: grava um WAV 48 kHz em `out` e devolve a duração (s).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getEnvValue, resolvePythonBinary, runProcess } from '@clipper/shared/server';
import { runFfmpeg } from '@clipper/video-processing';
import { audioDuration } from './media';
import { omniBaseUrl } from './omniroute';
import { DEFAULT_VOICE, VOICE_CHAIN, VOICES, type Voice } from './voices';
import { recordVoiceUse } from './voice-usage';

export const VOICE_IS_STUB = false;

/** ~150 palavras por minuto de narração. */
export const estimateSpeechSeconds = (text: string) => Math.max(1, (text.split(/\s+/).filter(Boolean).length / 150) * 60);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('cancelado'))), { once: true });
  });

async function edge(v: Voice, text: string, mp3: string, signal?: AbortSignal) {
  const txt = `${mp3}.txt`;
  fs.writeFileSync(txt, text, 'utf8');
  try {
    for (let attempt = 1; ; attempt++) {
      const res = await runProcess(resolvePythonBinary(), ['-m', 'edge_tts', '--voice', v.model, `--rate=${v.rate ?? '+0%'}`, `--pitch=${v.pitch ?? '+0Hz'}`, '-f', txt, '--write-media', mp3], { signal, timeoutMs: 180_000 });
      if (res.code === 0 && fs.existsSync(mp3)) return;
      if (attempt >= 3) throw new Error(`edge-tts falhou: ${res.stderrTail.slice(-300)}`);
      await sleep(2000 * attempt);
    }
  } finally {
    fs.rmSync(txt, { force: true });
  }
}

async function gemini(v: Voice, text: string, pcm: string, signal?: AbortSignal) {
  const key = getEnvValue('GEMINI_API_KEY');
  if (!key) throw new Error('Voz do Gemini precisa da GEMINI_API_KEY (Configurações do app de cortes)');
  const model = geminiModel();
  if (!model) throw new GeminiQuotaError('Cota do Gemini TTS esgotada');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${v.style}:\n${text}` }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: v.model } } } },
      }),
      signal,
    });
    if (res.ok) {
      const data = (await res.json()) as { candidates?: { finishReason?: string; content?: { parts?: { inlineData?: { data: string } }[] } }[]; promptFeedback?: { blockReason?: string } };
      const b64 = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
      if (b64) {
        fs.writeFileSync(pcm, Buffer.from(b64, 'base64'));
        return;
      }
      // o modelo (preview) às vezes responde 200 sem áudio (devolve texto ou corta): tenta de novo algumas vezes
      const why = data.candidates?.[0]?.finishReason ?? data.promptFeedback?.blockReason ?? 'sem motivo';
      if (attempt < 3) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new Error(`Gemini TTS não devolveu áudio (${why})`);
    }
    const body = await res.text();
    if (res.status === 429) {
      // cota do DIA acabou: esperar não adianta. Marca e falha na hora (as próximas falas também, sem esperar).
      if (/PerDay/i.test(body)) {
        exhaustedUntil.set(model, Date.now() + 6 * 3600_000);
        // cada modelo de voz tem a sua cota diária: passa para o próximo com a mesma voz
        if (geminiModel()) return gemini(v, text, pcm, signal);
        throw new GeminiQuotaError('Cota diária grátis do Gemini TTS acabou (volta amanhã)');
      }
      // limite por minuto: espera e tenta de novo
      if (attempt < 4) {
        await sleep(Math.min(60_000, retryDelayMs(body) ?? 15_000 * attempt), signal);
        continue;
      }
      // continua sem cota depois de várias esperas: trata como esgotada por um tempo
      exhaustedUntil.set(model, Date.now() + 30 * 60_000);
      if (geminiModel()) return gemini(v, text, pcm, signal);
      throw new GeminiQuotaError('Gemini TTS sem cota agora (limite atingido)');
    }
    if (res.status >= 500 && attempt < 4) {
      await sleep(5000 * attempt, signal);
      continue;
    }
    throw new Error(`Gemini TTS: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

/** Cota do Gemini TTS esgotada (do dia ou por ora): quem chama troca de voz em vez de esperar. */
export class GeminiQuotaError extends Error {}
/**
 * Modelos de voz do Gemini, em ordem. Na conta grátis cada um tem a SUA cota (~10 pedidos/dia, 3/min); com a
 * narração em blocos de ~5 min (lib/voice-blocks.ts) isso dá ~50 min de áudio por modelo, ~100 min por dia.
 * Mesmas vozes (Charon, Puck...) nos dois. GEMINI_TTS_MODEL troca o primeiro.
 */
const GEMINI_TTS_MODELS = () => [...new Set([getEnvValue('GEMINI_TTS_MODEL') || 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'])];
const exhaustedUntil = new Map<string, number>();
const geminiModel = () => GEMINI_TTS_MODELS().find((m) => !(Date.now() < (exhaustedUntil.get(m) ?? 0)));
export const geminiExhausted = () => !geminiModel();

/** "retryDelay": "17s" que o Google manda no 429 por minuto. */
function retryDelayMs(body: string): number | null {
  const s = Number(/"retryDelay"\s*:\s*"(\d+)/.exec(body)?.[1]);
  return Number.isFinite(s) && s > 0 ? (s + 1) * 1000 : null;
}

async function omni(v: Voice, text: string, file: string, signal?: AbortSignal) {
  const key = process.env.OMNIROUTE_API_KEY?.trim();
  if (!key) throw new Error('OMNIROUTE_API_KEY não definida');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${omniBaseUrl()}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: v.model, input: text, voice: v.voiceName ?? 'pt', response_format: 'mp3' }),
      signal,
    });
    if (res.ok) {
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return;
    }
    const body = (await res.text()).slice(0, 300);
    // sem crédito/cota no provedor: não adianta insistir, passa para a próxima voz da fila
    if (res.status === 402 || /quota|credit|insufficient|exceeded|limit reached|payment/i.test(body)) {
      markExhausted(v.provider, 6 * 3600_000);
      throw new GeminiQuotaError(`${v.provider}: sem cota/crédito (${res.status})`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(3000 * attempt, signal);
      continue;
    }
    if (res.status === 429) {
      markExhausted(v.provider, 30 * 60_000);
      throw new GeminiQuotaError(`${v.provider}: limite de uso atingido`);
    }
    throw new Error(`OmniRoute ${v.model}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

/** Provedor sem cota agora (fica fora da fila até o horário marcado). */
const providerOut = new Map<string, number>();
const markExhausted = (provider: string, ms: number) => providerOut.set(provider, Date.now() + ms);
const available = (v: Voice) => (v.engine === 'gemini' ? !geminiExhausted() : !(Date.now() < (providerOut.get(v.provider) ?? 0)));

/**
 * Fala de um texto. Com `cacheDir`, guarda o WAV por texto+voz e reaproveita (rodar o render de novo não refaz
 * nem gasta cota). Se a voz escolhida falhar ou a cota acabar, continua com a próxima voz da fila (VOICE_CHAIN,
 * uma por provedor) a partir deste trecho, e avisa por `onNotice`, em vez de derrubar o render.
 */
const noticed = new Set<string>();

/** A fala já está no cache (com a voz escolhida ou alguma da fila)? Usado para renderizar sem gastar voz. */
export function cachedSpeechFile(text: string, voice: string | undefined, cacheDir: string): string | null {
  const chosen = VOICES.find((x) => x.id === voice) ?? VOICES.find((x) => x.id === DEFAULT_VOICE)!;
  const ids = [chosen.id, ...VOICE_CHAIN.filter((id) => id !== chosen.id)];
  for (const id of ids) {
    const f = path.join(cacheDir, `${createHash('sha1').update(`${id}\n${text}`).digest('hex').slice(0, 20)}.wav`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
export const isSpeechCached = (text: string, voice: string | undefined, cacheDir: string) => !!cachedSpeechFile(text, voice, cacheDir);

export async function synthesizeSpeech(text: string, out: string, opts: { signal?: AbortSignal; voice?: string; cacheDir?: string; onNotice?: (m: string) => void } = {}): Promise<number> {
  const chosen = VOICES.find((x) => x.id === opts.voice) ?? VOICES.find((x) => x.id === DEFAULT_VOICE)!;
  const chain = [chosen, ...VOICE_CHAIN.map((id) => VOICES.find((x) => x.id === id)!).filter((x) => x && x !== chosen)];
  let lastErr: unknown;
  // voz da Fish escolhida: sem crédito/limite, PAUSA e testa de novo a cada 5 min (o usuário compra créditos),
  // em vez de trocar para outra voz no meio do vídeo
  if (chosen.provider === 'fishaudio') {
    const cached = opts.cacheDir && path.join(opts.cacheDir, `${createHash('sha1').update(`${chosen.id}\n${text}`).digest('hex').slice(0, 20)}.wav`);
    if (cached && fs.existsSync(cached)) {
      fs.copyFileSync(cached, out);
      return (await audioDuration(out)) || estimateSpeechSeconds(text);
    }
    for (let paused = false; ; ) {
      try {
        await synthesizeWith(chosen, text, out, opts.signal);
        if (paused) opts.onNotice?.('Fish Audio voltou; continuando a narração');
        if (cached) {
          fs.mkdirSync(opts.cacheDir!, { recursive: true });
          fs.copyFileSync(out, cached);
        }
        return (await audioDuration(out)) || estimateSpeechSeconds(text);
      } catch (e) {
        if (opts.signal?.aborted || !(e instanceof GeminiQuotaError)) throw e;
        paused = true;
        opts.onNotice?.(`Fish Audio sem crédito/limite (${(e as Error).message.slice(0, 120)}). Pausado: compre créditos na Fish; testo de novo às ${new Date(Date.now() + 5 * 60_000).toLocaleTimeString('pt-BR')}. Nada muda de voz.`);
        await sleep(5 * 60_000, opts.signal);
      }
    }
  }
  for (const v of chain) {
    const cached = opts.cacheDir && path.join(opts.cacheDir, `${createHash('sha1').update(`${v.id}
${text}`).digest('hex').slice(0, 20)}.wav`);
    if (cached && fs.existsSync(cached)) {
      fs.copyFileSync(cached, out);
      return (await audioDuration(out)) || estimateSpeechSeconds(text);
    }
    if (!available(v) && v.provider !== 'edge') continue;
    try {
      await synthesizeWith(v, text, out, opts.signal);
      if (cached) {
        fs.mkdirSync(opts.cacheDir!, { recursive: true });
        fs.copyFileSync(out, cached);
      }
      if (v !== chosen && !noticed.has(v.id)) {
        noticed.add(v.id);
        opts.onNotice?.(`${chosen.name} indisponível (${String((lastErr as Error)?.message ?? 'sem cota').slice(0, 140)}); continuando com ${v.name}`);
      }
      return (await audioDuration(out)) || estimateSpeechSeconds(text);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('nenhuma voz disponível');
}

/** Gera a fala com uma voz específica (sem cache nem reserva). Usado também pelos blocos de lib/voice-blocks.ts. */
export async function synthesizeWith(v: Voice, text: string, out: string, signal?: AbortSignal): Promise<void> {
  const t0 = Date.now();
  try {
    await synthesizeRaw(v, text, out, signal);
    recordVoiceUse(v, { ok: true, chars: text.length, ms: Date.now() - t0, audioSec: (await audioDuration(out)) || 0 });
  } catch (e) {
    if (!signal?.aborted) recordVoiceUse(v, { ok: false, chars: text.length, ms: Date.now() - t0, error: (e as Error).message, quota: e instanceof GeminiQuotaError });
    throw e;
  }
}

async function synthesizeRaw(v: Voice, text: string, out: string, signal?: AbortSignal): Promise<void> {
  const opts = { signal };
  const raw = path.join(path.dirname(out), `tts_${randomUUID().slice(0, 8)}`);
  try {
    if (v.engine === 'edge') {
      await edge(v, text, `${raw}.mp3`, opts.signal);
      await runFfmpeg(['-i', `${raw}.mp3`, '-ar', '48000', '-ac', '2', out], { signal: opts.signal });
    } else if (v.engine === 'gemini') {
      await gemini(v, text, `${raw}.pcm`, opts.signal);
      await runFfmpeg(['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', `${raw}.pcm`, '-ar', '48000', '-ac', '2', out], { signal: opts.signal });
    } else {
      await omni(v, text, `${raw}.mp3`, opts.signal);
      // Google Tradutor fala devagar: acelera um pouco
      await runFfmpeg(['-i', `${raw}.mp3`, ...(v.tempo ? ['-af', `atempo=${v.tempo}`] : []), '-ar', '48000', '-ac', '2', out], { signal: opts.signal });
    }
  } finally {
    for (const ext of ['.mp3', '.pcm']) fs.rmSync(raw + ext, { force: true });
  }
}
