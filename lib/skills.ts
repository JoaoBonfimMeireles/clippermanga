// Habilidades dos agentes (Leitor, Cortador, Montador, Diretor): arquivos .md em <studio>/_skills/<agente>/, globais para
// todas as obras. Os padrões (lib/skills-default.ts) são gravados na primeira vez; depois o que está no disco manda: você
// pode editar, apagar ou acrescentar. O gestor acrescenta habilidades novas (gestao-<id>.md) com addLearnedSkill.
//
// Ordem no prompt: primeiro as habilidades fixas (na ordem de skills-default.ts), depois as suas, por último as do gestor,
// da mais nova para a mais antiga. Antes a ordem era alfabética e o bloco era cortado em 6.000 caracteres: 11 regras
// "gestao-*" empurravam "tamanho-na-tela" e "trecho-largo-em-quadro-alto" para fora do prompt do Cortador.
// Poda: no máximo MAX_LEARNED habilidades do gestor por agente; ao aprovar outra, a mais antiga vai para
// <studio>/_skills/_arquivo/<agente>/ (nada é apagado: para reativar, mova o arquivo de volta).
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SKILLS, type Agent } from './skills-default';
import { studioDir } from './store';

export type { Agent } from './skills-default';
export const AGENTS: Agent[] = ['leitor', 'cortador', 'montador', 'diretor'];
/** Habilidades aprendidas (gestao-*) ativas por agente. */
export const MAX_LEARNED = 4;
const LEARNED = /^gestao-/;

const dirOf = (a: Agent) => path.join(studioDir(), '_skills', a);
const archiveDir = (a: Agent) => path.join(studioDir(), '_skills', '_arquivo', a);
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
    const order = new Map(DEFAULT_SKILLS[agent].map((s, i) => [s.id, i]));
    const rank = (id: string) => (order.has(id) ? 0 : LEARNED.test(id) ? 2 : 1);
    return fs
      .readdirSync(dirOf(agent))
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const full = path.join(dirOf(agent), f);
        const raw = fs.readFileSync(full, 'utf8').trim();
        const [first, ...rest] = raw.split('\n');
        const hasTitle = first.startsWith('#');
        return { id: f.replace(/\.md$/, ''), title: hasTitle ? first.replace(/^#+\s*/, '').trim() : f, body: (hasTitle ? rest : [first, ...rest]).join('\n').trim(), mtime: fs.statSync(full).mtimeMs };
      })
      .filter((s) => s.body)
      .sort((a, b) => rank(a.id) - rank(b.id) || (rank(a.id) === 0 ? order.get(a.id)! - order.get(b.id)! : rank(a.id) === 2 ? b.mtime - a.mtime : a.id.localeCompare(b.id)))
      .map(({ id, title, body }) => ({ id, title, body }));
  } catch {
    // sem disco (ou pasta inacessível): usa os padrões em memória
    return DEFAULT_SKILLS[agent];
  }
}

const HEAD: Record<Agent, string> = { leitor: 'HABILIDADES DO LEITOR', cortador: 'HABILIDADES DO CORTADOR', montador: 'HABILIDADES DO MONTADOR', diretor: 'HABILIDADES DO DIRETOR DE SHORTS' };

/**
 * Bloco para o prompt do agente. Nunca corta uma habilidade no meio: as que não cabem em `max` ficam de fora inteiras
 * (as fixas entram primeiro). Das aprendidas pelo gestor só entram as MAX_LEARNED mais novas, sem a linha "Por quê:"
 * (a justificativa é para você, na tela /gestao; para o agente é só token).
 */
export function skillsPrompt(agent: Agent, max = 6000): string {
  const list = readSkills(agent);
  if (!list.length) return '';
  const lines: string[] = [];
  let size = 0, learned = 0;
  for (const s of list) {
    const isLearned = LEARNED.test(s.id);
    if (isLearned && ++learned > MAX_LEARNED) continue;
    const body = isLearned ? s.body.replace(/\n?Por qu[êe]:[\s\S]*$/i, '').trim() : s.body;
    const line = `## ${s.title}\n${body}`;
    if (size + line.length > max) continue;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.length ? `\n\n${HEAD[agent]} (valem para todas as obras; siga sempre):\n${lines.join('\n')}\n` : '';
}

/** Tira uma habilidade do prompt sem apagar: o arquivo vai para _skills/_arquivo/<agente>/. */
export function archiveSkill(agent: Agent, id: string): boolean {
  const from = fileOf(agent, id);
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(archiveDir(agent), { recursive: true });
  fs.renameSync(from, path.join(archiveDir(agent), path.basename(from)));
  return true;
}

/** Títulos das habilidades arquivadas (para o gestor não propor de novo o que já saiu). */
export function archivedSkillTitles(agent: Agent): string[] {
  try {
    return fs
      .readdirSync(archiveDir(agent))
      .filter((f) => f.endsWith('.md'))
      .map((f) => fs.readFileSync(path.join(archiveDir(agent), f), 'utf8').split('\n')[0].replace(/^#+\s*/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** O gestor (ou você) acrescenta uma habilidade nova; mesmo id substitui a anterior. Passou do limite: a mais antiga é arquivada. */
export function addLearnedSkill(agent: Agent, id: string, title: string, body: string): void {
  fs.mkdirSync(dirOf(agent), { recursive: true });
  fs.writeFileSync(fileOf(agent, id), `# ${title}\n${body.trim()}\n`, 'utf8');
  try {
    const learned = fs
      .readdirSync(dirOf(agent))
      .filter((f) => LEARNED.test(f) && f.endsWith('.md'))
      .map((f) => ({ id: f.replace(/\.md$/, ''), mtime: fs.statSync(path.join(dirOf(agent), f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of learned.slice(MAX_LEARNED)) archiveSkill(agent, old.id);
  } catch {
    /* a poda nunca impede a aprovação */
  }
}
