// Relatório de qualidade dos recortes de um projeto. Só lê o project.json: não grava nada e não usa IA.
// Uso: node ../videos/node_modules/tsx/dist/cli.mjs scripts/crop-report.ts <pasta-do-projeto> [largura altura]
// Falta medir balão DENTRO do recorte: nas bordas o app já apara (medido: 0% no Mansion), então essa medida não diz nada.
import fs from 'node:fs';
import path from 'node:path';
import { cropMetrics, EXTREME_UPSCALE, isTight, QUALITY } from '../lib/crop-quality';
import type { StudioProject } from '../lib/types';

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith('--'));
const dir = pos[0];
if (!dir) throw new Error('Informe a pasta do projeto (projetos/<id>).');
const screen = { w: Number(pos[1]) || 1920, h: Number(pos[2]) || 1080 };
const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) as StudioProject;
const page = new Map(p.pages.map((x) => [x.id, x]));

const t = { n: 0, below40: 0, below30: 0, loose: 0, stretched: 0, tight: 0, extreme: 0, repeated: 0, area: [] as number[], up: [] as number[], tall: [] as number[] };
for (const [i, s] of p.shots.entries()) {
  const pg = page.get(s.pageId);
  if (!pg) continue;
  const m = cropMetrics(s.focus, pg, s, screen);
  t.n++;
  t.area.push(m.area);
  t.up.push(m.upscale);
  t.tall.push(m.tall);
  if (m.area < QUALITY.minArea) t.below40++;
  if (m.area < QUALITY.hardMinArea) t.below30++;
  if (!m.fillsHeight) t.loose++;
  if ((s.stretch ?? 1) > QUALITY.softStretch + 0.001) t.stretched++;
  if (isTight(m)) t.tight++;
  if (m.upscale > EXTREME_UPSCALE) t.extreme++;
  const prev = p.shots[i - 1];
  if (prev && prev.pageId === s.pageId && JSON.stringify(prev.focus) === JSON.stringify(s.focus)) t.repeated++;
}
const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
const pct = (a: number) => `${a} (${((a / Math.max(1, t.n)) * 100).toFixed(0)}%)`;

function main() {
  console.log(`${p.title}: ${t.n} recortes · tela ${screen.w}x${screen.h}\n`);
  console.log('REGRAS FIXAS (têm que ser zero):');
  console.log(`  abaixo de ${QUALITY.hardMinArea * 100}% da tela: ${pct(t.below30)}`);
  console.log(`  soltos no meio (não cobrem a altura): ${pct(t.loose)}`);
  console.log(`  esticados acima de ${QUALITY.softStretch}x: ${pct(t.stretched)}`);
  console.log('\nINDICADORES (quanto menor, melhor; comparar lote com lote):');
  console.log(`  abaixo da meta de ${QUALITY.minArea * 100}%: ${pct(t.below40)}`);
  console.log(`  apertados (mais largos que altos e ampliados mais de 2x: dava para abrir a cena): ${pct(t.tight)}`);
  console.log(`  fonte minúscula (ampliados mais de ${EXTREME_UPSCALE}x): ${pct(t.extreme)}`);
  console.log(`  mesma imagem da parte anterior: ${pct(t.repeated)}`);
  console.log(`  medianas: ocupação ${(med(t.area) * 100).toFixed(0)}% · ampliação ${med(t.up).toFixed(2)}x · altura/largura ${med(t.tall).toFixed(2)}`);
}
main();
