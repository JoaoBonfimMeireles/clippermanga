// Testes locais sem IA e sem tocar em projetos/. Uso: node ../videos/node_modules/tsx/dist/cli.mjs scripts/selftest.ts
import assert from 'node:assert/strict';
import { baseOf, mergeShots, shotsDelta } from '../lib/shots-merge';
import type { Shot } from '../lib/types';

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

console.log(`\n${n} testes passaram`);
