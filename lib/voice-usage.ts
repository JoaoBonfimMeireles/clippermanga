// Registro de uso das vozes (TTS), para comparar provedores: quanto cada uma narrou, quanto texto gastou por
// minuto de áudio, quanto demora, quantas vezes falhou ou ficou sem cota. Fica em <estúdio>/_voices/usage.json
// (sem o conteúdo das falas, só números). Mostrado em /usage.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './store';
import type { Voice } from './voices';

export interface VoiceStats {
  voice: string;
  name: string;
  provider: string;
  requests: number;
  ok: number;
  fail: number;
  quotaHits: number;
  chars: number;
  audioSec: number;
  ms: number;
  lastAt: string;
  lastError?: string;
  /** Uso por dia (AAAA-MM-DD). */
  days: Record<string, { requests: number; chars: number; audioSec: number; fail: number }>;
}

const file = () => path.join(path.dirname(projectDir('x')), '_voices', 'usage.json');

export function readVoiceUsage(): Record<string, VoiceStats> {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

export function recordVoiceUse(v: Voice, r: { ok: boolean; chars: number; ms: number; audioSec?: number; error?: string; quota?: boolean }) {
  try {
    const all = readVoiceUsage();
    const s = (all[v.id] ??= { voice: v.id, name: v.name, provider: v.provider, requests: 0, ok: 0, fail: 0, quotaHits: 0, chars: 0, audioSec: 0, ms: 0, lastAt: '', days: {} });
    const day = new Date().toISOString().slice(0, 10);
    const d = (s.days[day] ??= { requests: 0, chars: 0, audioSec: 0, fail: 0 });
    s.requests++, d.requests++;
    s.lastAt = new Date().toISOString();
    if (r.ok) {
      s.ok++;
      s.chars += r.chars, d.chars += r.chars;
      s.audioSec += r.audioSec ?? 0, d.audioSec += r.audioSec ?? 0;
      s.ms += r.ms;
    } else {
      s.fail++, d.fail++;
      if (r.quota) s.quotaHits++;
      s.lastError = r.error?.slice(0, 200);
    }
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
  } catch {
    /* estatística nunca derruba a narração */
  }
}
