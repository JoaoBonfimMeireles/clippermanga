// Uso do plano do Claude (assinatura) para o header. O Claude Code CLI informa a cada chamada quanto das janelas de
// 5 h e de 7 dias já foi usado (claudeLimits, só em memória). Aqui as amostras ficam em disco (projetos/_claude-usage.json,
// fora do git) para sobreviver a reinícios e para calcular quanto foi gasto na última hora e nas últimas 24 h.
// Só o Claude: o consumo do OmniRoute/provedores grátis não entra.
import fs from 'node:fs';
import path from 'node:path';
import { claudeLimits } from '@clipper/ai-providers';

interface Sample {
  at: number;
  five?: number; // 0..1, janela de 5 h
  seven?: number; // 0..1, janela de 7 dias
}

const FILE = path.join(process.cwd(), 'projetos', '_claude-usage.json');
const KEEP_MS = 8 * 24 * 3.6e6;

function load(): Sample[] {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/** Quanto subiu o uso nas amostras de [since, agora]. Quedas (a janela renovou) não contam. */
function gained(samples: Sample[], key: 'five' | 'seven', since: number): number | null {
  const pts = samples.filter((s) => typeof s[key] === 'number');
  if (!pts.length) return null;
  const before = [...pts].reverse().find((s) => s.at < since);
  const inside = pts.filter((s) => s.at >= since);
  const seq = before ? [before, ...inside] : inside;
  let sum = 0;
  for (let i = 1; i < seq.length; i++) sum += Math.max(0, (seq[i][key] as number) - (seq[i - 1][key] as number));
  return sum;
}

export interface ClaudeUsageSummary {
  /** Tudo em % (0..100). null = ainda sem dado (nenhuma chamada ao Claude desde que o servidor subiu). */
  fiveHour: number | null;
  fiveHourResetsAt: number | null;
  sevenDay: number | null;
  /** Quanto da janela de 5 h foi gasto na última hora. */
  lastHour: number | null;
  /** Quanto da janela de 7 dias foi gasto nas últimas 24 h. */
  last24h: number | null;
  updatedAt: number | null;
}

export function claudeUsage(): ClaudeUsageSummary {
  const now = Date.now();
  let samples = load();
  const l = claudeLimits();
  if (l && l.at > (samples.at(-1)?.at ?? 0) && (l.fiveHour != null || l.sevenDay != null)) {
    samples = [...samples, { at: l.at, five: l.fiveHour, seven: l.sevenDay }].filter((s) => now - s.at < KEEP_MS);
    try {
      fs.writeFileSync(FILE, JSON.stringify(samples));
    } catch {
      /* sem permissão de escrita: segue só com a memória */
    }
  }
  const last = samples.at(-1);
  const pct = (v: number | null | undefined) => (v == null ? null : Math.round(v * 1000) / 10);
  // janela de 5 h já renovada: o último valor guardado deixou de valer
  const fiveExpired = l?.fiveHourResetsAt != null && l.fiveHourResetsAt < now;
  return {
    fiveHour: fiveExpired ? 0 : pct(last?.five),
    fiveHourResetsAt: l?.fiveHourResetsAt ?? null,
    sevenDay: pct(last?.seven),
    lastHour: pct(gained(samples, 'five', now - 3.6e6)),
    last24h: pct(gained(samples, 'seven', now - 24 * 3.6e6)),
    updatedAt: last?.at ?? null,
  };
}
