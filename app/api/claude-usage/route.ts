// GET /api/claude-usage: uso do plano do Claude (5 h, 7 dias, última hora, 24 h) para o header.
import { claudeUsage } from '@/lib/claude-usage';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(claudeUsage(), { headers: { 'cache-control': 'no-store' } });
}
