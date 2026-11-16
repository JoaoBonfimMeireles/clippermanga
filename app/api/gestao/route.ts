// Tela de gestão: placar dos agentes, auditorias do gestor e propostas de regra (aprovar/recusar).
import { decideProposal, readManager, scoreboard } from '@/lib/manager';
import { readLearning } from '@/lib/learning';
import { MANAGED, AGENT_NAME } from '@/lib/manager';
import { readSkills } from '@/lib/skills';

export const dynamic = 'force-dynamic';

export async function GET() {
  const m = readManager();
  const l = readLearning();
  return Response.json({
    ...scoreboard(),
    audits: m.audits.slice(-10).reverse(),
    rules: l.rules.length,
    skills: Object.fromEntries(MANAGED.map((a) => [a, { name: AGENT_NAME[a], count: readSkills(a).length }])),
  });
}

export async function POST(req: Request) {
  const b = (await req.json()) as { action?: string; id?: string };
  if ((b.action === 'approve' || b.action === 'reject') && b.id) return decideProposal(b.id, b.action === 'approve') ? Response.json({ ok: true }) : new Response('Proposta não encontrada', { status: 404 });
  return new Response('Ação inválida', { status: 400 });
}
