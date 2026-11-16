// Validação leve dos recortes (depois da edição e do roteiro): uma IA barata confere, olhando o recorte reduzido,
// se (1) o texto narrado bate com a imagem, (2) a imagem não é só balão/caixa de texto, (3) não corta cabeça/corpo/arma
// e (4) não ficou minúscula/espremida. Reprovadas: troca por outro quadro da mesma página ou das vizinhas (escolhido
// só por texto, pelas descrições das notas) ou aumenta o recorte para a cena inteira. Texto, duração e áudio ficam
// como estão (a voz não é gerada de novo). Depois, uma segunda olhada só nas partes trocadas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageFromFile } from '@clipper/ai-providers';
import { extractJson } from '@clipper/editing-planner';
import { runFfmpeg } from '@clipper/video-processing';
import { jobLLM } from './ai-meter';
import { cleanRect, cropPx, rotateFilter } from './camera';
import { readNotes } from './page-notes';
import { lockedSet } from './lock';
import { enforceProject } from './crop-enforce';
import { concurrency, pool } from './pool';
import { projectDir, readProject, updateProject } from './store';
import type { JobCtx } from './jobs';
import type { Rect, Shot, StudioPage, StudioProject } from './types';

const BATCH = 6;
const SYSTEM = `Você confere os recortes de um vídeo de resumo de mangá/webtoon. Recebe imagens numeradas (cada uma é o recorte mostrado na tela) e, para cada uma, a frase narrada enquanto ela aparece.
Para cada imagem diga se ela serve:
- "balloon": é só balão/caixa de texto/onomatopeia, sem desenho de personagem, cenário ou ação (um balão sobre o desenho de quem fala é ok);
- "mismatch": o desenho não tem a ver com a frase (mostra outra coisa, outro momento ou outra pessoa);
- "cut": corta ao meio a cabeça, o corpo ou a arma do personagem principal da cena, ou é um pedacinho de uma cena maior;
- "small": a parte útil é minúscula ou uma faixa fina/espremida, difícil de ver;
- "ok": serve (não seja rigoroso: frase de transição ou imagem do mesmo momento da história é ok).
Responda SOMENTE JSON compacto: {"r":[{"i":1,"v":"ok"},{"i":2,"v":"balloon"}]}`;

const PICK_SYSTEM = `Você escolhe a imagem certa para uma frase narrada de um vídeo de mangá. Recebe frases numeradas, cada uma com uma lista numerada de quadros (descrições). Responda SOMENTE JSON {"r":[{"i":1,"pick":3}]} com o número do quadro que melhor ilustra a frase (prefira quadros com personagem/cena/ação em vez de conversa), ou "pick":0 se nenhum serve. "i" é o número da frase.`;

type Verdict = 'ok' | 'balloon' | 'mismatch' | 'cut' | 'small';


/** Recorte reduzido (lado maior 512, preto e branco) como imagem para a IA. */
async function cropImage(p: StudioProject, s: Shot, page: StudioPage, dir: string) {
  const c = cropPx(s.focus, page.width, page.height);
  const sc = Math.min(1, 512 / Math.max(c.w, c.h));
  const f = path.join(dir, `${s.id}.jpg`);
  const w2 = Math.max(16, Math.round((c.w * sc) / 2) * 2);
  await runFfmpeg(['-y', '-i', path.join(projectDir(p.id), page.file), '-vf', `crop=${c.w}:${c.h}:${c.x}:${c.y}${rotateFilter({ rotate: s.rotate })},scale=${w2}:-2,format=gray`, '-q:v', '6', '-frames:v', '1', f]);
  return imageFromFile(f);
}

const grow = (r: Rect, k: number): Rect => {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  return cleanRect({ x0: r.x0 - w * k, x1: r.x1 + w * k, y0: r.y0 - h * k, y1: r.y1 + h * k });
};

export async function checkShots(projectId: string, ctx: JobCtx, range?: { from?: number; to?: number }): Promise<string> {
  const p0 = readProject(projectId);
  if (!p0) throw new Error('Projeto não encontrado');
  const llm = jobLLM(ctx);
  const notes = readNotes(projectId);
  const locked = lockedSet(p0); // capítulos prontos não são validados de novo
  const pageOf = new Map(p0.pages.map((pg) => [pg.id, pg]));
  const order = p0.pages.map((pg) => pg.id);
  const from = Math.max(1, Math.floor(range?.from ?? 1));
  const to = Math.min(p0.shots.length, Math.floor(range?.to ?? p0.shots.length));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-check-'));
  const verdicts = new Map<string, Verdict>();

  const judge = async (ids: string[], rev: boolean) => {
    // os lotes são independentes (a validação só lê o projeto e anota o veredito): vários ao mesmo tempo
    const starts = Array.from({ length: Math.ceil(ids.length / BATCH) }, (_, k) => k * BATCH);
    const cur = readProject(projectId)!;
    let done = 0;
    await pool(starts, concurrency('MANGA_CHECK_CONCURRENCY', 4), async (b) => {
      const group = ids.slice(b, b + BATCH).map((id) => cur.shots.find((s) => s.id === id)).filter((s): s is Shot => !!s);
      const imgs = [];
      for (const s of group) imgs.push(await cropImage(cur, s, pageOf.get(s.pageId)!, dir));
      try {
        const raw = await llm.complete({
          system: SYSTEM,
          prompt: group.map((s, k) => `Imagem ${k + 1} — frase: "${(s.text || '(continua a frase anterior)').slice(0, 220)}"`).join('\n'),
          images: imgs,
          tier: 'small',
          maxTokens: 500,
          temperature: 0.1,
          signal: ctx.signal,
        });
        const out = extractJson(raw) as { r?: { i?: number; v?: string }[] };
        for (const r of out.r ?? []) {
          const s = group[(Number(r.i) || 0) - 1];
          const v = (['balloon', 'mismatch', 'cut', 'small'] as const).find((x) => x === r.v);
          if (s) verdicts.set(s.id, v ?? 'ok');
        }
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`Validação de ${group.length} parte(s) falhou (${(e as Error).message.slice(0, 120)}); mantidas`);
      }
      done += group.length;
      ctx.progress((rev ? 0.85 : 0) + (done / Math.max(1, ids.length)) * (rev ? 0.1 : 0.6), `${rev ? 'Revalidando' : 'Validando'}: ${done} de ${ids.length} partes`);
    }, ctx.signal);
  };

  // 0) sem esticar/aproximar (corta a cena); partes com imagem trocada à mão (newImage) ficam como estão
  let reset = 0;
  const ids: string[] = [];
  updateProject(projectId, (cur) => {
    for (const [i, s] of cur.shots.entries()) {
      if (i + 1 < from || i + 1 > to || s.newImage || !pageOf.has(s.pageId) || locked.has(s.pageId)) continue;
      if ((s.fit ?? 'contain') === 'contain' && ((s.zoom ?? 1) > 1 || (s.stretch ?? 1) > 1)) {
        s.zoom = 1;
        s.stretch = 1;
        reset++;
      }
      ids.push(s.id);
    }
  });
  ctx.log(`Partes a validar: ${ids.length}${reset ? ` · ${reset} sem aproximar/esticar (cortava a cena)` : ''}`);

  await judge(ids, false);
  const bad = ids.filter((id) => (verdicts.get(id) ?? 'ok') !== 'ok');
  const count = (v: string) => bad.filter((id) => verdicts.get(id) === v).length;
  ctx.log(`Reprovadas pela IA: ${bad.length} de ${ids.length} (balão ${count('balloon')}, não bate ${count('mismatch')}, cortada ${count('cut')}, pequena ${count('small')})`);

  // 1) substituto escolhido só por texto: quadros da mesma página e das vizinhas
  const cur1 = readProject(projectId)!;
  const candOf = (s: Shot) => {
    const i = order.indexOf(s.pageId);
    const out: { pageId: string; box: Rect; what: string; rotate: number; kind: Shot['kind'] }[] = [];
    for (const pid of [order[i], order[i - 1], order[i + 1]].filter((x) => x && pageOf.get(x)?.chapter === pageOf.get(s.pageId)?.chapter)) for (const q of notes[pid]?.panels ?? []) if (q.what) out.push({ pageId: pid, box: q.box, what: q.what, rotate: q.rotate, kind: q.kind });
    return out.slice(0, 30);
  };
  const picks = new Map<string, Partial<Shot>>();
  const toPick = bad.filter((id) => verdicts.get(id) === 'balloon' || verdicts.get(id) === 'mismatch');
  for (let b = 0; b < toPick.length; b += BATCH) {
    const group = toPick.slice(b, b + BATCH).map((id) => cur1.shots.find((s) => s.id === id)).filter((s): s is Shot => !!s);
    const cands = group.map((s) => candOf(s));
    const prompt = group.map((s, k) => `Frase ${k + 1}: "${(s.text || '').slice(0, 220)}"\nQuadros:\n${cands[k].map((c, j) => `  ${j + 1}. ${c.what} [${c.kind}]`).join('\n') || '  (nenhum)'}`).join('\n\n');
    try {
      const raw = await llm.complete({ system: PICK_SYSTEM, prompt, tier: 'small', maxTokens: 400, temperature: 0.1, signal: ctx.signal });
      for (const r of (extractJson(raw) as { r?: { i?: number; pick?: number }[] }).r ?? []) {
        const k = (Number(r.i) || 0) - 1;
        const c = cands[k]?.[(Number(r.pick) || 0) - 1];
        if (c) picks.set(group[k].id, { pageId: c.pageId, focus: c.box, fit: 'contain', rotate: c.rotate || undefined, stretch: 1, zoom: 1 });
      }
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.log(`Escolha de substitutos falhou (${(e as Error).message.slice(0, 120)})`);
    }
  }
  const originals = new Map<string, Partial<Shot>>();
  const changed = new Set<string>();
  let swapped = 0, grown = 0;
  updateProject(projectId, (cur) => {
    for (const s of cur.shots) {
      const v = verdicts.get(s.id);
      if (!v || v === 'ok') continue;
      const patch = picks.get(s.id);
      const before = { pageId: s.pageId, focus: s.focus, fit: s.fit, rotate: s.rotate, stretch: s.stretch, zoom: s.zoom };
      if (patch) {
        Object.assign(s, patch);
        swapped++;
      } else if (v === 'cut' || v === 'small') {
        s.focus = grow(s.focus, 0.15);
        s.fit = 'contain';
        s.stretch = 1;
        s.zoom = 1;
        grown++;
      } else continue;
      originals.set(s.id, before);
      changed.add(s.id);
    }
  });
  ctx.log(`Trocadas por outro quadro: ${swapped} · recorte ampliado para a cena inteira: ${grown}`);


  // 2) segunda olhada só nas trocadas/ampliadas; se ainda reprovar, volta ao que era
  verdicts.clear();
  await judge([...changed], true);
  let reverted = 0;
  updateProject(projectId, (cur) => {
    for (const s of cur.shots) {
      if (!changed.has(s.id) || (verdicts.get(s.id) ?? 'ok') === 'ok') continue;
      const o = originals.get(s.id);
      if (o) {
        Object.assign(s, o);
        reverted++;
      }
    }
  });
  ctx.log(`Revalidação: ${changed.size - reverted} aprovadas, ${reverted} voltaram ao original`);
  ctx.log(llm.report());
  fs.rmSync(dir, { recursive: true, force: true });
  // a validação amplia para "a cena inteira" e reverte: depois dela vale o piso de 40% da tela
  await enforceProject(projectId, ctx).catch((e) => ctx.log(`Piso de tamanho falhou: ${(e as Error).message.slice(0, 160)}`));
  // a validação mexeu nos cortes: a 1ª opção de cada dúvida passa a ser o corte validado, senão o modal acha que foi o usuário que ajustou
  updateProject(projectId, (cur) => {
    const byId = new Map(cur.shots.map((s) => [s.id, s]));
    for (const d of cur.doubts ?? []) {
      const s = byId.get(d.shotId);
      if (s && d.options[0]) d.options[0] = { ...d.options[0], pageId: s.pageId, focus: s.focus };
    }
  });
  return `Validação: ${ids.length} partes · ${bad.length} reprovadas · ${swapped} trocadas · ${grown} ampliadas · ${reverted} revertidas`;
}
