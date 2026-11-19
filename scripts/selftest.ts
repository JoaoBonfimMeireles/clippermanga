// Testes locais sem IA e sem tocar em projetos/. Uso: node ../videos/node_modules/tsx/dist/cli.mjs scripts/selftest.ts
import assert from 'node:assert/strict';
import { baseOf, mergeShots, shotsDelta } from '../lib/shots-merge';
import { syncHookShots, isHook } from '../lib/part-hooks';
import type { Shot, StudioProject } from '../lib/types';

const shot = (id: string, y0 = 0, extra: Partial<Shot> = {}): Shot => ({ id, pageId: 'p1', duration: 3, focus: { x0: 0, y0, x1: 1, y1: y0 + 0.1 }, motion: 'zoom-in', text: `fala ${id}`, ...extra });
let n = 0;
const test = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok  ${name}`);
};

test('tela sem mudança não desfaz o que o job fez', () => {
  const loaded = [shot('a'), shot('b'), shot('c')];
  const base = baseOf(loaded);
  // o job (validação/piso) mexeu em b depois que a tela carregou
  const server = [shot('a'), shot('b', 0.5, { stretch: 1.25, pageId: 'p2' }), shot('c')];
  const delta = shotsDelta(base, loaded)!;
  assert.deepEqual(delta, { changedIds: [], removedIds: [] });
  assert.deepEqual(mergeShots(server, loaded, delta), server);
});

test('só a parte que a tela mudou é gravada', () => {
  const loaded = [shot('a'), shot('b'), shot('c')];
  const base = baseOf(loaded);
  const server = [shot('a', 0.3), shot('b', 0.5, { stretch: 1.25 }), shot('c')];
  const client = [loaded[0], loaded[1], { ...loaded[2], text: 'texto novo' }];
  const out = mergeShots(server, client, shotsDelta(base, client)!);
  assert.equal(out[0].focus.y0, 0.3); // do job
  assert.equal(out[1].stretch, 1.25); // do job
  assert.equal(out[2].text, 'texto novo'); // da tela
});

test('parte criada, apagada e movida pela tela', () => {
  const loaded = [shot('a'), shot('b'), shot('c')];
  const base = baseOf(loaded);
  const client = [loaded[2], loaded[0], shot('novo')]; // apagou b, moveu c para o começo, criou "novo"
  const delta = shotsDelta(base, client)!;
  assert.deepEqual(delta.removedIds, ['b']);
  assert.deepEqual(delta.changedIds, ['novo']);
  assert.deepEqual(mergeShots(loaded, client, delta).map((s) => s.id), ['c', 'a', 'novo']);
});

test('parte que o job apagou continua apagada; parte que o job criou fica no lugar', () => {
  const loaded = [shot('a'), shot('b'), shot('c')];
  const base = baseOf(loaded);
  const server = [shot('a'), shot('x'), shot('c')]; // job trocou b por x
  const client = [loaded[0], loaded[1], { ...loaded[2], duration: 5 }];
  const out = mergeShots(server, client, shotsDelta(base, client)!);
  assert.deepEqual(out.map((s) => s.id), ['a', 'x', 'c']);
  assert.equal(out[2].duration, 5);
});

test('tela antiga (sem retrato) continua salvando tudo', () => {
  assert.equal(shotsDelta(null, [shot('a')]), undefined);
});

const proj = (shots: Shot[], part?: StudioProject['part']) => ({ shots, part }) as StudioProject;

test('partes: gancho de abertura na frente e de fechamento no fim, com a imagem da primeira/última parte', () => {
  const p = proj([shot('a', 0.1), shot('b'), shot('c', 0.7)], { number: 3, intro: 'Esta é a parte 3.', outro: 'Na parte 4...' });
  assert.equal(syncHookShots(p), true);
  assert.deepEqual(p.shots.map((s) => s.id), ['hook-intro', 'a', 'b', 'c', 'hook-outro']);
  assert.equal(p.shots[0].focus.y0, 0.1);
  assert.equal(p.shots[4].focus.y0, 0.7);
  assert.equal(syncHookShots(p), false); // já em dia: nada muda
});

test('partes: texto do gancho editado na linha do tempo vale e volta para a parte', () => {
  const p = proj([shot('a'), shot('b')], { number: 2, intro: 'velho' });
  syncHookShots(p);
  p.shots[0].text = 'novo texto editado';
  syncHookShots(p);
  assert.equal(p.part!.intro, 'novo texto editado');
  assert.equal(p.shots.filter(isHook).length, 1); // sem fechamento escrito: não cria
});

test('partes: sem número os ganchos saem; sem gancho escrito nada é criado', () => {
  const p = proj([shot('a'), shot('b')], { number: 2, intro: 'x', outro: 'y' });
  syncHookShots(p);
  p.part = undefined;
  syncHookShots(p);
  assert.deepEqual(p.shots.map((s) => s.id), ['a', 'b']);
  const q = proj([shot('a')], { number: 1 });
  assert.equal(syncHookShots(q), false);
});

console.log(`\n${n} testes passaram`);
