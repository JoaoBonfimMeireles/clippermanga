// GET /api/usage?report=analytics|history|request-logs|logs-export|quota&format=json|csv
// Faz a chamada ao OmniRoute no servidor (a chave de gerenciamento não sai daqui). Demais parâmetros são repassados.
import { fetchUsage, USAGE_REPORTS, UsageError, type UsageReport } from '@/lib/omniroute-usage';
import { toCsv } from '@/lib/omniroute-usage-types';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const report = url.searchParams.get('report') as UsageReport;
  const format = url.searchParams.get('format') ?? 'json';
  if (!(report in USAGE_REPORTS)) return Response.json({ error: 'report inválido', reports: Object.keys(USAGE_REPORTS) }, { status: 400 });
  const pass = new URLSearchParams(url.searchParams);
  pass.delete('report');
  pass.delete('format');
  pass.delete('download');
  const noStore = { 'cache-control': 'no-store, private' };
  try {
    const data = await fetchUsage(report, pass);
    const dl = url.searchParams.has('download');
    if (format === 'csv')
      return new Response('﻿' + toCsv(report, data), { headers: { ...noStore, 'content-type': 'text/csv; charset=utf-8', ...(dl ? { 'content-disposition': `attachment; filename="omniroute-${report}.csv"` } : {}) } });
    return new Response(JSON.stringify(data, null, 2), { headers: { ...noStore, 'content-type': 'application/json', ...(dl ? { 'content-disposition': `attachment; filename="omniroute-${report}.json"` } : {}) } });
  } catch (e) {
    const status = e instanceof UsageError ? e.status : 500;
    return Response.json({ error: (e as Error).message }, { status, headers: noStore });
  }
}
