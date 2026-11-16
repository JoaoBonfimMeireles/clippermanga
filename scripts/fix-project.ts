// Reparo cirúrgico de um projeto já editado (sem refazer a edição inteira, mantendo o cache de voz do que não muda):
//  1) recorte que pega propaganda da scan (Support Us, Discord...) → corta fora a propaganda; se sobra nada, a parte
//     passa a mostrar a imagem da parte vizinha (a fala dela é mantida);
//  2) recorte alto demais (tira/página inteira) → vira troca rápida entre os principais quadros da página (leitura);
//  3) início de fala que repete o fim da anterior → tirado.
// Uso: CLIPPER_ROOT=../videos tsx scripts/fix-project.ts <projectId> [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { MANGA_SIZES } from '@clipper/shared';
import { cropPx, effSize } from '../lib/camera';
import { dedupeNarration, MAX_TALL_RATIO, pickBgBand, toShots, trimBorders, viewOf } from '../lib/autoedit';
import { readNotes } from '../lib/page-notes';
import { avoidAds, findPromo } from '../lib/promo';
import { projectDir, readProject, updateProject } from '../lib/store';
import type { Shot, StudioPage } from '../lib/types';

const id = process.argv[2];
const apply = process.argv.includes('--apply');
if (!id) throw new Error('informe o id do projeto');

(async () => {
  const p = readProject(id);
  if (!p) throw new Error('projeto não encontrado');
  const dir = projectDir(id);
  const { w, h } = MANGA_SIZES[p.format];
  const aspect = w / h;
  const notes = readNotes(id);
  const pageOf = new Map(p.pages.map((pg) => [pg.id, pg]));
  const adsOf = new Map<string, Awaited<ReturnType<typeof findPromo>>>();
  for (const pg of p.pages) adsOf.set(pg.id, await findPromo(path.join(dir, pg.file), pg));

  const shots: Shot[] = JSON.parse(JSON.stringify(p.shots));
  const report: string[] = [];
  const replaceWithNeighbor = new Set<number>();
  const tooTall = (pg: StudioPage, s: { focus: Shot["focus"]; rotate?: number }) => {
    const c = cropPx(s.focus, pg.width, pg.height);
    const ef = effSize({ w: c.w, h: c.h }, { rotate: s.rotate });
    return ef.h / ef.w > MAX_TALL_RATIO;
  };

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const pg = pageOf.get(s.pageId)!;
    const ads = adsOf.get(pg.id) ?? [];
    const img = path.join(dir, pg.file);

    // 2) alto demais → troca rápida entre os principais quadros da página
    if (tooTall(pg, s) && !avoidAds(s.focus, ads)?.y1) {
      /* cai no caso 1 abaixo */
    }
    if (tooTall(pg, s)) {
      const clipped = avoidAds(s.focus, ads);
      const panels = (notes[pg.id]?.panels ?? [])
        .filter((q) => q.impact >= 4 && avoidAds(q.box, ads))
        .sort((a, b) => b.impact - a.impact)
        .slice(0, Math.max(1, Math.min(6, Math.floor(s.duration / 1.2))))
        .sort((a, b) => a.box.y0 - b.box.y0);
      if (panels.length) {
        const raws = panels.map((q) => ({ box: [avoidAds(q.box, ads)!.x0, avoidAds(q.box, ads)!.y0, avoidAds(q.box, ads)!.x1, avoidAds(q.box, ads)!.y1], rotate: q.rotate, kind: q.kind, impact: q.impact, fit: 'contain', text: '' }));
        const views = toShots(pg, raws, true, aspect);
        for (const v of views) {
          v.focus = await trimBorders(img, pg, v.focus);
          v.bgBand = await pickBgBand(img, pg, v);
        }
        if (views.length) {
          Object.assign(s, { ...viewOf(views[0]), kind: views[0].kind }, { extra: views.slice(1).map(viewOf) });
          report.push(`parte ${i + 1} (pág ${p.pages.indexOf(pg) + 1}): tira alta → ${views.length} quadro(s) em troca rápida`);
          continue;
        }
      }
      if (clipped && !tooTall(pg, { focus: clipped, rotate: s.rotate })) s.focus = clipped;
      else replaceWithNeighbor.add(i), report.push(`parte ${i + 1} (pág ${p.pages.indexOf(pg) + 1}): tira alta sem quadro aproveitável → imagem da parte vizinha`);
      continue;
    }

    // 1) propaganda da scan
    if (ads.length) {
      const f = avoidAds(s.focus, ads);
      if (!f) {
        replaceWithNeighbor.add(i);
        report.push(`parte ${i + 1} (pág ${p.pages.indexOf(pg) + 1}): só propaganda da scan → imagem da parte vizinha`);
      } else if (f.y0 !== s.focus.y0 || f.y1 !== s.focus.y1) {
        s.focus = f;
        s.bgBand = await pickBgBand(img, pg, s);
        report.push(`parte ${i + 1} (pág ${p.pages.indexOf(pg) + 1}): propaganda cortada do recorte`);
      }
    }
    if (s.extra?.length) {
      s.extra = s.extra.filter((v) => {
        const vp = pageOf.get(v.pageId);
        const va = vp ? adsOf.get(vp.id) ?? [] : [];
        return !va.length || !!avoidAds(v.focus, va);
      });
    }
  }

  // partes sem imagem boa: usam a imagem da parte anterior (ou da próxima), mantendo a própria fala
  for (const i of [...replaceWithNeighbor].sort((a, b) => a - b)) {
    let j = i - 1;
    while (j >= 0 && replaceWithNeighbor.has(j)) j--;
    if (j < 0) {
      j = i + 1;
      while (j < shots.length && replaceWithNeighbor.has(j)) j++;
    }
    if (j < 0 || j >= shots.length) continue;
    const v = viewOf(shots[j]);
    Object.assign(shots[i], v, { extra: undefined });
  }

  // 3) fala que repete o fim da anterior
  const before = shots.map((s) => s.text);
  const rep = dedupeNarration(shots);
  shots.forEach((s, i) => {
    if (s.text !== before[i]) report.push(`parte ${i + 1}: fala repetida tirada → "${before[i].slice(0, 60)}…" → "${s.text.slice(0, 60)}…"`);
  });

  console.log(report.join('\n') || 'nada a corrigir');
  console.log(`\n${report.length} ajuste(s); ${rep} fala(s) repetida(s); ${shots.length} partes no total`);
  if (!apply) return console.log('(simulação: use --apply para gravar)');
  fs.copyFileSync(path.join(dir, 'project.json'), path.join(dir, `project.backup-${Date.now()}.json`));
  updateProject(id, (cur) => {
    cur.shots = shots;
  });
  console.log('gravado (backup do project.json salvo ao lado)');
})();
