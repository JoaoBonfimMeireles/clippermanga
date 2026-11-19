// Emenda de novo as páginas de um projeto já importado (imagens fatiadas pelo site → tira única cortada só em faixa lisa),
// zera as partes/leituras antigas e guarda uma cópia do project.json. Uso: node ../videos/node_modules/tsx/dist/cli.mjs scripts/restitch.ts <idDoProjeto>
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectDir, readProject, writeProject } from '../lib/store';
import { stitchChapter } from '../lib/stitch';
import { addPagesToTimeline } from '../lib/timeline';
import type { StudioPage } from '../lib/types';

const id = process.argv[2];
const p = id ? readProject(id) : null;
if (!p) throw new Error('Projeto não encontrado');
const dir = projectDir(id);
fs.copyFileSync(path.join(dir, 'project.json'), path.join(dir, `project.antes-da-emenda.json`));
// grupos = páginas seguidas do mesmo capítulo e da mesma pasta (o que veio de uma importação)
const groups: StudioPage[][] = [];
for (const pg of p.pages) {
  const last = groups[groups.length - 1];
  if (last && last[0].chapter === pg.chapter && path.dirname(last[0].file) === path.dirname(pg.file)) last.push(pg);
  else groups.push([pg]);
}
const pages: StudioPage[] = [];
for (const g of groups) {
  const chId = randomUUID().slice(0, 8);
  const out = path.join(dir, 'pages', chId);
  const joined = await stitchChapter(g.map((x) => ({ file: path.join(dir, x.file), width: x.width, height: x.height })), out);
  console.log(`${g[0].chapter}: ${g.length} imagens → ${joined.length} páginas (${joined.map((j) => `${j.width}x${j.height}`).join(', ')})`);
  for (const j of joined) pages.push({ id: randomUUID().slice(0, 8), file: `pages/${chId}/${path.basename(j.file)}`, width: j.width, height: j.height, chapter: g[0].chapter });
}
p.pages = pages;
p.shots = [];
p.doubts = [];
p.pageScript = undefined;
addPagesToTimeline(p, pages);
writeProject(p);
for (const f of ['page-notes.json', 'page-hashes.json']) fs.rmSync(path.join(dir, f), { force: true });
console.log(`pronto: ${pages.length} páginas, ${p.shots.length} partes novas (sem recortes)`);
