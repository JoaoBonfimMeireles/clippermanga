// Consumo do OmniRoute pelas rotas de gerenciamento. Só no servidor: a OMNIROUTE_MANAGEMENT_KEY nunca vai ao navegador.
// Tipos e conversão para tabela/CSV: lib/omniroute-usage-types.ts.
// Os logs podem conter o conteúdo das requisições: não registrar no console nem gravar em disco.
import { omniRootUrl } from './omniroute';

export const USAGE_REPORTS = {
  analytics: '/api/usage/analytics',
  history: '/api/usage/history',
  'request-logs': '/api/usage/request-logs',
  'logs-export': '/api/logs/export',
  quota: '/api/usage/quota',
} as const;
export type UsageReport = keyof typeof USAGE_REPORTS;

export class UsageError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchUsage(report: UsageReport, query?: URLSearchParams): Promise<unknown> {
  const mk = process.env.OMNIROUTE_MANAGEMENT_KEY?.trim();
  if (!mk) throw new UsageError('OMNIROUTE_MANAGEMENT_KEY não definida. Crie no painel do OmniRoute uma chave com permissão de gerenciamento e coloque no .env (a chave de inferência não serve).', 412);
  const url = `${omniRootUrl()}${USAGE_REPORTS[report]}${query?.size ? `?${query}` : ''}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${mk}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  } catch {
    throw new UsageError('OmniRoute não respondeu. Rode "omniroute" no PowerShell e deixe a janela aberta.', 502);
  }
  if (res.status === 401) throw new UsageError('401: o OmniRoute pediu autenticação. Defina OMNIROUTE_MANAGEMENT_KEY no .env.', 401);
  if (res.status === 403) throw new UsageError('403: a chave em OMNIROUTE_MANAGEMENT_KEY não tem permissão de gerenciamento (ou é uma chave comum de inferência). Gere uma chave de gerenciamento no painel do OmniRoute.', 403);
  if (!res.ok) throw new UsageError(`OmniRoute respondeu HTTP ${res.status} em ${USAGE_REPORTS[report]}`, res.status);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text }; // /api/logs/export pode não ser JSON
  }
}
