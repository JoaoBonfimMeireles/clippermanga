// Corrige width/height das páginas dos projetos para o tamanho REAL do arquivo (a emenda antiga gravava 1-4 px a mais e o recorte
// "crop=900:1596" estourava). Uso: node ../videos/node_modules/tsx/dist/cli.mjs scripts/fix-dims.ts [idDoProjeto ...]  (sem id = todos)
import path from 'node:path';
import { probe } from '@clipper/video-processing';
import { listProjects, projectDir, readProject, writeProject } from '../lib/store';
import { mapPool } from '../lib/pool';

const ids = process.argv.slice(2).length ? process.argv.slice(2) : listProjects().map((p) => p.id);
for (const id of ids) {
  const p = readProject(id);
  if (!p) continue;
  let fixed = 0;
  await mapPool(p.pages, 8, async (pg) => {
    const real = await probe(path.join(projectDir(id), pg.file)).catch(() => null);
    if (real && real.width && real.height && (real.width !== pg.width || real.height !== pg.height)) {
      pg.width = real.width;
      pg.height = real.height;
      fixed++;
    }
  });
  if (fixed) writeProject(p);
  console.log(`${id.slice(0, 8)} ${p.title.slice(0, 40)}: ${fixed} de ${p.pages.length} páginas corrigidas`);
}
