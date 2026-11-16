// REGRA FIXA do usuário (vale para todo mangá/webtoon/manual): nenhuma imagem aparece sem fala.
// Parte sem texto narrado é removida da linha do tempo (a narração das vizinhas costura a história).
// Exceção: narração por microfone ("mic"), em que o texto vazio não quer dizer ausência de fala.
import { readProject, updateProject } from './store';

export const hasSpeech = (s: { text: string }) => !!s.text.trim();

/** Remove da linha do tempo as partes sem fala. Devolve quantas saíram. */
export function dropSilentShots(projectId: string): number {
  const p = readProject(projectId);
  if (!p || p.narration === 'mic') return 0;
  const silent = p.shots.filter((s) => !hasSpeech(s)).length;
  if (!silent || silent === p.shots.length) return 0; // nada a tirar (ou ainda sem roteiro)
  updateProject(projectId, (cur) => {
    cur.shots = cur.shots.filter(hasSpeech);
  });
  return silent;
}
