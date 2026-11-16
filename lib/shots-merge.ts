// Salvar a linha do tempo sem gravar por cima do trabalho dos jobs.
// Antes a tela mandava TODAS as partes a cada salvamento: se um job (validar, aplicar estilo, piso de tamanho) tinha
// mexido no projeto depois que a tela carregou, o salvamento desfazia o que o job fez e ainda anotava a diferença
// como "correção do usuário" (foi isso que derrubou o placar do Cortador para 41 no solo-swordmaster).
// Agora a tela diz QUAIS partes ela mudou (comparando com o que carregou) e o servidor aplica só essas sobre a versão
// mais nova do disco. Sem fs: roda no navegador e no servidor.
import type { Shot } from './types';

/** Retrato das partes como o servidor as conhece (id → JSON), tirado ao carregar e depois de cada salvamento. */
export type ShotsBase = Map<string, string>;

export const baseOf = (shots: Shot[]): ShotsBase => new Map(shots.map((s) => [s.id, JSON.stringify(s)]));

export interface ShotsDelta {
  /** Partes novas ou alteradas pela tela desde o retrato. */
  changedIds: string[];
  /** Partes que a tela apagou desde o retrato. */
  removedIds: string[];
}

/** O que a tela mudou em relação ao retrato. Sem retrato (tela antiga): undefined = salvamento completo, como antes. */
export function shotsDelta(base: ShotsBase | null | undefined, shots: Shot[]): ShotsDelta | undefined {
  if (!base) return undefined;
  const now = new Set(shots.map((s) => s.id));
  return {
    changedIds: shots.filter((s) => base.get(s.id) !== JSON.stringify(s)).map((s) => s.id),
    removedIds: [...base.keys()].filter((id) => !now.has(id)),
  };
}

/**
 * Aplica o que a tela mudou sobre as partes do disco.
 * - parte alterada/criada pela tela: vale a da tela;
 * - parte que a tela não tocou: vale a do disco (o job pode ter mexido nela);
 * - parte que o job apagou e a tela não tocou: continua apagada;
 * - parte que o job criou depois de a tela carregar: fica, logo depois da vizinha anterior no disco;
 * - ordem: a da tela (mover uma parte muda a ordem, não o conteúdo).
 */
export function mergeShots(server: Shot[], client: Shot[], delta: ShotsDelta): Shot[] {
  const onDisk = new Map(server.map((s) => [s.id, s]));
  const changed = new Set(delta.changedIds);
  const removed = new Set(delta.removedIds);
  const out: Shot[] = [];
  const used = new Set<string>();
  for (const c of client) {
    if (used.has(c.id)) continue;
    const s = onDisk.get(c.id);
    if (!s && !changed.has(c.id)) continue;
    out.push(!s || changed.has(c.id) ? c : s);
    used.add(c.id);
  }
  for (const [i, s] of server.entries()) {
    if (used.has(s.id) || removed.has(s.id)) continue;
    const prev = server[i - 1]?.id;
    const at = prev ? out.findIndex((x) => x.id === prev) : -1;
    out.splice(at + 1, 0, s);
    used.add(s.id);
  }
  return out;
}
