// Quantas coisas esperam a aprovação do usuário (regras propostas pelo gestor), para o número no header.
import { readManager } from '@/lib/manager';

export const dynamic = 'force-dynamic';

export async function GET() {
  // mesma janela da tela de Gestão (últimas 10 auditorias)
  const proposals = readManager().audits.slice(-10).flatMap((a) => a.proposals.filter((x) => x.status === 'pending')).length;
  return Response.json({ proposals });
}
