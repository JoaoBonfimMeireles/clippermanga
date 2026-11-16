// Perfis de corte aprendidos nos testes (lib/cut-profiles.ts): leitura e remoção de regras.
import { deleteCutRule, listCutProfiles, readGlobalCuts } from '@/lib/cut-profiles';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ global: readGlobalCuts(), profiles: listCutProfiles() });
}

/** DELETE ?profile=<chave da obra | _global>&rule=<id da regra> */
export async function DELETE(req: Request) {
  const q = new URL(req.url).searchParams;
  return deleteCutRule(q.get('profile') ?? '', q.get('rule') ?? '') ? new Response(null, { status: 204 }) : new Response('Regra não encontrada', { status: 404 });
}
