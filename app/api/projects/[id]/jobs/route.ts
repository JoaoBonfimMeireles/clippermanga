// Inicia jobs do projeto: importar (link ou arquivos), gerar roteiro, renderizar. GET lista os jobs do projeto.
import { autoEdit } from '@/lib/autoedit';
import { importFromFiles, importFromUrl } from '@/lib/importer';
import { answerPaid, cancelJob, projectJobs, resumeJob, startJob } from '@/lib/jobs';
import { candidates, learnTemplate } from '@/lib/patterns';
import { renderProject } from '@/lib/render';
import { learnFromEdits } from '@/lib/learning';
import { finishTest, healTest, learnCutProfile, parkChapters, replaceOldCopies, snapshotBaseline, startTest } from '@/lib/cut-profiles';
import { auditProject, noteEditDone, recordSnapshot } from '@/lib/manager';
import { reviewStage } from '@/lib/stage-review';
import { renderEnglish, translateOnly } from '@/lib/english';
import { approveShortsPlan, generateShorts, renderOneShort } from '@/lib/shorts';
import { polishProject } from '@/lib/polish';
import { condenseScript } from '@/lib/condense';
import { checkShots } from '@/lib/shot-check';
import { enforceProject } from '@/lib/crop-enforce';
import { restyleProject } from '@/lib/restyle';
import { lockRendered } from '@/lib/lock';
import { needsPanelCrops } from '@/lib/crop-guard';
import { jobLLM } from '@/lib/ai-meter';
import { updateSeriesMemory } from '@/lib/series';
import { generateChapterContexts, generateScript } from '@/lib/script';
import { generateHooks, joinParts } from '@/lib/parts';
import { expandChapters, fillVar, hasVar, parseRange } from '@/lib/ranges';
import { peekProject, projectDir, readProject, updateProject } from '@/lib/store';
import { FULL } from '@/lib/types';
import { addPagesToTimeline } from '@/lib/timeline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  return Response.json(projectJobs((await params).id));
}

export async function POST(req: Request, { params }: Ctx) {
  const id = (await params).id;
  const p = peekProject(id);
  if (!p) return new Response('Projeto não encontrado', { status: 404 });
  // conserta um teste que estacionou os próprios capítulos (reimportação com o teste ativo)
  if (p.test && p.parked?.some((x) => p.test!.chapters.includes(x.chapter))) updateProject(id, (cur) => { healTest(cur); });
  const chapterName = (s: string | null | undefined) => s?.trim() || `Capítulo ${new Set(p.pages.map((x) => x.chapter)).size + 1}`;

  if (req.headers.get('content-type')?.includes('multipart/form-data')) {
    const form = await req.formData();
    const files = await Promise.all(form.getAll('files').filter((f): f is File => f instanceof File).map(async (f) => ({ name: f.name, data: Buffer.from(await f.arrayBuffer()) })));
    if (!files.length) return new Response('Nenhum arquivo', { status: 400 });
    const ch = chapterName(form.get('chapter') as string | null);
    const intro = form.get('intro') === '1';
    let at = Math.max(0, Math.floor(Number(form.get('at')) || 0)); // posição na linha do tempo (0 = começo)
    const replaceShot = (form.get('replace') as string | null) || ''; // id da parte que troca de imagem
    return Response.json(
      startJob('import', id, async (ctx) => {
        const before = new Set(readProject(id)?.pages.map((x) => x.id));
        if (!replaceShot && !intro) updateProject(id, lockRendered); // capítulo novo: o que já foi renderizado fica protegido
        const n = await importFromFiles(id, files, ch, ctx);
        // imagem inserida/trocada numa parte pronta continua protegida
        if (replaceShot || intro) updateProject(id, (cur) => { if (cur.lockedPages?.length) cur.lockedPages.push(...cur.pages.filter((x) => !before.has(x.id)).map((x) => x.id)); });
        if (replaceShot) {
          // troca a imagem da parte: mantém fala, duração e cortes; recorte volta para a imagem inteira
          let ok = false;
          updateProject(id, (cur) => {
            const added = cur.pages.find((x) => !before.has(x.id));
            const s = cur.shots.find((x) => x.id === replaceShot);
            if (!added || !s) return;
            Object.assign(s, { pageId: added.id, focus: FULL, fit: 'contain' as const, rotate: undefined, stretch: undefined, zoom: undefined, newImage: true });
            ok = true;
          });
          if (!ok) throw new Error('Não achei a parte para trocar a imagem (ela foi apagada?)');
          return 'Imagem da parte trocada';
        }
        if (intro) {
          // imagem inicial: entra no começo da linha do tempo, inteira, com laterais desfocadas
          updateProject(id, (cur) => {
            const added = cur.pages.filter((x) => !before.has(x.id));
          at = Math.min(cur.shots.length, at);
          cur.shots.splice(at, 0, ...added.map((pg) => ({ id: randomUUID().slice(0, 8), pageId: pg.id, duration: 3, focus: FULL, fit: 'contain' as const, motion: 'zoom-in' as const, text: '' })));
          });
          return at ? `Imagem inserida na posição ${at + 1}` : 'Imagem inicial adicionada no começo da linha do tempo';
        }
        return `${n} páginas importadas`;
      }),
    );
  }

  const body = (await req.json()) as { kind: 'import' | 'resume'; job?: string; skip?: boolean } & { kind: 'import' | 'script' | 'edit' | 'render' | 'english' | 'context' | 'polish' | 'shorts'; count?: number; pauseForNarration?: boolean; approvePlan?: boolean; plan?: import('@/lib/types').PlanItem[]; textOnly?: boolean; shortId?: string; skip?: string[]; cuts?: [number, number][]; frames?: Record<string, { x0: number; y0: number; x1: number; y1: number }>; prompt?: string; from?: number; to?: number; cacheOnly?: boolean; url?: string; html?: string; chapter?: string; chapters?: string; pages?: string; testCount?: number; skipLearning?: boolean };
  if (body.kind === 'import') {
    let list, pageSel: number[];
    try {
      const existing = new Set([...p.pages.map((x) => x.chapter), ...(p.parked ?? []).map((x) => x.chapter)]).size;
      list = expandChapters(body.url ?? '', body.chapters ?? '', body.chapter ?? '', (i) => `Capítulo ${existing + i + 1}`);
      pageSel = parseRange(body.pages ?? '');
    } catch (e) {
      return new Response((e as Error).message, { status: 400 });
    }
    if (!list.length) return new Response('Link inválido', { status: 400 });
    // HTML colado: um bloco por capítulo, na mesma ordem, separados por uma linha com ---
    const htmls = body.html?.trim() ? body.html.split(/^\s*-{3,}\s*$/m).map((h) => h.trim() || undefined) : [];
    if (htmls.length > 1 && htmls.length !== list.length) return new Response(`Colou ${htmls.length} HTMLs para ${list.length} capítulos: precisa ser um por capítulo (separados por ---)`, { status: 400 });
    // modelo (com {n}) de cada capítulo, para aprender com as correções
    const lines = (body.url ?? '').split(/\r?\n/).map((l) => l.trim()).filter(hasVar);
    const templateOf = (c: { url: string; n: number | null }) => (c.n === null ? null : (lines.find((l) => fillVar(l, c.n!) === c.url) ?? null));
    return Response.json(
      startJob('import', id, async (ctx) => {
        let total = 0;
        let done = 0;
        const skipped: string[] = [];
        const okChapters: string[] = [];
        const lockBefore = readProject(id)?.lockedPages;
        const before = new Set((readProject(id)?.pages ?? []).map((pg) => pg.id));
        updateProject(id, lockRendered); // o que já foi renderizado fica protegido; só os capítulos novos serão trabalhados
        // por modelo original: os modelos aprendidos com as correções do usuário, na ordem
        const learned = new Map<string, string[]>();
        for (const [i, c] of list.entries()) {
          const sub = { ...ctx, progress: (x: number, m?: string) => ctx.progress((i + x) / list.length, list.length > 1 ? `[${i + 1}/${list.length}] ${c.chapter}: ${m ?? ''}` : m) };
          const tpl = templateOf(c);
          const tries = candidates(tpl ? [tpl, ...(learned.get(tpl) ?? [])] : [], c.n, c.url);
          const html = htmls.length === 1 && list.length === 1 ? htmls[0] : htmls[i];
          let ok = false;
          let lastErr = '';
          for (const [k, u] of tries.entries()) {
            if (ctx.signal?.aborted) throw new Error('Cancelado');
            try {
              if (k > 0) ctx.log(`${c.chapter}: tentando o padrão corrigido ${k} (${u})`);
              total += await importFromUrl(id, u, c.chapter, k === 0 ? html : undefined, sub, pageSel, c.n);
              ok = true;
              break;
            } catch (e) {
              lastErr = (e as Error).message;
              ctx.log(`${c.chapter} (${u}): ${lastErr}`);
            }
          }
          // todas as formas falharam: pausa e pede o link certo (ou o HTML) na tela
          while (!ok) {
            if (!ctx.pause) throw new Error(lastErr);
            const a = await ctx.pause({ chapter: c.chapter, url: tries[0], error: lastErr, tried: tries });
            if (a.skip) {
              skipped.push(c.chapter);
              break;
            }
            const u = a.url?.trim() || tries[0];
            try {
              total += await importFromUrl(id, u, c.chapter, a.html?.trim() || undefined, sub, pageSel, c.n);
              ok = true;
              if (tpl && a.url?.trim() && c.n !== null) {
                const t = learnTemplate(tpl, u, c.n);
                const all = learned.get(tpl) ?? [];
                if (t && t !== tpl && !all.includes(t)) {
                  learned.set(tpl, [...all, t]);
                  ctx.log(`Padrão aprendido: ${t} (agora ${all.length + 2} formas por capítulo)`);
                }
              }
            } catch (e) {
              lastErr = (e as Error).message;
              ctx.log(`${c.chapter} (${u}): ${lastErr}`);
            }
          }
          if (ok) {
            done++;
            okChapters.push(c.chapter);
          }
        }
        // TRAVA: capítulo já baixado antes (nas páginas ou esperando o teste) é substituído pela cópia nova: nunca fica duplicado
        if (total && okChapters.length) {
          let oldDirs: string[] = [];
          updateProject(id, (cur) => { oldDirs = replaceOldCopies(cur, okChapters, new Set(cur.pages.filter((pg) => !before.has(pg.id)).map((pg) => pg.id))); });
          for (const d of oldDirs) fs.rmSync(path.join(projectDir(id), 'pages', d), { recursive: true, force: true });
          if (oldDirs.length) ctx.log(`Cópia antiga de ${oldDirs.length} pasta(s) de capítulo(s) já baixado(s) apagada: ficou só a nova`);
        }
        if (total && body.url?.trim()) updateProject(id, (cur) => { cur.lastImportUrl = body.url!.trim(); });
        if (!total) updateProject(id, (cur) => { cur.lockedPages = lockBefore; });
        // modo teste: com um teste em andamento os capítulos novos esperam; senão, o lote começa um teste (1-2 capítulos) e o resto espera
        const testCount = Math.max(0, Math.min(2, Math.floor(Number(body.testCount) || 0)));
        if (total && okChapters.length && (testCount > 0 || readProject(id)?.test)) {
          updateProject(id, (cur) => {
            if (cur.test) {
              // os capítulos do próprio teste nunca são estacionados
              const mine = new Set(cur.test.chapters);
              const fresh = new Set(okChapters.filter((c) => !mine.has(c)));
              parkChapters(cur, [...fresh]);
              healTest(cur);
            } else startTest(cur, okChapters, testCount);
          });
          const t = readProject(id);
          ctx.log(`🧪 Modo teste: ${t?.test?.chapters.join(', ')} passam pelo fluxo; ${t?.parked?.length ?? 0} capítulo(s) baixado(s) esperam o "Teste finalizado"`);
        }
        if (!total) throw new Error(`Nenhum capítulo baixado${skipped.length ? ` (pulados: ${skipped.join(', ')})` : ''}.`);
        return `${total} páginas importadas${list.length > 1 ? ` de ${done}/${list.length} capítulos` : ''}${skipped.length ? ` — pulados: ${skipped.join(', ')}` : ''}`;
      }),
    );
  }
  // resposta da tela: "OmniRoute fora: usar o Claude?"
  if ((body as { kind: string }).kind === 'paid') {
    const b = body as unknown as { job?: string; yes?: boolean };
    return answerPaid(String(b.job ?? ''), !!b.yes) ? Response.json({ ok: true }) : new Response('Job não está esperando resposta', { status: 404 });
  }
  if (body.kind === 'resume') {
    const okResume = resumeJob(body.job ?? '', { url: body.url, html: body.html, skip: !!body.skip });
    return okResume ? new Response(null, { status: 204 }) : new Response('Esse job não está esperando resposta', { status: 409 });
  }
  // trava: etapas que regravam cortes/roteiro/dúvidas nunca rodam juntas (nem durante um render) no mesmo projeto
  {
    const MUTATING = ['edit', 'script', 'check', 'restyle', 'enforce', 'condense', 'polish', 'context', 'audit', 'finalizeTest'];
    const k = (body as { kind: string }).kind;
    if (MUTATING.includes(k)) {
      const busy = projectJobs(id).find((j) => j.status === 'running' && (MUTATING.includes(j.kind) || j.kind === 'render'));
      if (busy) return new Response(`Já tem um processo rodando neste projeto (${busy.kind}): espere terminar ou cancele antes de começar outro.`, { status: 409 });
    }
  }
  // recomeçar do zero: apaga roteiro, partes, resumos e dúvidas; fica só a leitura das imagens (page-notes) e as páginas
  if ((body as { kind: string }).kind === 'resetWork') {
    if (projectJobs(id).some((j) => j.status === 'running')) return new Response('Tem processo rodando: espere terminar.', { status: 409 });
    updateProject(id, (cur) => {
      cur.shots = [];
      addPagesToTimeline(cur, cur.pages);
      cur.pageScript = undefined;
      cur.chapterContexts = undefined;
      cur.doubts = [];
      cur.lockedPages = undefined;
      cur.test = undefined;
      cur.parked = undefined;
      cur.autoPaid = true;
    });
    return Response.json({ ok: true, shots: readProject(id)?.shots.length ?? 0 });
  }
  if (body.kind === 'edit')
    return Response.json(
      startJob('edit', id, async (ctx, signal) => {
        const r = await autoEdit(id, ctx);
        noteEditDone(id); // as correções feitas daqui em diante contam para este lote no placar
        await reviewStage(id, 'leitura', ctx).then((m) => ctx.log(m)).catch((e) => ctx.log(`Revisão final do gestor falhou: ${(e as Error).message.slice(0, 160)}`));
        // a auditoria do gestor roda uma vez só por lote, no fim da validação (passo 3, obrigatório antes do render):
        // aqui o placar era sempre 100 (você ainda não tinha corrigido nada) e gastava uma chamada de Opus com imagem
        snapshotBaseline(id); // modo teste: guarda o que a IA propôs, para comparar com o que o dono ajustar
        return r;
      }),
    );
  // "Teste finalizado": o gestor aprende com o que o dono ajustou nos capítulos do teste e libera o resto do lote
  if ((body as { kind: string }).kind === 'finalizeTest') {
    if (!p.test) return new Response('Este projeto não está em modo teste', { status: 409 });
    const skip = !!body.skipLearning;
    if (!skip && !p.pages.some((pg) => p.test!.chapters.includes(pg.chapter))) return new Response('Os capítulos do teste não estão no projeto. Clique em "Baixar" de novo (ou em qualquer passo) para recuperá-los.', { status: 409 });
    const inTest = new Set(p.pages.filter((pg) => p.test!.chapters.includes(pg.chapter)).map((pg) => pg.id));
    if (!skip && !p.shots.some((s) => inTest.has(s.pageId) && s.text.trim())) return new Response('Rode os passos 1 a 3 nos capítulos do teste e ajuste os cortes antes de finalizar (ou finalize sem aprender).', { status: 409 });
    return Response.json(
      startJob('test', id, async (ctx, signal) => {
        const learned = skip ? 'sem aprendizado' : await learnCutProfile(id, ctx, signal);
        const r = finishTest(id);
        return `Teste finalizado (${learned})${r.released ? ` · ${r.released} capítulo(s) liberado(s) para o fluxo normal` : ''}`;
      }),
    );
  }
  if ((body as { kind: string }).kind === 'audit') return Response.json(startJob('audit', id, (ctx, signal) => auditProject(id, ctx, signal)));
  if (body.kind === 'context') return Response.json(startJob('context', id, async (ctx) => `Contexto de ${await generateChapterContexts(id, ctx, { force: true })} capítulo(s) pronto`));
  // memória da série: só texto, sem reler páginas (grava a etapa deste projeto na bíblia da série)
  if ((body as { kind: string }).kind === 'memory')
    return Response.json(
      startJob('context' as const, id, async (ctx) => {
        const p = readProject(id);
        if (!p) throw new Error('Projeto não encontrado');
        await updateSeriesMemory(p, jobLLM(ctx), ctx.log);
        return 'Memória da série atualizada';
      }),
    );
  // piso de tamanho dos recortes (40% da tela) aplicado a um projeto já editado
  if ((body as { kind: string }).kind === 'enforce') return Response.json(startJob('restyle', id, (ctx) => enforceProject(id, ctx)));
  if ((body as { kind: string }).kind === 'check') {
    if (projectJobs(id).some((j) => (j.kind === 'render' || j.kind === 'polish') && j.status === 'running')) return new Response('Render rodando neste projeto: espere terminar antes de validar.', { status: 409 });
    return Response.json(
      startJob('check', id, async (ctx, signal) => {
        const r = await checkShots(id, ctx, { from: body.from, to: body.to });
        // o gestor audita o resultado já validado (1 chamada); nunca derruba a validação
        await auditProject(id, ctx, signal, 'check').then((m) => ctx.log(m)).catch((e) => ctx.log(`Auditoria do gestor falhou: ${(e as Error).message.slice(0, 160)}`));
        snapshotBaseline(id);
        return r;
      }),
    );
  }
  if ((body as { kind: string }).kind === 'restyle') {
    if (projectJobs(id).some((j) => (j.kind === 'render' || j.kind === 'polish' || j.kind === 'restyle') && j.status === 'running')) return new Response('Já tem um render ou ajuste rodando neste projeto: espere terminar.', { status: 409 });
    const b = body as unknown as { tidyTo?: number; from?: number; to?: number };
    return Response.json(startJob('restyle', id, async (ctx) => { const r = await restyleProject(id, ctx, { tidyTo: b.tidyTo, from: b.from, to: b.to }); snapshotBaseline(id); return r; }));
  }
  if ((body as { kind: string }).kind === 'hooks') {
    if (projectJobs(id).some((j) => (j.kind === 'render' || j.kind === 'script' || j.kind === 'hooks') && j.status === 'running')) return new Response('Já tem um processo rodando neste projeto: espere terminar.', { status: 409 });
    return Response.json(startJob('hooks', id, (ctx) => generateHooks(id, ctx)));
  }
  if ((body as { kind: string }).kind === 'join') {
    if (projectJobs(id).some((j) => (j.kind === 'render' || j.kind === 'join') && j.status === 'running')) return new Response('Já tem um render ou junção rodando neste projeto: espere terminar.', { status: 409 });
    const ids = (body as { ids?: unknown }).ids;
    const chosen = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : undefined;
    return Response.json(startJob('join', id, (ctx, signal) => joinParts(id, ctx, signal, { ids: chosen })));
  }
  if ((body as { kind: string }).kind === 'condense') return Response.json(startJob('script' as const, id, (ctx) => condenseScript(id, ctx)));
  if (body.kind === 'script')
    return Response.json(
      startJob('script', id, async (ctx) => {
        // ordem: 1 roteiro (escrito a partir da leitura das páginas, sem teto de duração) → 2 editar → 3 validar → 4 render
        const r = await generateScript(id, ctx);
        await reviewStage(id, 'roteiro', ctx).then((m) => ctx.log(m)).catch((e) => ctx.log(`Revisão final do gestor falhou: ${(e as Error).message.slice(0, 160)}`));
        return r;
      }),
    );
  if (body.kind === 'polish') return Response.json(startJob('polish', id, (ctx, signal) => polishProject(id, body.prompt ?? '', ctx, signal, { from: body.from, to: body.to })));
  if (body.kind === 'shorts') {
    if (projectJobs(id).some((j) => (j.kind === 'render' || j.kind === 'shorts') && j.status === 'running'))
      return new Response('Já tem um render ou shorts rodando neste projeto: espere terminar (ou cancele).', { status: 409 });
    if (body.approvePlan) return Response.json(startJob('shorts', id, (ctx, signal) => approveShortsPlan(id, Array.isArray(body.plan) ? body.plan : undefined, ctx, signal)));
    if (body.shortId) return Response.json(startJob('shorts', id, (ctx, signal) => renderOneShort(id, body.shortId!, Number(body.from), Number(body.to), ctx, signal, Array.isArray(body.skip) ? body.skip.map(String) : [], Array.isArray(body.cuts) ? body.cuts : [], body.frames && typeof body.frames === 'object' ? body.frames : {})));
    return Response.json(startJob('shorts', id, (ctx, signal) => generateShorts(id, ctx, signal, Math.min(10, Math.max(1, Number(body.count) || 5)), !!body.pauseForNarration)));
  }
  if (body.kind === 'english' && body.textOnly) return Response.json(startJob('english', id, (ctx, signal) => translateOnly(id, ctx, signal)));
  if (body.kind === 'english') {
    if (projectJobs(id).some((j) => (j.kind === 'render' || j.kind === 'english' || j.kind === 'polish') && j.status === 'running')) return new Response('Já tem um render rodando neste projeto: espere terminar (ou cancele) antes de gerar o inglês.', { status: 409 });
    return Response.json(startJob('english', id, (ctx, signal) => renderEnglish(id, ctx, signal)));
  }
  if ((body.kind === 'render' || body.kind === 'polish') && projectJobs(id).some((j) => (j.kind === 'render' || j.kind === 'polish') && j.status === 'running'))
    return new Response('Já tem um render rodando neste projeto: espere terminar (ou cancele) antes de começar outro.', { status: 409 });
  // REGRA: a validação (passo 3) é obrigatória antes de qualquer render, venha o pedido do automático, do modal de dúvidas ou do editor
  if (body.kind === 'render') {
    const done = (k: string) => Math.max(0, ...projectJobs(id).filter((j) => j.kind === k && j.status === 'done').map((j) => j.endedAt ?? 0));
    if (done('check') === 0 || done('check') < Math.max(done('edit'), done('script')))
      return new Response('Falta o passo 3 (Validar com IA): a validação é obrigatória antes de renderizar. Rode "3 · Validar (IA)" primeiro.', { status: 409 });
  }
  if (body.kind === 'render')
    return Response.json(
      startJob('render', id, async (ctx, signal) => {
        // rede de segurança: nenhum recorte abaixo do piso de tamanho entra no vídeo (zero exceções)
        await enforceProject(id, ctx).catch((e) => ctx.log(`Piso de tamanho falhou: ${(e as Error).message.slice(0, 160)}`));
        const r = await renderProject(id, ctx, signal, { cacheOnly: !!body.cacheOnly });
        // aprende com as correções feitas no editor (nunca derruba o render)
        // placar que vale: medido no render, quando você já corrigiu à mão o que quis (sem IA)
        recordSnapshot(id, 'render');
        await learnFromEdits(id, ctx, signal).catch((e) => ctx.log(`Aprendizado falhou: ${(e as Error).message.slice(0, 160)}`));
        return r;
      }),
    );
  return new Response('Tipo inválido', { status: 400 });
}

/** DELETE ?job=<id>: cancela um job em andamento. */
export async function DELETE(req: Request) {
  const job = new URL(req.url).searchParams.get('job') ?? '';
  return cancelJob(job) ? new Response(null, { status: 204 }) : new Response('Job não está rodando', { status: 404 });
}
