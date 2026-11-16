// Aprendizado da IA com as edições do usuário: regras e perguntas (lib/learning.ts).
import { readLearning, writeLearning } from '@/lib/learning';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(readLearning());
}

/** {answer: {id, text}} responde uma pergunta · {dismiss: id} descarta · {removeRule: n} · {addRule: texto} */
export async function POST(req: Request) {
  const b = (await req.json()) as { answer?: { id: string; text: string }; dismiss?: string; removeRule?: number; addRule?: string };
  const l = readLearning();
  if (b.answer) {
    const q = l.questions.find((x) => x.id === b.answer!.id);
    if (q) q.answer = b.answer.text.trim();
  }
  if (b.dismiss) l.questions = l.questions.filter((x) => x.id !== b.dismiss);
  if (typeof b.removeRule === 'number') l.rules.splice(b.removeRule, 1);
  if (b.addRule?.trim()) l.rules.push(b.addRule.trim());
  writeLearning(l);
  return Response.json(l);
}
