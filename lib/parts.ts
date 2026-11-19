// PARTES de uma série: cada projeto pode ser "a parte N" de uma obra (ex.: parte 3 = capítulos 16-22).
//  - Gancho de ABERTURA: "esta é a parte N", um resumo curto do que houve nas partes anteriores (para quem não viu) e o aviso de que o link está na descrição.
//  - Gancho de FECHAMENTO: deixa no ar o que vem na parte N+1.
//  Os ganchos são partes da linha do tempo marcadas com `hook` (ids fixos): editáveis como qualquer fala, refeitos por "Gerar ganchos" e
//  tirados no "Juntar partes", que emenda os vídeos prontos de todas as partes num só, sem abertura e sem fechamento.
import { mkdirRetry } from './safe-mkdir';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LLMProvider } from '@clipper/ai-providers';
import { extractJson } from '@clipper/editing-planner';
import { runFfmpeg } from '@clipper/video-processing';
import { getAppSettings, dataPaths } from '@clipper/shared/server';
import { jobLLM } from './ai-meter';
import type { JobCtx } from './jobs';
import { audioDuration } from './media';
import { synthesizeSpeech } from './voice';
import { NARRATOR_STYLE } from './narrator';
import { readSeries, seriesKey, seriesPrompt } from './series';
import { listProjects, projectDir, readProject, updateProject } from './store';
import { cleanSpeechText } from './speech-text';
import { chaptersInOrder } from './timeline';
import { HOOK_INTRO_ID, HOOK_OUTRO_ID, isHook, partNumber, syncHookShots } from './part-hooks';
import type { StudioProject } from './types';

export { HOOK_INTRO_ID, HOOK_OUTRO_ID, isHook, partNumber, syncHookShots };

/** Aplica `syncHookShots` no projeto gravado (usado antes do roteiro, do render e da junção). */
export function syncProjectHooks(projectId: string): void {
  const p = readProject(projectId);
  if (!p?.part && !p?.shots.some(isHook)) return;
  updateProject(projectId, (cur) => void syncHookShots(cur));
}

/** Outros projetos da mesma série que são partes (ordenados pelo número). */
export function seriesParts(p: StudioProject): StudioProject[] {
  const key = seriesKey(p);
  return listProjects()
    .filter((o) => partNumber(o) && seriesKey(o) === key)
    .sort((a, b) => partNumber(a) - partNumber(b));
}

const SYSTEM_HOOKS = `Você escreve os dois GANCHOS de uma PARTE de um vídeo narrado de mangá, narrados em primeira pessoa pelo protagonista, em português do Brasil. A série é publicada em partes (parte 1, parte 2, parte 3...), cada uma com vários capítulos.
Recebe: o número da parte, a memória do que as partes anteriores contaram, o resumo dos capítulos DESTA parte e as últimas frases narradas.
Escreva:
- "intro": a ABERTURA, bem curta (30 a 60 palavras). Diga que esta é a parte N da história (com palavras suas). Se N > 1: em 2 ou 3 frases, conte o que aconteceu até aqui (só o essencial das partes anteriores, sem spoilers do que vem nesta parte) e avise que quem ainda não viu as partes anteriores encontra o link na descrição. Termine puxando para o primeiro acontecimento desta parte, sem contar o que acontece nele. Se N = 1: apresente a história e o protagonista de forma simples e empolgante, sem falar de partes anteriores nem de link.
- "outro": o FECHAMENTO, curto (30 a 50 palavras). Deixe um gancho forte: a tensão no ar no final desta parte, uma pergunta, o que está em jogo, e anuncie que a história continua na parte N+1, convidando a não perder. Use SÓ o que está nos resumos e nas últimas frases (nada inventado nem adiantado além do gancho que as páginas já deixam). Sem soar robótico nem clichê.
Ambos são falas contínuas (sem listas, sem emojis, sem marcações) e seguem o jeito de narrar abaixo.
${NARRATOR_STYLE}
Responda SOMENTE JSON: {"intro":"...","outro":"..."}`;

/** Escreve (ou refaz) os dois ganchos da parte com a IA e coloca na linha do tempo. */
export async function generateHooks(projectId: string, ctx: JobCtx, opts: { llm?: LLMProvider; only?: 'intro' | 'outro' } = {}): Promise<string> {
  let p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  const n = partNumber(p);
  if (!n) throw new Error('Defina o número da parte (campo "Parte") antes de gerar os ganchos');
  if (!p.shots.some((s) => !isHook(s))) throw new Error('Gere o roteiro antes: os ganchos usam a primeira e a última imagem da parte');
  const llm = opts.llm ?? jobLLM(ctx);
  const chapters = chaptersInOrder(p.pages);
  const mine = chapters.map((c) => `${c}: ${p!.chapterContexts?.[c] ?? ''}`).join('\n');
  const body = p.shots.filter((s) => !isHook(s) && s.text.trim());
  const last = body.slice(-4).map((s) => s.text).join(' ').slice(-700);
  const first = body.slice(0, 3).map((s) => s.text).join(' ').slice(0, 500);
  // o que as partes anteriores contaram: memória da série + resumos dos capítulos das partes de número menor
  const before = seriesParts(p).filter((o) => partNumber(o) < n && o.id !== p!.id);
  const prevChapters = before.flatMap((o) => Object.entries(o.chapterContexts ?? {}).map(([c, t]) => `${c}: ${t}`)).join('\n').slice(-3500);
  const memory = seriesPrompt(p, 6000) || (readSeries(p)?.bible ?? '').slice(0, 4000);
  const raw = await llm.complete({
    system: SYSTEM_HOOKS,
    prompt: `Parte: ${n}\n${p.context ? `Obra: ${p.context.slice(0, 1500)}\n` : ''}${memory ? `${memory}\n` : ''}${prevChapters ? `Resumo dos capítulos das partes anteriores:\n${prevChapters}\n` : ''}Capítulos DESTA parte:\n${mine}\nComeço da narração desta parte: "${first}"\nÚltimas frases narradas desta parte: "${last}"`,
    maxTokens: 1200,
    temperature: 0.7,
    signal: ctx.signal,
  });
  const out = extractJson(raw) as { intro?: string; outro?: string };
  const intro = cleanSpeechText(String(out.intro ?? '')).trim();
  const outro = cleanSpeechText(String(out.outro ?? '')).trim();
  if (!intro && !outro) throw new Error('A IA não devolveu os ganchos; rode de novo');
  updateProject(projectId, (cur) => {
    const part = (cur.part ??= { number: n });
    for (const [kind, text] of [['intro', intro], ['outro', outro]] as const) {
      if (!text || (opts.only && opts.only !== kind)) continue;
      part[kind] = text;
      // a fala antiga sai da linha do tempo: o texto novo manda (sync recria a parte)
      cur.shots = cur.shots.filter((s) => s.hook !== kind);
    }
    syncHookShots(cur);
  });
  p = readProject(projectId)!;
  ctx.log(`Gancho de abertura: "${p.part?.intro ?? ''}"`);
  ctx.log(`Gancho de fechamento: "${p.part?.outro ?? ''}"`);
  if ('report' in llm) ctx.log((llm as ReturnType<typeof jobLLM>).report());
  return `Ganchos da parte ${n} prontos (abertura e fechamento). A voz deles é gerada no próximo render.`;
}

// ---------- juntar as partes ----------

const FPS = 30;

/** Janela [início, fim] (s) de um vídeo de parte SEM os ganchos, pelos segmentos do último render. */
function storyWindow(p: StudioProject): { start: number; end: number } | null {
  const r = p.lastRender;
  if (!r?.file || !fs.existsSync(r.file)) return null;
  const segs = r.segments ?? [];
  if (!segs.length) return { start: 0, end: r.duration };
  const hookIds = new Set(p.shots.filter(isHook).map((s) => s.id));
  const intro = segs.find((s) => s.id === HOOK_INTRO_ID || p.shots.find((x) => x.id === s.id)?.hook === 'intro');
  const outro = segs.find((s) => s.id === HOOK_OUTRO_ID || p.shots.find((x) => x.id === s.id)?.hook === 'outro');
  const story = segs.filter((s) => !hookIds.has(s.id) && s !== intro && s !== outro);
  if (!story.length) return null;
  const start = story[0].start;
  const end = story[story.length - 1].start + story[story.length - 1].dur;
  return { start, end };
}

const SYSTEM_JOIN = `Você escreve a ABERTURA e o FECHAMENTO de um vídeo COMPLETO de mangá, narrado em primeira pessoa pelo protagonista, em português do Brasil. Este vídeo junta várias partes já narradas (a história corre contínua, sem cortes de "parte 2"): só a abertura e o fechamento são novos.
Recebe: o nome da obra, as partes juntadas (na ordem), o resumo dos capítulos, o começo e as últimas frases narradas.
Escreva:
- "intro": a ABERTURA única, curta (25 a 50 palavras): apresente a história e o protagonista de forma simples e empolgante e puxe para o primeiro acontecimento, sem contá-lo. NÃO fale em "parte 1", "parte 2" nem em link.
- "outro": o FECHAMENTO, curto (25 a 45 palavras): deixe no ar o que está em jogo ao final desta história e convide a acompanhar a continuação e a se inscrever. Use SÓ o que está nos resumos/últimas frases. Sem clichê robótico.
Falas contínuas (sem listas, emojis ou marcações), no jeito de narrar abaixo.
${NARRATOR_STYLE}
Responda SOMENTE JSON: {"intro":"...","outro":"..."}`;

/** Partes escolhidas (ids na ordem dada); sem ids = todas as partes numeradas da série. Partes sem número (feitas antes do recurso) entram só se escolhidas. */
export function selectedParts(me: StudioProject, ids?: string[]): StudioProject[] {
  if (!ids?.length) return seriesParts(me);
  const uniq = [...new Set(ids)];
  const key = seriesKey(me);
  return uniq.map((id) => {
    const o = readProject(id);
    if (!o) throw new Error('Uma das partes escolhidas não existe mais');
    if (seriesKey(o) !== key) throw new Error(`"${o.title}" é de outra obra: escolha só partes da mesma obra`);
    return o;
  });
}

const partName = (o: StudioProject, i: number) => o.partLabel?.trim() || (partNumber(o) ? `Parte ${partNumber(o)}` : `Parte ${i + 1}`);

/** Abertura e fechamento do vídeo completo: a IA escreve uma vez (guardado em .progress, não repete a chamada) e só essas duas falas vão para a voz. */
async function joinTexts(last: StudioProject, parts: StudioProject[], ctx: JobCtx): Promise<{ intro: string; outro: string }> {
  const sig = createHash('sha1').update(parts.map((o) => `${o.id}:${o.lastRender?.sig ?? o.lastRender?.at ?? ''}`).join('|')).digest('hex').slice(0, 16);
  const cacheFile = path.join(projectDir(last.id), '.progress', 'join-texts.json');
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { sig: string; intro: string; outro: string };
    if (c.sig === sig && c.intro && c.outro) return c;
  } catch {
    /* sem texto guardado */
  }
  const first = parts[0];
  const chapters = parts.map((o, i) => `${partName(o, i)}:\n${Object.entries(o.chapterContexts ?? {}).map(([c, t]) => `${c}: ${t}`).join('\n').slice(0, 1500)}`).join('\n\n').slice(0, 6000);
  const text = (o: StudioProject) => o.shots.filter((s) => !isHook(s) && s.text.trim()).map((s) => s.text);
  const start = text(first).slice(0, 3).join(' ').slice(0, 500);
  const end = text(last).slice(-4).join(' ').slice(-700);
  const llm = jobLLM(ctx);
  const raw = await llm.complete({
    system: SYSTEM_JOIN,
    prompt: `Obra: ${(last.series?.trim() || last.title)}\n${last.context ? `Sobre a obra: ${last.context.slice(0, 1200)}\n` : ''}Partes juntadas: ${parts.map(partName).join(' + ')}\nResumo dos capítulos:\n${chapters}\nComeço da narração: "${start}"\nÚltimas frases narradas: "${end}"`,
    maxTokens: 900,
    temperature: 0.7,
    signal: ctx.signal,
  });
  const out = extractJson(raw) as { intro?: string; outro?: string };
  const intro = cleanSpeechText(String(out.intro ?? '')).trim();
  const outro = cleanSpeechText(String(out.outro ?? '')).trim();
  if (!intro || !outro) throw new Error('A IA não devolveu a abertura e o fechamento do vídeo completo; rode de novo');
  if ('report' in llm) ctx.log((llm as ReturnType<typeof jobLLM>).report());
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ sig, intro, outro }), 'utf8');
  return { intro, outro };
}

/**
 * Emenda os vídeos prontos das partes escolhidas (em ordem) num vídeo só. Os ganchos das partes saem; entra uma abertura e um fechamento
 * novos (texto da IA + voz só deles; imagem = primeiro/último quadro do vídeo, sem render). O resto reaproveita o áudio e o vídeo já prontos.
 * Resultado no projeto da última parte escolhida (`joined`).
 */
export async function joinParts(projectId: string, ctx: JobCtx, signal?: AbortSignal, opts: { ids?: string[] } = {}): Promise<string> {
  const me = readProject(projectId);
  if (!me) throw new Error('Projeto não encontrado');
  const parts = selectedParts(me, opts.ids);
  if (parts.length < 2) throw new Error(opts.ids?.length ? 'Marque pelo menos duas partes para juntar.' : 'Só há uma parte nesta série: crie as outras partes (campo "Parte") para juntar.');
  const numbers = parts.map(partNumber);
  const dup = numbers.find((x, i) => x && numbers.indexOf(x) !== i);
  if (dup) throw new Error(`Há dois projetos como "parte ${dup}" nesta série: corrija o número de um deles`);
  const missing: string[] = [];
  const wins = parts.map((o, i) => {
    const w = storyWindow(o);
    if (!w) missing.push(`${partName(o, i)} (${o.title})`);
    return w;
  });
  if (missing.length) throw new Error(`Falta renderizar: ${missing.join(', ')}. Renderize cada parte antes de juntar.`);
  const stale = parts.filter((o) => o.lastRender && o.lastRender.sig && o.lastRender.at < o.updatedAt).length;
  if (stale) ctx.log(`Aviso: ${stale} parte(s) foram mexidas depois do último render; o vídeo junto usa o render que já existe`);
  const formats = new Set(parts.map((o) => o.format));
  if (formats.size > 1) throw new Error('As partes têm formatos diferentes (horizontal/vertical): não dá para emendar');
  const gaps = numbers.every(Boolean) && numbers.some((x, i) => i && x !== numbers[i - 1] + 1);
  if (gaps) ctx.log(`Aviso: faltam números entre as partes (${numbers.join(', ')}); juntando só as que existem`);

  const last = parts[parts.length - 1];
  const labels = parts.map(partName);
  const nvenc = getAppSettings().hwAccel === 'nvenc';
  const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
  const enc = nvenc ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '21'] : x264;
  const encode = async (args: (venc: string[]) => string[], cwd: string) => {
    try {
      await runFfmpeg(args(enc), { cwd, signal });
    } catch (err) {
      if (!nvenc || signal?.aborted) throw err;
      await runFfmpeg(args(x264), { cwd, signal });
    }
  };
  const work = path.join(dataPaths.temp, `manga-join-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await mkdirRetry(work);
  try {
    // 1) texto novo (uma chamada curta) e voz só dele
    ctx.progress(0.01, 'Escrevendo a abertura e o fechamento do vídeo completo');
    const texts = await joinTexts(last, parts, ctx);
    ctx.log(`Abertura do vídeo completo: "${texts.intro}"`);
    ctx.log(`Fechamento do vídeo completo: "${texts.outro}"`);
    const ttsCache = path.join(projectDir(last.id), '.progress', 'tts'); // mesmo cache de voz do render
    const voice = last.voice;
    const wavs = { intro: path.join(work, 'intro.wav'), outro: path.join(work, 'outro.wav') };
    for (const k of ['intro', 'outro'] as const) {
      ctx.progress(k === 'intro' ? 0.04 : 0.07, `Gerando a voz d${k === 'intro' ? 'a abertura' : 'o fechamento'}`);
      await synthesizeSpeech(texts[k], wavs[k], { signal, voice, cacheDir: ttsCache, onNotice: ctx.log });
    }
    // 2) vídeo das duas falas: quadro parado (primeiro quadro da história / último quadro) com a voz por cima
    const still = async (kind: 'intro' | 'outro') => {
      const src = kind === 'intro' ? parts[0] : last;
      const w = (kind === 'intro' ? wins[0] : wins[wins.length - 1])!;
      const png = path.join(work, `${kind}.png`);
      const at = kind === 'intro' ? w.start + 0.2 : Math.max(w.start, w.end - 0.3);
      await runFfmpeg(['-y', '-ss', at.toFixed(3), '-i', src.lastRender!.file, '-frames:v', '1', png], { cwd: work, signal });
      const dur = (await audioDuration(wavs[kind], signal)) + (kind === 'outro' ? 1.2 : 0.4);
      const out = path.join(work, `${kind}.mp4`);
      const fade = kind === 'outro' ? `,fade=t=out:st=${Math.max(0, dur - 1).toFixed(2)}:d=1` : '';
      const afade = kind === 'outro' ? `,afade=t=out:st=${Math.max(0, dur - 1).toFixed(2)}:d=1` : '';
      await encode((venc) => ['-y', '-loop', '1', '-framerate', String(FPS), '-i', png, '-i', wavs[kind], '-t', dur.toFixed(3), '-vf', `format=yuv420p${fade}`, '-af', `apad,aresample=48000${afade}`, ...venc, '-r', String(FPS), '-c:a', 'aac', '-b:a', '160k', '-ac', '2', out], work);
      return out;
    };
    ctx.progress(0.1, 'Montando a abertura e o fechamento');
    const introFile = await still('intro');
    const outroFile = await still('outro');
    // 3) cada parte sem os ganchos (o fim da última sem o silêncio final, que o fechamento novo substitui)
    const pieces: string[] = [introFile];
    for (const [i, o] of parts.entries()) {
      if (signal?.aborted) throw new Error('Cancelado');
      const w = wins[i]!;
      const len = Math.max(0.5, w.end - w.start);
      const piece = path.join(work, `part_${i}.mp4`);
      ctx.progress(0.15 + (i / parts.length) * 0.75, `Cortando ${labels[i]} (${len.toFixed(0)} s, sem os ganchos)`);
      // recodifica o vídeo (corte no meio de um GOP) com os mesmos parâmetros da abertura/fechamento, para a emenda sem recodificar de novo
      await encode((venc) => ['-y', '-ss', w.start.toFixed(3), '-t', len.toFixed(3), '-i', o.lastRender!.file, '-vf', 'format=yuv420p', '-af', 'aresample=48000', ...venc, '-r', String(FPS), '-c:a', 'aac', '-b:a', '160k', '-ac', '2', piece], work);
      pieces.push(piece);
    }
    pieces.push(outroFile);
    ctx.progress(0.92, 'Emendando tudo');
    const outDir = path.join(projectDir(last.id), 'videos', 'completo'); // subpasta: a limpeza do render não mexe nela
    fs.mkdirSync(outDir, { recursive: true });
    const base = (me.series?.trim() || me.title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 50) || 'manga';
    const tag = numbers.every(Boolean) ? `partes-${numbers[0]}-a-${numbers[numbers.length - 1]}` : `${parts.length}-partes`;
    const out = path.join(outDir, `${base}_completo_${tag}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`);
    fs.writeFileSync(path.join(work, 'list.txt'), pieces.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`).join('\n'), 'utf8');
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', out], { cwd: work, signal });
    const dur = await audioDuration(out);
    updateProject(last.id, (cur) => {
      cur.joined = { file: out, at: new Date().toISOString(), duration: dur, parts: numbers.filter(Boolean), ids: parts.map((o) => o.id), labels };
    });
    return `Vídeo completo pronto: ${labels.join(' + ')} · ${(dur / 60).toFixed(1)} min → ${out}`;
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
