// Encadeia os passos da parte 3 pela API local: espera cada job terminar e começa o próximo.
const ID = '8b0bdb11-7807-4f4c-ade2-6eb1d9aec0ea';
const B = `http://localhost:3100/api/projects/${ID}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(new Date().toLocaleTimeString('pt-BR'), m);
const jobs = async () => { for (let i=0;;i++) { try { return await (await fetch(`${B}/jobs`)).json(); } catch (e) { if (i>8) throw e; await sleep(15000); } } };
async function waitIdle() {
  for (;;) {
    const run = (await jobs()).filter((j) => j.status === 'running');
    if (!run.length) return;
    const j = run.at(-1);
    log(`${j.kind} ${Math.round(j.progress * 100)}% ${String(j.message).slice(0, 90)}`);
    await sleep(60000);
  }
}
async function step(kind, extra = {}) {
  await waitIdle();
  const r = await fetch(`${B}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...extra }) });
  if (!r.ok) throw new Error(`${kind}: ${r.status} ${await r.text()}`);
  const job = await r.json();
  log(`começou ${kind} (${job.id})`);
  await sleep(5000);
  await waitIdle();
  const done = (await jobs()).find((j) => j.id === job.id);
  log(`${kind}: ${done?.status} — ${String(done?.message).slice(0, 300)}`);
  if (done?.status !== 'done') throw new Error(`${kind} terminou com ${done?.status}`);
}
try {
  await waitIdle(); // importação em andamento
  const p = await (await fetch(B)).json();
  log(`importado: ${p.pages.length} páginas, capítulos ${[...new Set(p.pages.map((x) => x.chapter))].join(', ')}`);
  if (!p.pages.length) throw new Error('nada importado');
  for (const k of ['script', 'edit', 'check', 'render']) await step(k);
  log('FIM: render pronto');
} catch (e) {
  log(`PARADO: ${e.message}`);
}
