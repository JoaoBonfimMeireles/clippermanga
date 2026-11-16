// Medidor de uso da IA por job: quantas chamadas e tokens foram para cada provedor (grátis vs Claude).
// Os provedores do app de cortes (Claude Code, API da Anthropic, Gemini...) informam os tokens exatos por um ouvinte
// global (setLLMUsageListener); cada chamada roda num AsyncLocalStorage, então o evento cai no job certo mesmo com
// jobs em paralelo. O OmniRoute não informa por esse canal: para ele os tokens são estimados (marcados com "≈").
import { AsyncLocalStorage } from 'node:async_hooks';
import { setLLMUsageListener, type LLMImage, type LLMProvider, type LLMRequest, type LLMUsageEvent } from '@clipper/ai-providers';
import { createMangaLLM } from './llm';
import type { JobCtx } from './jobs';

const g = globalThis as unknown as { __mangaMeterAls?: AsyncLocalStorage<LLMUsageEvent[]>; __mangaMeterOn?: boolean };
const als = (g.__mangaMeterAls ??= new AsyncLocalStorage<LLMUsageEvent[]>());
function install() {
  if (g.__mangaMeterOn) return;
  g.__mangaMeterOn = true;
  setLLMUsageListener((e) => als.getStore()?.push(e));
}

/** O provedor atual é o Claude (assinatura pelo CLI ou API)? Pago/limitado: vale economizar chamadas. */
export const isClaude = (llm: Pick<LLMProvider, 'name'>) => /claude|anthropic/i.test(llm.name);

interface Row {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  images: number;
  costUsd: number;
  estimated: boolean;
}

/** Tamanho (px) de um JPEG/PNG em base64, para estimar tokens de imagem. */
function imageSize(img: LLMImage): { w: number; h: number } | null {
  try {
    const b = Buffer.from(img.base64.slice(0, 200_000), 'base64');
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    for (let i = 2; i < b.length - 9; ) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  } catch {
    /* formato inesperado */
  }
  return null;
}

/** Estimativa grosseira (regra da Anthropic: ~w·h/750 por imagem, até ~1600; texto ~3,5 caracteres por token). */
function estimate(req: LLMRequest, out: string) {
  const img = (req.images ?? []).reduce((n, i) => {
    const s = imageSize(i);
    return n + (s ? Math.min(1600, Math.round((s.w * s.h) / 750)) : 1000);
  }, 0);
  return { inputTokens: Math.round((req.system.length + req.prompt.length) / 3.5) + img, outputTokens: Math.round(out.length / 3.5) };
}

export interface MeteredLLM extends LLMProvider {
  /** Resumo do uso por provedor, para o log do job. */
  report(): string;
  /** Chamadas que foram para o Claude neste job. */
  claudeCalls(): number;
}

/** Envolve o provedor (no lugar, como lib/llm.ts faz) para contar o uso de cada chamada. */
export function meter(llm: LLMProvider): MeteredLLM {
  install();
  const rows = new Map<string, Row>();
  const row = (provider: string, model: string, estimated: boolean) => {
    const k = `${provider}|${model}`;
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { provider, model, calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, images: 0, costUsd: 0, estimated }));
    return r;
  };
  const inner = llm.complete.bind(llm);
  const m = llm as MeteredLLM;
  m.complete = async (req: LLMRequest) => {
    const events: LLMUsageEvent[] = [];
    let out: string | undefined;
    try {
      out = await als.run(events, () => inner(req));
      return out;
    } finally {
      // tokens exatos de quem informou (inclui tentativas que falharam e foram cobradas)
      for (const e of events) {
        const r = row(e.provider, e.model, false);
        r.calls++;
        r.inputTokens += e.inputTokens;
        r.cacheReadTokens += e.cacheReadTokens;
        r.outputTokens += e.outputTokens;
        r.costUsd += e.costUsd;
        r.images += req.images?.length ?? 0;
      }
      // respondido por quem não informa tokens (OmniRoute): estima
      if (out !== undefined && !events.length) {
        const est = estimate(req, out);
        const r = row(llm.name, llm.model, true);
        r.calls++;
        r.inputTokens += est.inputTokens;
        r.outputTokens += est.outputTokens;
        r.images += req.images?.length ?? 0;
      }
    }
  };
  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  m.claudeCalls = () => [...rows.values()].filter((r) => isClaude({ name: r.provider })).reduce((n, r) => n + r.calls, 0);
  m.report = () => {
    if (!rows.size) return 'Uso da IA: nenhuma chamada';
    const line = (r: Row) =>
      `${r.provider} (${r.model}): ${r.calls} chamada(s), ${r.images} imagem(ns), ${r.estimated ? '≈' : ''}${k(r.inputTokens)} tokens de entrada` +
      `${r.cacheReadTokens ? ` (${k(r.cacheReadTokens)} do cache)` : ''}, ${r.estimated ? '≈' : ''}${k(r.outputTokens)} de saída${r.costUsd ? ` · equivalente a US$ ${r.costUsd.toFixed(3)}` : ''}`;
    const all = [...rows.values()];
    const claude = all.filter((r) => isClaude({ name: r.provider }));
    const free = all.filter((r) => !isClaude({ name: r.provider }));
    const sum = (rs: Row[], f: (r: Row) => number) => rs.reduce((n, r) => n + f(r), 0);
    return [
      `Uso da IA neste job — grátis: ${sum(free, (r) => r.calls)} chamada(s) · Claude: ${sum(claude, (r) => r.calls)} chamada(s), ${k(sum(claude, (r) => r.inputTokens))} tokens de entrada, ${k(sum(claude, (r) => r.outputTokens))} de saída`,
      ...all.map((r) => `  · ${line(r)}`),
    ].join('\n');
  };
  return m;
}

/** Provedor do job (OmniRoute → reserva do app de cortes), com avisos no log e medidor de uso. */
export function jobLLM(ctx: Pick<JobCtx, 'log' | 'paid'>): MeteredLLM {
  const llm = createMangaLLM({ paidGate: ctx.paid });
  if (!llm) throw new Error('Configure um provedor de IA (OMNIROUTE_API_KEY no .env ou Configurações do app de cortes)');
  llm.onNotice = ctx.log;
  return meter(llm);
}
