// Confere se cada fala saiu com a MESMA voz do narrador. A IA de voz às vezes "troca de voz" no meio de um bloco
// (timbre/tom bem diferente, como se fosse outro personagem). Aqui cada fala ganha um perfil (espectro médio por faixa
// + tom da voz) e as que fogem do padrão do projeto são apontadas para serem geradas de novo.
import fs from 'node:fs';

export interface VoiceProfile {
  /** Espectro médio em 24 faixas (dB, sem a média). */
  bands: number[];
  /** Tom médio da voz em Hz (0 = não deu para medir). */
  f0: number;
}

const NB = 24;

function readWavMono(file: string): { x: Float32Array; sr: number } | null {
  const b = fs.readFileSync(file);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF') return null;
  let pos = 12, ch = 1, sr = 48000, bits = 16, dataAt = -1, dataLen = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4), len = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') (ch = b.readUInt16LE(pos + 10)), (sr = b.readUInt32LE(pos + 12)), (bits = b.readUInt16LE(pos + 22));
    if (id === 'data') {
      dataAt = pos + 8;
      dataLen = Math.min(len, b.length - dataAt);
      break;
    }
    pos += 8 + len + (len & 1);
  }
  if (dataAt < 0 || bits !== 16) return null;
  const n = Math.floor(dataLen / (2 * ch));
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += b.readInt16LE(dataAt + (i * ch + c) * 2);
    x[i] = s / ch / 32768;
  }
  return { x, sr };
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]], [im[i], im[j]] = [im[j], im[i]];
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, c = i + k + len / 2;
        const tr = re[c] * cr - im[c] * ci, ti = re[c] * ci + im[c] * cr;
        re[c] = re[a] - tr, im[c] = im[a] - ti, re[a] += tr, im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export function voiceProfile(file: string): VoiceProfile | null {
  const w = readWavMono(file);
  if (!w || w.x.length < w.sr * 0.5) return null;
  const { x, sr } = w;
  // espectro médio por faixa (quadros de 2048 com fala)
  const N = 2048;
  const hann = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const edges = Array.from({ length: NB + 1 }, (_, i) => 100 * Math.pow(100, i / NB));
  const power = new Float64Array(NB);
  let frames = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i + N <= x.length; i += N / 2) {
    let e = 0;
    for (let k = 0; k < N; k++) e += x[i + k] * x[i + k];
    if (Math.sqrt(e / N) < 0.02) continue;
    for (let k = 0; k < N; k++) (re[k] = x[i + k] * hann[k]), (im[k] = 0);
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * sr) / N;
      if (f < edges[0] || f >= edges[NB]) continue;
      let band = 0;
      while (band < NB - 1 && f >= edges[band + 1]) band++;
      power[band] += re[k] * re[k] + im[k] * im[k];
    }
    frames++;
  }
  if (frames < 5) return null;
  const db = Array.from(power, (p) => 10 * Math.log10(p / frames + 1e-12));
  const mean = db.reduce((a, b) => a + b, 0) / NB;
  // tom (autocorrelação em 16 kHz): mediana dos quadros com voz clara
  const dec = Math.max(1, Math.round(sr / 16000)), fs = sr / dec;
  const y = new Float32Array(Math.floor(x.length / dec));
  for (let i = 0; i < y.length; i++) {
    let s = 0;
    for (let k = 0; k < dec; k++) s += x[i * dec + k];
    y[i] = s / dec;
  }
  const fl = Math.round(fs * 0.04), hop = Math.round(fs * 0.02), lo = Math.round(fs / 400), hi = Math.round(fs / 70);
  const f0s: number[] = [];
  for (let i = 0; i + fl + hi < y.length; i += hop * 2) {
    let m = 0;
    for (let k = 0; k < fl; k++) m += y[i + k];
    m /= fl;
    let ac0 = 0;
    for (let k = 0; k < fl; k++) ac0 += (y[i + k] - m) ** 2;
    if (Math.sqrt(ac0 / fl) < 0.02) continue;
    let best = 0, bestLag = 0;
    for (let lag = lo; lag <= hi; lag++) {
      let s = 0;
      for (let k = 0; k + lag < fl; k++) s += (y[i + k] - m) * (y[i + k + lag] - m);
      if (s > best) (best = s), (bestLag = lag);
    }
    if (bestLag && best / ac0 > 0.5) f0s.push(fs / bestLag);
  }
  f0s.sort((a, b) => a - b);
  return { bands: db.map((v) => v - mean), f0: f0s.length >= 8 ? f0s[f0s.length >> 1] : 0 };
}

const median = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1];

/** Perfil de referência: a mediana de todas as falas (a maioria é a voz certa). */
export function referenceProfile(list: VoiceProfile[]): VoiceProfile | null {
  if (list.length < 5) return null;
  const bands = Array.from({ length: NB }, (_, b) => median(list.map((p) => p.bands[b])));
  const f0s = list.map((p) => p.f0).filter((f) => f > 0);
  return { bands, f0: f0s.length ? median(f0s) : 0 };
}

/** Distância ao padrão: diferença média do espectro (dB) e razão de tom. Quanto maior, mais "outra voz". */
export function voiceDistance(p: VoiceProfile, ref: VoiceProfile): number {
  const spec = Math.sqrt(p.bands.reduce((a, v, i) => a + (v - ref.bands[i]) ** 2, 0) / NB);
  const pitch = p.f0 > 0 && ref.f0 > 0 ? Math.abs(Math.log2(p.f0 / ref.f0)) : 0; // 0,25 ≈ 3 semitons
  return spec + pitch * 12;
}

/** Acima disso a fala soa como outra voz (no Tomb Raider: narrador quase sempre ≤ 5, voz trocada ≥ 8). */
export const OFF_VOICE = 7.5;
