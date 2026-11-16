// Tipos das rotas de consumo do OmniRoute, escritos a partir do JSON real (inspecionado em 2026-11-04).
// Sem dependências de servidor: a tela também usa tableOf() para mostrar as tabelas.

export interface Totals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  cost: number;
}

export interface UsageAnalytics {
  summary: {
    totalRequests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    successfulRequests: number;
    successRatePct: number;
    avgLatencyMs: number;
    totalCost: number;
    firstRequest: string;
    lastRequest: string;
    fallbackCount: number;
    [k: string]: unknown;
  };
  dailyTrend: ({ date: string } & Totals)[];
  byModel: ({ model: string; provider: string; rawModel: string; avgLatencyMs: number; successRatePct: string; lastUsed: string } & Totals)[];
  byProvider: ({ provider: string; avgLatencyMs: number; successRatePct: string } & Totals)[];
  byApiKey: ({ apiKey: string; apiKeyId: string; apiKeyName: string } & Totals)[];
  byAccount: ({ account: string; avgLatencyMs: number; lastUsed: string } & Totals)[];
  [k: string]: unknown;
}

export interface UsageHistory {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: number;
  byProvider: Record<string, Totals>;
  byModel: Record<string, Totals & { rawModel: string; provider: string; lastUsed: string }>;
  [k: string]: unknown;
}

/** /api/usage/request-logs devolve linhas de texto já formatadas. */
export type UsageRequestLogs = string[];

export interface ExportedLog {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  model: string;
  requestedModel: string;
  provider: string;
  account: string;
  duration: number;
  tokens: { in: number; out: number; cacheRead: number; reasoning: number; [k: string]: unknown };
  apiKeyName: string;
  comboName: string;
  error: unknown;
  /** Conteúdo das mensagens: privado. Fica fora do CSV. */
  requestBody?: unknown;
  responseBody?: unknown;
  [k: string]: unknown;
}
export interface LogsExport {
  estimatedCount: number;
  hours: number;
  type: string;
  count: number;
  logs: ExportedLog[];
}

export interface UsageQuota {
  providers: { name: string; provider: string; connectionId: string; quotaUsed: number; quotaTotal: number | null; percentRemaining: number; resetAt: string | null; tokenStatus: string }[];
  meta: { generatedAt: string; totalProviders: number; [k: string]: unknown };
}

export type Row = Record<string, string | number | boolean | null>;
export interface Table {
  title: string;
  rows: Row[];
}

const n = (x: unknown) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x == null ? null : (x as string));

/** Transforma cada relatório em tabelas legíveis (usado na tela e no CSV). */
export function tablesOf(report: string, data: unknown): Table[] {
  switch (report) {
    case 'analytics': {
      const a = data as UsageAnalytics;
      const s = a.summary;
      return [
        { title: 'Resumo', rows: [{ requisições: s.totalRequests, sucesso_pct: s.successRatePct, tokens_entrada: s.promptTokens, tokens_saida: s.completionTokens, tokens_total: s.totalTokens, custo_usd: n(s.totalCost), latencia_media_ms: s.avgLatencyMs, fallbacks: s.fallbackCount, primeira: s.firstRequest, ultima: s.lastRequest }] },
        { title: 'Tendência diária', rows: a.dailyTrend.map((d) => ({ data: d.date, requisições: d.requests, tokens_total: d.totalTokens ?? null, custo_usd: n(d.cost) })) },
        { title: 'Por modelo', rows: a.byModel.map((m) => ({ modelo: m.model, provedor: m.provider, requisições: m.requests, tokens_total: m.totalTokens ?? null, sucesso_pct: m.successRatePct, latencia_media_ms: m.avgLatencyMs, custo_usd: n(m.cost), ultimo_uso: m.lastUsed })) },
        { title: 'Por provedor', rows: a.byProvider.map((p) => ({ provedor: p.provider, requisições: p.requests, tokens_total: p.totalTokens ?? null, sucesso_pct: p.successRatePct, latencia_media_ms: p.avgLatencyMs, custo_usd: n(p.cost) })) },
        // só o nome da chave; o identificador/prefixo da chave fica de fora
        { title: 'Por chave', rows: a.byApiKey.map((k) => ({ chave: k.apiKeyName, requisições: k.requests, tokens_total: k.totalTokens ?? null, custo_usd: n(k.cost) })) },
      ];
    }
    case 'history': {
      const h = data as UsageHistory;
      return [
        { title: 'Totais', rows: [{ requisições: h.totalRequests, tokens_entrada: h.totalPromptTokens, tokens_saida: h.totalCompletionTokens, custo_usd: n(h.totalCost) }] },
        { title: 'Por provedor', rows: Object.entries(h.byProvider).map(([k, v]) => ({ provedor: k, requisições: v.requests, tokens_entrada: v.promptTokens, tokens_saida: v.completionTokens, custo_usd: n(v.cost) })) },
        { title: 'Por modelo', rows: Object.values(h.byModel).map((v) => ({ modelo: v.rawModel, provedor: v.provider, requisições: v.requests, tokens_entrada: v.promptTokens, tokens_saida: v.completionTokens, custo_usd: n(v.cost), ultimo_uso: v.lastUsed })) },
      ];
    }
    case 'request-logs':
      return [{ title: 'Registros', rows: (data as UsageRequestLogs).map((linha) => ({ linha })) }];
    case 'logs-export': {
      const e = data as LogsExport;
      return [
        {
          title: `Logs (${e.count} nas últimas ${e.hours} h)`,
          rows: e.logs.map((l) => ({ hora: l.timestamp, status: l.status, modelo: l.model, pedido: l.requestedModel, provedor: l.provider, combo: l.comboName, duracao_ms: l.duration, tokens_entrada: l.tokens?.in ?? null, tokens_saida: l.tokens?.out ?? null, chave: l.apiKeyName, erro: l.error ? JSON.stringify(l.error).slice(0, 200) : '' })),
        },
      ];
    }
    case 'quota':
      return [{ title: 'Cotas por provedor', rows: (data as UsageQuota).providers.map((p) => ({ nome: p.name, provedor: p.provider, usado: p.quotaUsed, total: p.quotaTotal, restante_pct: p.percentRemaining, renova_em: p.resetAt, status: p.tokenStatus })) }];
    default:
      return [];
  }
}

export function toCsv(report: string, data: unknown): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return tablesOf(report, data)
    .map((t) => {
      const cols = [...new Set(t.rows.flatMap((r) => Object.keys(r)))];
      return [`# ${t.title}`, cols.map(esc).join(','), ...t.rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    })
    .join('\n\n');
}
