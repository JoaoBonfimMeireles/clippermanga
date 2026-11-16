// Relatório de qualidade dos recortes de um projeto (antes e depois do conserto por geometria).
// Uso: node ../videos/node_modules/tsx/dist/cli.mjs scripts/crop-report.ts <pasta-do-projeto> [largura altura]
import fs from 'node:fs';
import path from 'node:path';
import { cropMetrics, fixShot, QUALITY } from '../lib/crop-quality';
import type { StudioProject } from '../lib/types';

const dir = process.argv[2];
if (!dir) throw new Error('Informe a pasta do projeto (projetos/<id>).');
const screen = { w: Number(process.argv[3]) || 1920, h: Number(process.argv[4]) || 1080 };
const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) as StudioProject;
const page = new Map(p.pages.map((x) => [x.id, x]));

const tally = { n: 0, small: 0, blurry: 0, bad: 0, area: [] as number[], hard: 0, loose: 0 };
const after = { n: 0, small: 0, blurry: 0, bad: 0, area: [] as number[], slices: 0, hard: 0, loose: 0 };
for (const s of p.shots) {
  const pg = page.get(s.pageId);
  if (!pg) continue;
  const m = cropMetrics(s.focus, pg, s, screen);
  tally.n++; tally.area.push(m.area);
  if (m.area < QUALITY.hardMinArea) tally.hard++;
  if (!m.fillsHeight) tally.loose++;
  if (m.problems.includes('small')) tally.small++;
  if (m.problems.includes('blurry')) tally.blurry++;
  if (m.problems.length) tally.bad++;
  const fix = fixShot(s, pg, screen);
  if (fix.shots.length > 1) after.slices += fix.shots.length - 1;
  for (const f of fix.shots) {
    const a = cropMetrics(f.focus, pg, { ...s, ...f }, screen);
    after.n++; after.area.push(a.area);
    if (a.area < QUALITY.hardMinArea) after.hard++;
    if (!a.fillsHeight) after.loose++;
    if (a.problems.includes('small')) after.small++;
    if (a.problems.includes('blurry')) after.blurry++;
    if (a.problems.length) after.bad++;
  }
}
const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const pct = (a: number, b: number) => `${a} (${((a / b) * 100).toFixed(0)}%)`;
console.log(`Limites: área >= ${QUALITY.minArea * 100}% da tela, ampliação <= ${QUALITY.maxUpscale}x, altura <= ${QUALITY.maxTall}x a largura. Tela ${screen.w}x${screen.h}`);
for (const [name, t] of [['ANTES', tally], ['DEPOIS (zoom corrigido + fatias)', after]] as const) {
  console.log(`\n${name}: ${t.n} recortes`);
  console.log(`  pequenos (<${QUALITY.minArea * 100}% da tela): ${pct(t.small, t.n)}`);
  console.log(`  ABAIXO DE ${QUALITY.hardMinArea * 100}% (tem que ser ZERO): ${pct(t.hard, t.n)}`);
  console.log(`  soltos no meio (não cobrem a altura da tela): ${pct(t.loose, t.n)}`);
  console.log(`  borrados (ampliação > ${QUALITY.maxUpscale}x): ${pct(t.blurry, t.n)}`);
  console.log(`  com algum problema: ${pct(t.bad, t.n)}   mediana de ocupação: ${(med(t.area) * 100).toFixed(0)}%`);
}
console.log(`\nFatias novas criadas: ${after.slices}`);
