// Diretor de Shorts: lê a história inteira em formato compacto (uma chamada de IA) e planeja os shorts.
// Cada short é de um destes formatos:
//  - cut:      só corte, com a voz original (trecho seguido OU imagens de pontos diferentes, em qualquer ordem);
//  - narrated: a IA escreve uma narração NOVA, que substitui a original; a voz é gerada com a voz do vídeo longo.
// A IA decide sozinha quantos precisam de narração nova (0 a 3 por lote de 5). Duração: 20 a 40 s, no máximo 45.
// O plano pode parar para aprovação (checkbox do painel) antes de gastar voz; ver generateShorts/approveShortsPlan em shorts.ts.
import { createHash, randomUUID } from 'node:crypto';
import { extractJson } from '@clipper/editing-planner';
import { createMangaLLM } from './llm';
import { loadCheckpoint, saveCheckpoint } from './checkpoint';
import { exemplosPrompt } from './exemplos';
import { skillsPrompt } from './skills';
import { estimateSpeechSeconds } from './voice';
import type { JobCtx } from './jobs';
import type { PlanItem, ShortPart, StudioProject } from './types';

export const MIN_S = 20;
export const TARGET_MAX_S = 40;
export const HARD_MAX_S = 45;
export const MAX_NARRATED_PER_5 = 3;

const SYSTEM = `Você é o Diretor de Shorts de um canal de YouTube que narra mangás/manhwas em português do Brasil.
Recebe a história inteira em formato compacto: uma parte (imagem + fala) por linha, "índice | segundos | impacto 1-10 | fala".
Planeje {N} shorts verticais, os melhores possíveis. Responda SÓ JSON:
{"shorts":[{"mode":"cut"|"narrated","parts":[{"from":a,"to":b} | {"i":n,"text":"narração nova desta imagem"}],"title":string,"summary":string,"description":string,"tags":string[],"why":string}]}
Regras:
- Duração de cada short: {MIN} a {TARGET} segundos; pode estourar até {HARD} no máximo, nunca mais. Some os segundos das partes (em "narrated", ~150 palavras por minuto). O app NÃO corta nem estica short: o que ficar fora de {MIN}-{HARD} s é descartado, então escolha o trecho já com o tamanho certo.
- Todo short termina numa frase completa e num ponto natural (impacto, virada ou suspense), nunca no meio de uma cena ou de uma fala.
- "cut": só corte, mantém a voz original. "parts" = intervalos {"from","to"} (índices inclusive) ou partes soltas {"i"}; podem vir de pontos diferentes do vídeo e em qualquer ordem, desde que a fala original continue fazendo sentido.
- "narrated": você escreve uma narração NOVA que substitui a voz original por inteiro. Cada item de "parts" é {"i": índice da imagem, "text": o trecho da narração dita enquanto essa imagem aparece}. Os textos, lidos em sequência, formam UMA narração contínua: gancho forte nos 2 primeiros segundos, começo-meio-fim, termina em suspense ou impacto. Português do Brasil falado, frases curtas, nomes certos dos personagens, sem sons escritos ("pow", "haha") e sem inventar o que não está na história.
- Use "narrated" SÓ quando o trecho não funciona sozinho (falta contexto, gancho no meio, precisa de resumo). Crie de 0 a {MAXNAR} narrados; se nenhum precisar, todos são "cut". Decida pelo que fica melhor.
- Shorts "cut" não podem usar as mesmas partes um do outro. Espalhe pela história.
- title: até 70 caracteres, termine com #shorts, MUITO chamativo, foque o gancho de interesse da obra (poder, dinheiro, harém, vingança, sobrevivência, monstros...), 1-2 palavras em MAIÚSCULAS, fiel à história.
- summary: 1 frase do que acontece (para o dono do canal). why: 1 frase com o motivo do formato escolhido.
- description: 2 a 3 frases curtas em pt-BR (gancho + convite para ver o vídeo completo no canal) e no fim 3 a 5 hashtags incluindo #shorts.
- tags: 10 a 15 tags curtas sem "#".`;

type RawPart = { from?: unknown; to?: unknown; i?: unknown; text?: unknown };
type RawShort = { mode?: unknown; parts?: RawPart[]; title?: unknown; summary?: unknown; description?: unknown; tags?: unknown; why?: unknown };

/** Duração de cada parte: a real do último render; partes novas usam a pedida. */
export function durationsOf(p: StudioProject): number[] {
  const segs = new Map((p.lastRender?.segments ?? []).map((g) => [g.id, g.dur]));
  return p.shots.map((s) => segs.get(s.id) ?? s.duration / (s.speed ?? 1));
}

/** Estimativa de uma parte: a fala original (duração real) ou a narração nova (~150 palavras/min + respiro). */
export const partSeconds = (dur: number, text?: string) => (text?.trim() ? estimateSpeechSeconds(text) + 0.25 : dur);

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const tagsOf = (t: unknown) => (Array.isArray(t) ? t : String(t ?? '').split(',')).map((x) => String(x).replace(/^#/, '').trim()).filter(Boolean);

/** Resposta da IA → itens do plano, já com os ids das partes, limites de duração e sem sobreposição. */
export function normalizePlan(p: StudioProject, raw: RawShort[], log: (m: string) => void): { items: PlanItem[]; rejected: string[] } {
  const dur = durationsOf(p);
  const n = p.shots.length;
  const items: PlanItem[] = [];
  const rejected: string[] = [];
  const reject = (title: string, why: string) => {
    log(`"${title}": ${why}, descartado`);
    rejected.push(`"${title}": ${why}`);
  };
  const usedByCut = new Set<number>();
  for (const r of raw) {
    const narrated = r.mode === 'narrated';
    // expande intervalos e partes soltas em [índice, texto?]
    let parts: { i: number; text?: string }[] = [];
    for (const x of r.parts ?? []) {
      if (x.from != null && x.to != null) {
        const a = Math.max(0, Math.min(n - 1, Math.floor(Number(x.from)))), b = Math.max(a, Math.min(n - 1, Math.floor(Number(x.to))));
        if (Number.isFinite(a) && Number.isFinite(b)) for (let i = a; i <= b; i++) parts.push({ i });
      } else if (Number.isFinite(Number(x.i)) && Number(x.i) >= 0 && Number(x.i) < n) parts.push({ i: Math.floor(Number(x.i)), text: clip(x.text, 600) || undefined });
    }
    const title = clip(r.title, 100) || 'Momento épico #shorts';
    if (narrated) {
      parts = parts.filter((x) => x.text);
      if (!parts.length) {
        reject(title, 'narração nova sem texto');
        continue;
      }
    } else parts = parts.map((x) => ({ i: x.i })); // corte: voz original, texto da IA não vale
    const seen = new Set<number>();
    parts = parts.filter((x) => !seen.has(x.i) && seen.add(x.i)); // a mesma imagem não repete dentro do short
    if (!narrated && parts.some((x) => usedByCut.has(x.i))) {
      reject(title, 'usa partes de outro corte');
      continue;
    }
    const secs = (list: typeof parts) => list.reduce((a, x) => a + partSeconds(dur[x.i], x.text), 0);
    // nunca corta um short para caber (ficaria com final seco): fora de 20-45 s, descarta e a IA planeja outro
    const total = secs(parts);
    if (total < MIN_S - 1 || total > HARD_MAX_S) {
      reject(title, `${Math.round(total)} s fica fora de ${MIN_S}-${HARD_MAX_S} s`);
      continue;
    }
    // a narração nova termina numa frase completa
    if (narrated && !/[.!?…]["')»]*$/.test(parts[parts.length - 1].text!.trim())) {
      reject(title, 'a narração nova termina sem fechar a frase');
      continue;
    }
    if (!narrated) parts.forEach((x) => usedByCut.add(x.i));
    items.push({
      id: randomUUID().slice(0, 8),
      mode: narrated ? 'narrated' : 'cut',
      title,
      summary: clip(r.summary, 300),
      description: clip(r.description, 800),
      tags: tagsOf(r.tags),
      why: clip(r.why, 300),
      parts: parts.map((x): ShortPart => ({ shot: p.shots[x.i].id, ...(narrated ? { text: x.text } : {}) })),
    });
  }
  // no máximo 3 narrados (voz é o recurso caro); os que passam do limite são descartados, não viram corte
  let nar = 0;
  const kept = items.filter((it) => {
    if (it.mode !== 'narrated') return true;
    if (++nar <= MAX_NARRATED_PER_5) return true;
    reject(it.title, `passou do limite de ${MAX_NARRATED_PER_5} narrações novas`);
    return false;
  });
  return { items: kept, rejected };
}

/** Shorts COMPLETOS de uma resposta cortada no meio: cada objeto dentro de "shorts":[ ... ] que fechou e é JSON válido. */
export function partialShorts(text: string): RawShort[] {
  const at = text.search(/"shorts"\s*:\s*\[/);
  if (at < 0) return [];
  const body = text.slice(text.indexOf('[', at) + 1);
  const out: RawShort[] = [];
  let depth = 0;
  let inStr = false;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth++ === 0) start = i;
    } else if (ch === '}' && --depth === 0 && start >= 0) {
      try {
        out.push(JSON.parse(body.slice(start, i + 1)) as RawShort);
      } catch {
        /* objeto inválido: pula */
      }
      start = -1;
    }
  }
  return out;
}

const MAX_ATTEMPTS = 3;

/**
 * A IA lê a história e planeja os shorts. Short fora de 20-45 s ou com final sem fecho NUNCA é cortado para caber:
 * é descartado e a IA planeja outro, com outro trecho ou outra estratégia (até {MAX_ATTEMPTS} chamadas no total).
 * O resultado fica em cache enquanto a história, os exemplos e as habilidades não mudam.
 */
export async function planShorts(p: StudioProject, ctx: JobCtx, signal: AbortSignal, count: number): Promise<PlanItem[]> {
  const dur = durationsOf(p);
  const total = dur.reduce((a, b) => a + b, 0);
  const n = Math.max(1, Math.min(count, Math.floor(total / MIN_S)));
  const lines = p.shots.map((s, i) => `${i} | ${dur[i].toFixed(1)} | ${s.impact ?? 5} | ${s.text.replace(/\s+/g, ' ').trim().slice(0, 120) || '(sem fala)'}`);
  const system = SYSTEM.replace('{N}', String(n)).replace('{MIN}', String(MIN_S)).replace('{TARGET}', String(TARGET_MAX_S)).replace('{HARD}', String(HARD_MAX_S)).replace('{MAXNAR}', String(MAX_NARRATED_PER_5)) + skillsPrompt('diretor');
  const examples = exemplosPrompt();
  const timeline = lines.join('\n');
  const base = `${examples}Obra: ${p.series || p.title}\n\nLinha do tempo:\n${timeline}`;
  const version = createHash('sha1').update(`v3|${n}|${system}|${examples}|${timeline}`).digest('hex').slice(0, 12);
  const saved = loadCheckpoint<RawShort[]>(p.id, 'shorts', version);
  let rawAll = saved.get('plan');
  const cached = !!rawAll;
  if (cached) ctx.log('Usando o plano de shorts já feito antes (nenhuma chamada de IA)');
  rawAll ??= [];
  let res = normalizePlan(p, rawAll, ctx.log);
  const llm = cached ? null : createMangaLLM({ paidGate: ctx.paid });
  if (llm) llm.onNotice = ctx.log;
  for (let attempt = 1; llm && attempt <= MAX_ATTEMPTS && res.items.length < n; attempt++) {
    const need = n - res.items.length;
    ctx.progress(0.02 * attempt, attempt === 1 ? `Planejando ${n} short(s)` : `Refazendo ${need} short(s) recusado(s) (tentativa ${attempt}/${MAX_ATTEMPTS})`);
    const nar = res.items.filter((i) => i.mode === 'narrated').length;
    const redo =
      attempt === 1
        ? ''
        : [
            '',
            `JÁ APROVADOS (${res.items.length}); partes usadas por cortes: ${res.items.filter((i) => i.mode === 'cut').flatMap((i) => i.parts.map((x) => p.shots.findIndex((s) => s.id === x.shot))).sort((a, b) => a - b).join(',') || 'nenhuma'}; narrações novas já criadas: ${nar} de no máximo ${MAX_NARRATED_PER_5}.`,
            'RECUSADOS (nunca corte um short para caber; faça OUTRO, com outro trecho ou outra estratégia):',
            ...res.rejected.slice(-8),
            `Crie ${need} short(s) NOVO(S), com começo, meio e fim, dentro de ${MIN_S}-${TARGET_MAX_S} s (até ${HARD_MAX_S}). Se o trecho bom é longo demais, escolha um recorte menor que se resolva sozinho ou use narração nova resumindo.`,
          ].join('\n');
    // JSON cortado no limite de tokens (o modelo gasta parte raciocinando): aproveita os shorts que vieram inteiros ou,
    // sem nenhum, tenta de novo com o dobro de espaço
    let more: RawShort[] = [];
    for (let t = 1; t <= 2; t++) {
      const out = await llm.complete({ system: system.replace(`Planeje ${n} shorts`, `Planeje ${attempt === 1 ? n : need} shorts`), prompt: base + redo, maxTokens: 8000 * t, temperature: 0.6 + attempt * 0.05, tier: 'small', signal } /* Haiku cria; o Opus revisa o texto (lib/review.ts) */);
      try {
        more = ((extractJson(out) as { shorts?: RawShort[] }).shorts ?? []).slice(0, need + 2);
        break;
      } catch (e) {
        const part = partialShorts(out);
        if (part.length) {
          ctx.log(`Plano de shorts veio cortado: aproveitei ${part.length} short(s) que vieram inteiros`);
          more = part.slice(0, need + 2);
          break;
        }
        if (t === 2 || signal.aborted) throw e;
        ctx.log('Plano de shorts veio cortado ou inválido; tentando de novo com mais espaço');
      }
    }
    if (!more.length && attempt === 1) throw new Error('A IA não devolveu nenhum short; rode de novo');
    rawAll = [...rawAll, ...more];
    res = normalizePlan(p, rawAll, ctx.log);
  }
  if (!cached) saveCheckpoint(p.id, 'shorts', version, 'plan', rawAll);
  const items = res.items.slice(0, n);
  if (!items.length) throw new Error(`Nenhum short planejado ficou dentro de ${MIN_S}-${HARD_MAX_S} s e com final fechado; rode de novo`);
  if (items.length < n) ctx.log(`Só ${items.length} de ${n} short(s) ficaram bons depois de ${MAX_ATTEMPTS} tentativas: melhor menos shorts do que um cortado sem nexo`);
  const nar = items.filter((i) => i.mode === 'narrated').length;
  ctx.log(`Plano: ${items.length} short(s), ${nar ? `${nar} com narração nova` : 'todos só corte (sem gastar voz)'}`);
  return items;
}
