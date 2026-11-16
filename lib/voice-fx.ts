// Efeitos para a narração gravada no microfone (seguro para o navegador: só tipos, presets e o filtro em texto).
// O mesmo filtro FFmpeg é usado na prévia (servidor gera o WAV tratado) e no render, então o que você ouve é o que sai.

export interface VoiceFx {
  /** Tom em semitons (−6 a +6), sem mudar a velocidade nem o timbre. */
  pitch: number;
  /** Timbre (−2,5 a +2,5): o "tamanho" da voz (formantes). Valores altos disfarçam: soa como outra pessoa. */
  timbre: number;
  /** Velocidade (0,75 a 1,5), sem mudar o tom. */
  speed: number;
  /** Redução de ruído de fundo (0 a 1). */
  denoise: number;
  /** Corta o som entre as frases (respiração, chiado baixo). */
  gate: boolean;
  /** Graves em dB (−10 a +10). */
  bass: number;
  /** Calor/corpo da voz em dB (−8 a +8). */
  warmth: number;
  /** Presença/clareza em dB (−8 a +8). */
  presence: number;
  /** Agudos/brilho em dB (−10 a +10). */
  treble: number;
  /** Suaviza os "S" chiados. */
  deesser: boolean;
  /** Compressão (0 a 1): volume mais constante, voz "de rádio". */
  compress: number;
  /** Eco/ambiente (0 a 1). */
  reverb: number;
  /** Volume final padronizado (bom para YouTube). */
  normalize: boolean;
  /** Sub-grave "de cinema" (0 a 1). */
  sub: number;
  /** Ar/brilho nos agudos (0 a 1). */
  air: number;
  /** Saturação: calor analógico, voz mais "gorda" (0 a 1). */
  saturation: number;
  /** Voz dobrada/encorpada (0 a 1). */
  double: number;
  /** Encurta pausas longas entre frases (0 a 1). */
  tightPauses: number;
  /** Tira estalos de boca e cliques. */
  declick: boolean;
  /** Efeito rádio antigo / comunicador. */
  radio: boolean;
}

export const FX_NEUTRAL: VoiceFx = { pitch: 0, timbre: 0, speed: 1, denoise: 0, gate: false, bass: 0, warmth: 0, presence: 0, treble: 0, deesser: false, compress: 0, reverb: 0, normalize: true, sub: 0, air: 0, saturation: 0, double: 0, tightPauses: 0, declick: false, radio: false };

const CLEAN = { denoise: 0.5, gate: true, declick: true, deesser: true };

/** Ajustes rápidos: "limpeza" e "personagens". Estilos genéricos (não imitam pessoas reais). */
export const FX_PRESETS: { id: string; name: string; note: string; group: 'Limpeza'; fx: VoiceFx }[] = [
  // disfarce forte: formantes bem deslocados para não lembrar a voz original
  { id: 'limpa', group: 'Limpeza', name: 'Limpa', note: 'tira ruído e padroniza o volume', fx: { ...FX_NEUTRAL, ...CLEAN, compress: 0.3 } },
  { id: 'podcast', group: 'Limpeza', name: 'Podcast', note: 'natural e próxima', fx: { ...FX_NEUTRAL, ...CLEAN, bass: 2, warmth: 2, presence: 2, compress: 0.4, air: 0.2 } },
  { id: 'locutor', group: 'Limpeza', name: 'Locutor', note: 'grave, encorpada, de rádio FM', fx: { ...FX_NEUTRAL, ...CLEAN, pitch: -1, timbre: -0.25, bass: 4, warmth: 3, presence: 2, compress: 0.6, saturation: 0.2, air: 0.2 } },
];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, Number.isFinite(v) ? v : 0));

export function normalizeFx(fx?: Partial<VoiceFx> | null): VoiceFx {
  const f = { ...FX_NEUTRAL, ...(fx ?? {}) };
  return {
    pitch: clamp(f.pitch, -6, 6),
    timbre: clamp(f.timbre, -1, 1),
    speed: clamp(f.speed || 1, 0.75, 1.5),
    denoise: clamp(f.denoise, 0, 1),
    gate: !!f.gate,
    bass: clamp(f.bass, -10, 10),
    warmth: clamp(f.warmth, -8, 8),
    presence: clamp(f.presence, -8, 8),
    treble: clamp(f.treble, -10, 10),
    deesser: !!f.deesser,
    compress: clamp(f.compress, 0, 1),
    reverb: clamp(f.reverb, 0, 1),
    normalize: f.normalize !== false,
    sub: clamp(f.sub, 0, 1),
    air: clamp(f.air, 0, 1),
    saturation: clamp(f.saturation, 0, 1),
    double: clamp(f.double, 0, 1),
    tightPauses: clamp(f.tightPauses, 0, 1),
    declick: !!f.declick,
    radio: !!f.radio,
  };
}

/** Cadeia de filtros FFmpeg (-af) para os efeitos. Entrada: WAV 48 kHz mono. */
export function fxFilter(fxIn?: Partial<VoiceFx> | null): string {
  const fx = normalizeFx(fxIn);
  const f: string[] = ['highpass=f=75']; // tira o ronco grave do microfone/mesa
  if (fx.declick) f.push('adeclick=w=55:o=75');
  if (fx.denoise > 0) f.push(`afftdn=nr=${(6 + fx.denoise * 24).toFixed(1)}:nf=-${(50 - fx.denoise * 15).toFixed(0)}:tn=1`);
  if (fx.gate) f.push('agate=threshold=0.015:ratio=3:attack=5:release=180:range=0.1');
  // encurta pausas longas (mantém um respiro natural)
  if (fx.tightPauses > 0) f.push(`silenceremove=stop_periods=-1:stop_threshold=-42dB:stop_duration=${(0.9 - fx.tightPauses * 0.5).toFixed(2)}:stop_silence=${(0.4 - fx.tightPauses * 0.2).toFixed(2)}`);
  // timbre: sobe/desce tudo (tom + formantes) e depois devolve só o tom → muda só o "corpo" da voz
  if (Math.abs(fx.timbre) > 0.01) {
    const k = 2 ** ((fx.timbre * 4) / 12);
    f.push(`asetrate=${Math.round(48000 * k)}`, 'aresample=48000', `rubberband=tempo=${(1 / k).toFixed(4)}:pitch=${(1 / k).toFixed(4)}:formant=preserved`);
  }
  if (Math.abs(fx.pitch) > 0.01 || Math.abs(fx.speed - 1) > 0.005) {
    f.push(`rubberband=tempo=${fx.speed.toFixed(3)}:pitch=${(2 ** (fx.pitch / 12)).toFixed(4)}:formant=preserved:transients=smooth`);
  }
  if (fx.bass) f.push(`bass=g=${fx.bass}:f=110:w=0.8`);
  if (fx.warmth) f.push(`equalizer=f=280:t=q:w=1:g=${fx.warmth}`);
  if (fx.presence) f.push(`equalizer=f=3200:t=q:w=1.2:g=${fx.presence}`);
  if (fx.treble) f.push(`treble=g=${fx.treble}:f=7000`);
  if (fx.sub > 0) f.push(`asubboost=boost=${(1 + fx.sub * 5).toFixed(1)}:cutoff=90:slope=0.6:decay=0.3`);
  if (fx.air > 0) f.push(`aexciter=amount=${(fx.air * 2.5).toFixed(2)}:freq=6000:blend=0`);
  if (fx.deesser) f.push('deesser=i=0.5:m=0.5:f=0.5');
  if (fx.saturation > 0) f.push(`volume=${(1 + fx.saturation * 4).toFixed(2)}`, 'asoftclip=type=tanh', `volume=${(1 / (1 + fx.saturation * 2.5)).toFixed(3)}`);
  if (fx.compress > 0) f.push(`acompressor=threshold=${(-12 - fx.compress * 14).toFixed(0)}dB:ratio=${(2 + fx.compress * 6).toFixed(1)}:attack=5:release=90:makeup=${(1 + fx.compress * 3).toFixed(1)}`);
  if (fx.radio) f.push('highpass=f=350', 'lowpass=f=3200', 'equalizer=f=1500:t=q:w=1:g=6');
  if (fx.double > 0) f.push(`chorus=0.6:0.9:${Math.round(18 + fx.double * 12)}|${Math.round(27 + fx.double * 14)}:${(0.25 + fx.double * 0.35).toFixed(2)}|${(0.2 + fx.double * 0.3).toFixed(2)}:0.3|0.4:1.5|2`);
  if (fx.reverb > 0) f.push(`aecho=0.8:${(0.5 + fx.reverb * 0.4).toFixed(2)}:${Math.round(30 + fx.reverb * 50)}|${Math.round(60 + fx.reverb * 90)}:${(0.12 + fx.reverb * 0.25).toFixed(2)}|${(0.06 + fx.reverb * 0.15).toFixed(2)}`);
  if (fx.normalize) f.push('loudnorm=I=-16:TP=-1.5:LRA=9');
  f.push('aresample=48000');
  return f.join(',');
}

/** Gravação de uma parte (WAV mono 48 kHz, sem efeitos). */
export interface Recording {
  file: string; // relativo à pasta do projeto
  dur: number;
  at: string;
}

export interface NarrationData {
  fx: VoiceFx;
  /** shotId → gravação */
  items: Record<string, Recording>;
}
