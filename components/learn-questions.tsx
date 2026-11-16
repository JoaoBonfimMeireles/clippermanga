'use client';
// Perguntas que a IA faz sobre as suas correções (aprendizado). Mesmo painel no editor (aba 🧠) e na Gestão dos agentes:
// responder em qualquer um vale para os dois, porque tudo fica no mesmo arquivo global (/api/learning).
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BeforeAfter, DictateButton } from './learn-helpers';

export type LearnQuestion = { id: string; title: string; part: number; question: string; answer?: string; projectId: string };
export type Learning = { rules: string[]; questions: LearnQuestion[] };

export function useLearning(pollMs = 15000) {
  const [learn, setLearn] = useState<Learning | null>(null);
  const load = useCallback(() => fetch('/api/learning').then((r) => r.json()).then(setLearn).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(load, pollMs); // pega o que foi respondido ou perguntado em outra aba
    return () => clearInterval(t);
  }, [load, pollMs]);
  const post = (b: object) => fetch('/api/learning', { method: 'POST', body: JSON.stringify(b) }).then((r) => r.json()).then((l) => { setLearn(l); refreshPending(); });
  return { learn, post, reload: load };
}

export function LearnQuestions({ learn, post, onGoTo, currentProjectId }: { learn: Learning | null; post: (b: object) => Promise<unknown>; onGoTo?: (part: number) => void; currentProjectId?: string }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const open = (learn?.questions ?? []).filter((q) => !q.answer);
  if (!open.length) return <p className="text-xs text-muted-foreground">Nenhuma pergunta pendente.</p>;
  return (
    <>
      {open.map((q) => (
        <div key={q.id} className="space-y-1 rounded border border-amber-400/60 p-2 text-xs">
          <p>
            <span className="text-amber-300">❓ {q.title}{q.part ? ` · parte ${q.part}` : ''}:</span> {q.question}
          </p>
          {q.part > 0 && <BeforeAfter projectId={q.projectId} part={q.part} />}
          <textarea className="field h-14 text-xs" value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} placeholder="Explique o porquê da mudança (ou clique em Ditar e fale)" />
          <div className="flex flex-wrap items-center gap-1">
            <DictateButton onText={(t) => setAnswers((a) => ({ ...a, [q.id]: `${a[q.id] ? `${a[q.id]} ` : ''}${t}` }))} />
            <button className="btn-primary px-2 py-0.5 text-xs" disabled={!answers[q.id]?.trim()} onClick={() => post({ answer: { id: q.id, text: answers[q.id] } })}>
              Responder
            </button>
            <button className="btn px-2 py-0.5 text-xs" onClick={() => post({ dismiss: q.id })}>
              Ignorar
            </button>
            {q.part > 0 && onGoTo && q.projectId === currentProjectId && (
              <button className="btn px-2 py-0.5 text-xs" onClick={() => onGoTo(q.part)}>
                ver parte
              </button>
            )}
            {q.part > 0 && !(onGoTo && q.projectId === currentProjectId) && (
              <Link className="btn px-2 py-0.5 text-xs" href={`/p/${q.projectId}/editor`}>
                abrir no editor
              </Link>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/** Avisa o header para atualizar o número na hora (depois de responder ou aprovar), sem esperar a próxima consulta. */
export const refreshPending = () => window.dispatchEvent(new Event('manga-pending'));

/** Link do header: leva às perguntas e às regras para aprovar na Gestão, com o total que espera o usuário (em amarelo; sem nada quando zero). */
export function QuestionsLink() {
  const [n, setN] = useState(0);
  const load = useCallback(async () => {
    try {
      const [l, g] = await Promise.all([fetch('/api/learning').then((r) => r.json()) as Promise<Learning>, fetch('/api/gestao/pending').then((r) => r.json()) as Promise<{ proposals: number }>]);
      setN((l.questions ?? []).filter((q) => !q.answer).length + (g.proposals ?? 0));
    } catch {
      /* só um número de aviso */
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    window.addEventListener('manga-pending', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('manga-pending', load);
    };
  }, [load]);
  return (
    <Link href="/gestao#perguntas" className="ml-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" title={n ? `${n} esperando a sua resposta ou aprovação` : 'Perguntas da IA sobre as suas correções'}>
      <span>❓</span>
      {n > 0 && <span className="rounded-full bg-amber-400 px-1.5 text-[11px] font-bold leading-4 text-black">{n}</span>}
      <span>Perguntas</span>
    </Link>
  );
}
