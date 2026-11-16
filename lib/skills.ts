// Habilidades dos agentes (Leitor, Cortador, Montador): arquivos .md em <studio>/_skills/<agente>/, globais para todas as
// obras. Os padrões (lib/skills-default.ts) são gravados na primeira vez; depois o que está no disco manda: você pode
// editar, apagar ou acrescentar. O aprendizado pode acrescentar habilidades novas com addLearnedSkill.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SKILLS, type Agent } from './skills-default';
import { studioDir } from './store';

export type { Agent } from './skills-default';
export const AGENTS: Agent[] = ['leitor', 'cortador', 'montador', 'diretor'];

const dirOf = (a: Agent) => path.join(studioDir(), '_skills', a);
const fileOf = (a: Agent, id: string) => path.join(dirOf(a), `${id.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.md`);

/** Grava as habilidades padrão que ainda não existem (nunca sobrescreve o que você editou). */
export function seedSkills(): void {
  for (const a of AGENTS) {
    fs.mkdirSync(dirOf(a), { recursive: true });
    for (const s of DEFAULT_SKILLS[a]) {
      const f = fileOf(a, s.id);
      if (!fs.existsSync(f)) fs.writeFileSync(f, `# ${s.title}\n${s.body}\n`, 'utf8');
    }
  }
}

export interface Skill { id: string; title: string; body: string }

export function readSkills(agent: Agent): Skill[] {
  try {
    seedSkills();
    return fs
      .readdirSync(dirOf(agent))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => {
        const raw = fs.readFileSync(path.join(dirOf(agent), f), 'utf8').trim();
        const [first, ...rest] = raw.split('\n');
        const hasTitle = first.startsWith('#');
        return { id: f.replace(/\.md$/, ''), title: hasTitle ? first.replace(/^#+\s*/, '') : f, body: (hasTitle ? rest : [first, ...rest]).join('\n').trim() };
      })
      .filter((s) => s.body);
  } catch {
    // sem disco (ou pasta inacessível): usa os padrões em memória
    return DEFAULT_SKILLS[agent];
  }
}

/** Bloco para o prompt do agente: as habilidades dele, na ordem dos arquivos. */
export function skillsPrompt(agent: Agent, max = 6000): string {
  const list = readSkills(agent);
  if (!list.length) return '';
  const head = agent === 'leitor' ? 'HABILIDADES DO LEITOR' : agent === 'cortador' ? 'HABILIDADES DO CORTADOR' : agent === 'diretor' ? 'HABILIDADES DO DIRETOR DE SHORTS' : 'HABILIDADES DO MONTADOR';
  return `\n\n${head} (padrão global para todas as obras; siga sempre):\n${list.map((s) => `## ${s.title}\n${s.body}`).join('\n')}\n`.slice(0, max);
}

/** O aprendizado (ou você) acrescenta uma habilidade nova; mesmo id substitui a anterior. */
export function addLearnedSkill(agent: Agent, id: string, title: string, body: string): void {
  fs.mkdirSync(dirOf(agent), { recursive: true });
  fs.writeFileSync(fileOf(agent, id), `# ${title}\n${body.trim()}\n`, 'utf8');
}
