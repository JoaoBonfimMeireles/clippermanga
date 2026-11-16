// Etapa 3 · Polir com IA: o usuário descreve o ajuste em texto ("tira a palavra cara", "estica mais a parte 12",
// "deixa as partes de conversa mais curtas") e a IA transforma isso em mudanças na linha do tempo. Depois o vídeo
// é renderizado de novo — a narração já está em cache, então não gasta voz.
import { extractJson } from '@clipper/editing-planner';
import { STRETCH_RANGE, ZOOM_RANGE } from './camera';
import { jobLLM } from './ai-meter';
import { learningPrompt } from './learning';
import { renderProject } from './render';
import { readProject, updateProject } from './store';
import type { JobCtx } from './jobs';
import type { Motion, Shot } from './types';

const SYSTEM = `Você ajusta a edição de um vídeo de resumo de mangá já pronto. Recebe o pedido do usuário e a lista de partes
(número, duração, tipo, impacto, ajustes e texto narrado). Transforme o pedido em mudanças.
Responda SOMENTE JSON:
{"cutWords":["palavras a cortar do áudio, só se o usuário pedir para tirar palavras"],
 "edits":[{"part":12,"stretch":1.3,"zoom":1.2,"fit":"contain","motion":"zoom-in","duration":3,"text":"novo texto narrado","sameImage":true,"remove":false}],
 "note":"o que você fez, em uma frase"}
Regras: "part" é o número da parte (começa em 1). Inclua em cada edit só os campos que mudam.
stretch de 1 a 2, zoom de 0.5 a 2, fit "contain" (laterais desfocadas) ou "cover" (tela cheia), motion "zoom-in" | "zoom-out" | "pan" | "static".
"text" reescreve a fala da parte (só quando o pedido é sobre texto, narração ou introdução); mantenha a ligação com as partes vizinhas.
Se vier um TRECHO A EDITAR, mude só as partes dele; as de antes e depois são contexto para a história ficar coerente.
"sameImage": true repete exatamente a imagem (página e recorte) da parte anterior: use quando a fala continua a mesma cena/assunto.
Não invente mudanças que o usuário não pediu. Sem mudanças: "edits": [].`;

const MOTIONS: Motion[] = ['zoom-in', 'zoom-out', 'pan', 'static'];
const clamp = (v: unknown, [a, b]: readonly [number, number]) => Math.min(b, Math.max(a, Number(v)));

export async function polishProject(projectId: string, prompt: string, ctx: JobCtx, signal: AbortSignal, range?: { from?: number; to?: number }): Promise<string> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  if (!prompt.trim()) throw new Error('Escreva o que a IA deve ajustar');
  const llm = jobLLM(ctx);
  ctx.progress(0.02, 'Entendendo o pedido');
  // trecho escolhido (números das partes, 1 = primeira); sem trecho = vídeo todo
  const from = Math.max(1, Math.floor(range?.from ?? 1));
  const to = Math.min(p.shots.length, Math.floor(range?.to ?? p.shots.length));
  const whole = from === 1 && to === p.shots.length;
  const line = (s: Shot, i: number) => `${i + 1}. ${s.duration}s ${s.kind ?? ''} imp ${s.impact ?? '-'} ${s.fit ?? 'contain'} esticar ${s.stretch ?? 1} zoom ${s.zoom ?? 1}: ${s.text}`;
  const ctxLine = (s: Shot, i: number) => `${i + 1}. ${s.text.slice(0, 160)}`;
  const b0 = Math.max(0, from - 1 - 25);
  const list = whole
    ? p.shots.map((s, i) => line(s, i).slice(0, 220)).join('\n')
    : [
        from > 1 ? `ANTES DO TRECHO (só contexto, não mude):\n${p.shots.slice(b0, from - 1).map((s, k) => ctxLine(s, b0 + k)).join('\n')}` : '',
        `TRECHO A EDITAR (partes ${from} a ${to}):\n${p.shots.slice(from - 1, to).map((s, k) => line(s, from - 1 + k)).join('\n')}`,
        to < p.shots.length ? `DEPOIS DO TRECHO (só contexto, não mude):\n${p.shots.slice(to, to + 40).map((s, k) => ctxLine(s, to + k)).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
  if (!whole) ctx.log(`Polindo só as partes ${from}–${to}`);
  const about = p.context ? `Sobre a obra: ${p.context.slice(0, 1500)}\n\n` : '';
  const raw = await llm.complete({ system: SYSTEM, prompt: `${learningPrompt()}Pedido: ${prompt}\n\n${about}Partes:\n${list}`.slice(0, 90000), maxTokens: 6000, temperature: 0.2, tier: 'small', signal });
  const out = extractJson(raw) as { cutWords?: string[]; edits?: { part?: number; text?: string; stretch?: number; zoom?: number; fit?: string; motion?: string; duration?: number; remove?: boolean; sameImage?: boolean }[]; note?: string };
  const words = (out.cutWords ?? []).map((w) => String(w).trim()).filter(Boolean);
  let changed = 0;
  updateProject(projectId, (cur) => {
    if (words.length) cur.cutWords = [...new Set([...(cur.cutWords ?? []), ...words.map((w) => w.toLowerCase())])];
    const drop = new Set<string>();
    for (const e of out.edits ?? []) {
      // "part" é a posição (1..n) na lista: acesso direto, sem varrer as partes duas vezes
      const n = Number(e.part) || 0;
      const s: Shot | undefined = cur.shots[n - 1];
      if (!s) continue;
      if (n < from || n > to) continue; // fora do trecho escolhido: não mexe
      if (typeof e.text === 'string' && e.text.trim() && e.text.trim() !== s.text.trim()) {
        s.text = e.text.trim();
        s.audioCuts = undefined; // fala nova: os cortes antigos não valem mais
      }
      if (e.remove) drop.add(s.id);
      const prevShot = cur.shots[n - 2];
      if (e.sameImage && prevShot && !s.newImage) {
        s.pageId = prevShot.pageId;
        s.focus = { ...prevShot.focus };
        s.rotate = prevShot.rotate;
      }
      if (e.stretch !== undefined) s.stretch = Math.round(clamp(e.stretch, STRETCH_RANGE) * 100) / 100;
      if (e.zoom !== undefined) s.zoom = Math.round(clamp(e.zoom, ZOOM_RANGE) * 100) / 100;
      if (e.fit === 'contain' || e.fit === 'cover') s.fit = e.fit;
      const m = MOTIONS.find((x) => x === e.motion);
      if (m) s.motion = m;
      if (e.duration !== undefined) s.duration = Math.round(clamp(e.duration, [0.5, 30]) * 10) / 10;
      changed++;
    }
    cur.shots = cur.shots.filter((s) => !drop.has(s.id));
  });
  ctx.log(`IA: ${out.note ?? 'ajustes aplicados'}${words.length ? ` · cortar do áudio: ${words.join(', ')}` : ''}${changed ? ` · ${changed} parte(s) mudada(s)` : ''}`);
  ctx.log(llm.report());
  const sub: JobCtx = { log: ctx.log, progress: (x, m) => ctx.progress(0.05 + x * 0.95, m) };
  return renderProject(projectId, sub, signal);
}
