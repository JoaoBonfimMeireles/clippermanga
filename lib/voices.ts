// Catálogo de vozes de narração (seguro para o navegador). A síntese fica em lib/voice.ts.
export interface Voice {
  id: string;
  name: string;
  /** Quem fornece (cota contada por provedor). */
  provider: string;
  engine: 'edge' | 'gemini' | 'omni';
  /** edge: nome da voz; gemini: voz pré-pronta; omni: modelo do OmniRoute. */
  model: string;
  note: string;
  rate?: string;
  pitch?: string;
  style?: string;
  voiceName?: string;
  tempo?: number;
  /** Fora da lista de escolha (só reserva). */
  hidden?: boolean;
}

const ANIMADO = 'Narre em português do Brasil, animado e envolvente, como um youtuber contando um mangá incrível';
const SERIO = 'Narre em português do Brasil, com voz grave, dramática e cheia de suspense, como trailer de anime';

export const VOICES: Voice[] = [
  { id: 'fish-animado-dark', name: 'Animado Dark', provider: 'fishaudio', engine: 'omni', model: 'fishaudio/s2.1-pro-free', voiceName: '39ba7b1ab5d44e5dab4ab09d6a0354ad', note: 'Fish Audio · modelo grátis · a principal' },
  { id: 'fish-alex-jovem', name: 'Alex jovem', provider: 'fishaudio', engine: 'omni', model: 'fishaudio/s2.1-pro-free', voiceName: '4b02d057165c4798b0ceba194b765e90', note: 'Fish Audio · modelo grátis' },
  { id: 'eleven-will', name: 'Will', provider: 'elevenlabs', engine: 'omni', model: 'elevenlabs/eleven_multilingual_v2', voiceName: 'bIHbv24MWmeRgasZH58o', note: 'ElevenLabs · ~10 min/mês grátis' },
  { id: 'eleven-liam', name: 'Liam', provider: 'elevenlabs', engine: 'omni', model: 'elevenlabs/eleven_multilingual_v2', voiceName: 'TX3LPaxmHKxFdv7VOQHJ', note: 'ElevenLabs · ~10 min/mês grátis' },
  // reserva de emergência (não aparece na escolha): só entra se as 4 acima ficarem sem cota, para o render não parar
  { id: 'edge-antonio-animado', name: 'Antonio (emergência)', provider: 'edge', engine: 'edge', model: 'pt-BR-AntonioNeural', rate: '+18%', pitch: '+15Hz', note: 'Microsoft · grátis e ilimitada', hidden: true },
];

/** Fila: se a voz da vez falhar ou a cota acabar, a fala continua com a próxima, a partir daquele trecho. */
export const VOICE_CHAIN = ['fish-animado-dark', 'eleven-will', 'fish-alex-jovem', 'eleven-liam', 'edge-antonio-animado'];

export const DEFAULT_VOICE = 'fish-animado-dark';

/** Frase da amostra (~10 s). */
export const SAMPLE_TEXT =
  'E foi nesse momento que tudo mudou. O jovem espadachim ergueu a lâmina, encarou o monstro gigante à sua frente e, sem hesitar, avançou. Ninguém imaginava o que estava prestes a acontecer.';
