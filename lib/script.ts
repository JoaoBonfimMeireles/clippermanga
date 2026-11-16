// Roteiro pela IA, economizando tokens:
//  0) Leitura das páginas (lib/page-notes.ts): a IA de visão vê cada página UMA vez e guarda uma descrição em texto
//     (com cache em disco). Daqui para frente nada mais manda imagem.
//  1) Contexto por capítulo: UMA chamada de texto (modelo pequeno) com as descrições das páginas → resumo de ~35 palavras
//     (guardado em project.chapterContexts; capítulos que já têm resumo não gastam de novo).
//  2) Texto de cada parte: a descrição do que a câmera mostra (quadros dentro do foco), o resumo do capítulo e as últimas
//     frases narradas. Lotes maiores quando a IA atual é o Claude (o prompt fixo é diluído em mais partes).
import { lockedSet } from './lock';
import type { LLMProvider } from '@clipper/ai-providers';
import { extractJson } from '@clipper/editing-planner';
import { isClaude, jobLLM } from './ai-meter';
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from './checkpoint';
import { condenseScript, MAX_OVER, SCRIPT_WPS, scriptWords } from './condense';
import { dropSilentShots } from './speech-only';
import { budgetHint, videoBudget } from './autoedit';
import { NARRATOR_STYLE } from './narrator';
import { cleanSpeechText } from './speech-text';
import { ensurePageNotes, pageText, panelsIn, type PageNote } from './page-notes';
import { readSeries, seriesPrompt, updateSeriesMemory } from './series';
import { readProject, updateProject } from './store';
import { chaptersInOrder } from './timeline';
import type { JobCtx } from './jobs';
import { FULL, type Shot, type StudioProject } from './types';

/** Partes por chamada do roteiro: provedor grátis / Claude. */
const BATCH = 8;
const BATCH_CLAUDE = 14;
/** Tamanho máximo do texto das páginas mandado para o resumo de um capítulo. */
const CONTEXT_CHARS = 5000;

const SYSTEM_CONTEXT = `Você é o PROTAGONISTA desta história de mangá/quadrinho e resume o capítulo contando a sua própria história. Recebe a descrição das páginas do capítulo, em ordem.
Escreva em PRIMEIRA PESSOA ("eu"), como quem viveu aquilo: um resumo CURTO e corrido (no máximo 35 palavras), em português do Brasil, com o que aconteceu comigo e ao meu redor e o gancho do final.
Os outros personagens pelo nome, se der para ler. Corte detalhes secundários. Animado, com um toque de humor. Sem emojis.
Além do resumo, avalie a RELEVÂNCIA do capítulo para a história (campo "relevance"):
- "alta": apresenta o protagonista, a origem/passado, o poder ou o sistema e como funcionam, a história de uma arma, de um coadjuvante ou do mundo, uma explicação que enriquece a trama, uma virada, uma luta importante ou um clímax. Esse capítulo é destrinchado por inteiro.
- "media": avança a trama com cenas úteis, mas sem grandes novidades; resumido, sem detalhe por detalhe.
- "baixa": quase só conversa, transição, humor solto ou enchimento, com pouca coisa que mude a história; entra no vídeo só resumido, menor e sem destaque, mostrando o que há nele em poucas frases. NENHUM capítulo é pulado: todos entram.
Na dúvida entre duas, escolha a mais alta. O primeiro capítulo da obra costuma ser "alta".
Responda SOMENTE JSON: {"summary":"...","relevance":"alta|media|baixa"}`;

export { NARRATOR_STYLE } from './narrator';

const SYSTEM_SCRIPT = `Você é o protagonista desta história e narra o vídeo em primeira pessoa. Cada parte do vídeo vem com a descrição do que a câmera mostra (os quadros da página dentro do recorte), na ordem em que aparecem; cada página vem antes com o que acontece nela e as falas já traduzidas.
Escreva UM texto por parte contando o que acontece ali, sem descrever o desenho. As partes deste pedido são só um trecho de uma narração maior e contínua:
- "Narração até aqui" são as últimas frases já faladas: o primeiro texto continua direto delas, sem repetir nada nem as palavras marcantes delas.
- "Vem depois" é o que aparece em seguida: o último texto deve deixar o gancho pronto para isso, sem contar antes da hora.
- Leia os textos deste trecho em sequência antes de responder: precisam soar como um único parágrafo corrido, dividido em pedaços.
${NARRATOR_STYLE}
Tamanho máximo por parte: {LIMIT}.
- NARRE O QUE ACONTECE NAS IMAGENS (personagem, ação, cenário, o que o personagem faz ou mostra), não leia balões: a fala de um balão vira narração do que a cena mostra. Cada frase deve poder ser ilustrada por um desenho da própria página.
- FIDELIDADE: use SÓ o que está nas páginas do capítulo em questão; nunca invente nem adiante o que vem nos próximos capítulos.
- RELEVÂNCIA do capítulo (vem no pedido): "alta" = destrinche tudo o que o capítulo traz (quem é, de onde vem, como o poder funciona, o que muda), com todos os detalhes importantes; "media" = resuma a trama sem detalhe por detalhe; "baixa" = capítulo resumido menor, sem destaque, em poucas frases que mostram o que há nele (o resto das partes pode ficar com texto vazio ""). NUNCA pule um capítulo: todos entram no vídeo.
Responda SOMENTE JSON: {"texts":["...","..."]} com exatamente um texto por parte, na mesma ordem.`;

/** Texto das páginas de um capítulo para o resumo (todas, encurtadas se passar do limite). */
function chapterText(p: StudioProject, ch: string, notes: Record<string, PageNote>): string {
  const lines = p.pages
    .filter((x) => x.chapter === ch && notes[x.id])
    .map((x, k) => `p${k + 1}: ${notes[x.id].events}${notes[x.id].dialogue ? ` (${notes[x.id].dialogue.slice(0, 160)})` : ''}`);
  let out = lines.join('\n');
  for (let cut = 200; out.length > CONTEXT_CHARS && cut > 40; cut -= 40) out = lines.map((l) => l.slice(0, cut)).join('\n');
  return out.slice(0, CONTEXT_CHARS);
}

export async function generateChapterContexts(projectId: string, ctx: JobCtx, opts: { force?: boolean; llm?: LLMProvider } = {}): Promise<number> {
  const p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  const own = !opts.llm;
  const llm = opts.llm ?? jobLLM(ctx);
  const have = p.chapterContexts ?? {};
  // memória da série: capítulo já resumido em outro projeto da mesma obra não gasta IA de novo
  const series = readSeries(p);
  const reuse = opts.force ? [] : chaptersInOrder(p.pages).filter((c) => !have[c] && series?.chapters[c]);
  if (reuse.length) {
    updateProject(projectId, (cur) => reuse.forEach((c) => ((cur.chapterContexts ??= {})[c] = series!.chapters[c])));
    ctx.log(`Memória da série: ${reuse.length} capítulo(s) já resumidos antes foram reaproveitados`);
  }
  const todo = chaptersInOrder(p.pages).filter((c) => opts.force || (!have[c] && !reuse.includes(c)) || !p.chapterRelevance?.[c]);
  if (!todo.length) return reuse.length;
  // o resumo sai da leitura das páginas (feita uma vez só e reaproveitada pelo roteiro e pela edição)
  const sub = (a: number, b: number): JobCtx => ({ ...ctx, progress: (x, m) => ctx.progress(a + x * (b - a), m) });
  const notes = await ensurePageNotes(p, p.pages.filter((x) => todo.includes(x.chapter)), llm, sub(0, 0.8));
  const memory = seriesPrompt(p, 1000);
  // começa do último capítulo que a série já conhece (vídeo anterior), para o resumo continuar a história
  const known = series?.order.filter((c) => !todo.includes(c)) ?? [];
  let prev = known.length ? series!.chapters[known.at(-1)!] : '';
  let done = reuse.length;
  for (const [i, ch] of todo.entries()) {
    ctx.progress(0.8 + (i / todo.length) * 0.2, `Entendendo ${ch} (${i + 1}/${todo.length})`);
    const pagesText = chapterText(p, ch, notes);
    if (!pagesText) {
      ctx.log(`Contexto de ${ch}: nenhuma página lida, pulado`);
      continue;
    }
    try {
      const raw = await llm.complete({
        system: SYSTEM_CONTEXT,
        prompt: `${memory}${p.context ? `Obra: ${p.context.slice(0, 2000)}\n` : ''}${prev ? `Capítulo anterior: ${prev}\n` : ''}Capítulo: ${ch}\nPáginas:\n${pagesText}`,
        maxTokens: 400,
        temperature: 0.3,
        tier: 'small',
        signal: ctx.signal,
      });
      const out = extractJson(raw) as { summary?: string; relevance?: string };
      const summary = String(out.summary ?? '').trim();
      const rel = (['alta', 'media', 'baixa'] as const).find((r) => r === String(out.relevance ?? '').toLowerCase().replace('é', 'e')) ?? (/pular/i.test(String(out.relevance)) ? 'baixa' : 'media');
      if (summary) {
        prev = summary;
        done++;
        updateProject(projectId, (cur) => {
          (cur.chapterContexts ??= {})[ch] = summary;
          (cur.chapterRelevance ??= {})[ch] = rel;
        });
        ctx.log(`${ch}: relevância ${rel}`);
      }
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.log(`Contexto de ${ch} falhou: ${(e as Error).message}`);
    }
  }
  if (own && 'report' in llm) ctx.log((llm as ReturnType<typeof jobLLM>).report());
  return done;
}

/** Muda quando o prompt/formato do roteiro muda, para não reaproveitar progresso antigo incompatível. */
const CK_VERSION = 'script-v8'; // v8: progresso salvo por parte (id do shot → texto), lotes de tamanho variável

/** Frases completas de um JSON {"texts":[...]} cortado no meio (as que fecharam as aspas). */
function partialTexts(raw: string): string[] {
  const start = raw.indexOf('[', raw.indexOf('"texts"'));
  if (start < 0) return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*(?=,|\])/g;
  re.lastIndex = start;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    try {
      out.push((JSON.parse(`"${m[1]}"`) as string).trim());
    } catch {
      break;
    }
  }
  return out;
}

/** Descrição de uma parte para o roteiro: os quadros que o recorte mostra (ou a página toda). */
function shotDesc(s: Shot, note: PageNote | undefined): string {
  if (!note) return 'sem descrição da página';
  const full = s.focus.x1 - s.focus.x0 > 0.95 && s.focus.y1 - s.focus.y0 > 0.95;
  const qs = full ? note.panels : panelsIn(note, s.focus);
  return qs.length ? qs.map((q) => q.what).filter(Boolean).join('; ') : full ? note.events : 'detalhe da página';
}

/**
 * Ao somar capítulos, o fim antigo ("não percam os próximos capítulos") deixa de ser o fim. A IA só aponta quantas frases
 * ficam: o texto da história não é reescrito. Como o texto muda, o render gera a voz só dessa parte. Devolve as últimas falas.
 */
async function trimOldOutro(projectId: string, llm: LLMProvider, ctx: JobCtx): Promise<string[]> {
  const p = readProject(projectId) as StudioProject;
  const locked = lockedSet(p);
  const old = p.shots.filter((s) => locked.has(s.pageId) && s.text.trim());
  const last = old.at(-1);
  if (!last) return [];
  const tailOf = (t: string) => [...old.slice(-3, -1).map((s) => s.text), t].filter(Boolean);
  if (p.outroTrimmedFor === last.id) return tailOf(last.text);
  const sentences = last.text.match(/[^.!?…]+[.!?…]*["”]?\s*/g) ?? [last.text];
  let keep = sentences.length;
  try {
    const raw = await llm.complete({
      system: `Um vídeo narrado de mangá vai CONTINUAR com novos capítulos. Recebe as frases numeradas da última fala do trecho antigo. Diga quantas frases iniciais ficam, tirando só o encerramento: despedida, falar com o público, "não percam", "nos vemos", convite para a continuação e o gancho escrito só para fechar o vídeo. Frases que contam a história ficam. Responda SOMENTE JSON {"keep":n}.`,
      prompt: sentences.map((t, i) => `${i + 1}. ${t.trim()}`).join('\n'),
      maxTokens: 100,
      temperature: 0,
      tier: 'small',
      signal: ctx.signal,
    });
    const n = Number((extractJson(raw) as { keep?: number }).keep);
    if (Number.isInteger(n) && n >= 0 && n <= sentences.length) keep = n;
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    ctx.log(`Não consegui analisar o encerramento antigo (${(e as Error).message.slice(0, 100)}); rode o roteiro de novo`);
    return tailOf(last.text);
  }
  const text = sentences.slice(0, keep).join('').trim();
  updateProject(projectId, (cur) => {
    cur.outroTrimmedFor = last.id;
    const s = cur.shots.find((x) => x.id === last.id);
    if (!s || keep === sentences.length) return;
    s.duration = Math.max(1, Math.round(s.duration * (text.length / Math.max(1, s.text.length)) * 10) / 10);
    s.text = text;
    s.audioCuts = undefined;
  });
  ctx.log(keep === sentences.length ? 'Fim antigo sem encerramento para tirar' : `Encerramento antigo retirado da parte final. Era: "${last.text}" · agora: "${text}"`);
  return tailOf(text);
}

export async function generateScript(projectId: string, ctx: JobCtx): Promise<string> {
  let p = readProject(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  if (!p.pages.length) throw new Error('Importe páginas antes de gerar o roteiro');
  // linha do tempo vazia (roteiro antes da edição): uma parte provisória por página inteira, só para escrever o texto
  const draft = !p.shots.length;
  const locked = lockedSet(p);
  const llm = jobLLM(ctx);
  ctx.log(`Roteiro com ${llm.name} (${llm.model})`);
  const sub = (a: number, b: number): JobCtx => ({ ...ctx, progress: (x, m) => ctx.progress(a + x * (b - a), m) });

  // 0) leitura das páginas (uma vez só, com cache) e 1) resumo dos capítulos que ainda não têm
  const pageOf = new Map(p.pages.map((x) => [x.id, x]));
  const used = draft ? p.pages : [...new Set(p.shots.map((s) => s.pageId))].map((id) => pageOf.get(id)!).filter(Boolean);
  const notes = await ensurePageNotes(p, used, llm, sub(0, 0.4));
  await generateChapterContexts(projectId, sub(0.4, 0.45), { llm });
  p = readProject(projectId) as StudioProject;
  const contexts = p.chapterContexts ?? {};
  // continuação: o que já foi contado neste mesmo vídeo (capítulos prontos), para manter nomes e história
  const doneChapters = chaptersInOrder(p.pages.filter((pg) => locked.has(pg.id)));
  const doneStory = doneChapters.length ? `JÁ CONTADO NESTE VÍDEO (capítulos prontos; continue daqui com os mesmos nomes, termos e jeito de falar, sem recontar): ${doneChapters.map((c) => `${c}: ${contexts[c] ?? ''}`).join(' | ')}
` : '';
  const memory = seriesPrompt(p) + doneStory;
  const prevVideo = memory ? readSeries(p)?.lastNarration : '';
  if (memory) ctx.log('Usando a memória da série (vídeos anteriores) para manter nomes, jeito de contar e continuidade');

  // 2) texto das partes, em lotes do mesmo capítulo
  const limit = p.narration !== 'text' ? 'cerca de 2 palavras por segundo de duração' : '12 palavras (legenda)';
  const system = SYSTEM_SCRIPT.replace('{LIMIT}', limit);
  const budget = videoBudget(p);
  const capped = Number.isFinite(budget);
  const secPerPage = capped ? budget / p.pages.length : 8;
  ctx.log(capped ? `Duração-alvo: até ${Math.round(budget / 60)} min (~${secPerPage.toFixed(1)} s por página)` : 'Duração automática: sem teto por capítulo; a IA decide pela relevância de cada capítulo');
  // segundos por página conforme a relevância do capítulo (sem teto): alta destrincha, baixa/pular quase nada
  const relOf = (ch: string): 'alta' | 'media' | 'baixa' => (p!.chapterRelevance?.[ch] === 'pular' ? 'baixa' : p!.chapterRelevance?.[ch]) ?? 'media';
  const secFor = (ch: string) => (capped ? secPerPage : { alta: 14, media: 7, baixa: 3.5 }[relOf(ch)]);
  const shots = draft
    ? p.pages.map((pg): Shot => ({ id: `pg-${pg.id}`, pageId: pg.id, duration: Math.max(1, Math.round(secFor(pg.chapter) * 10) / 10), focus: FULL, motion: 'zoom-in', text: '' }))
    : p.shots.filter((s) => pageOf.has(s.pageId) && !locked.has(s.pageId));
  if (locked.size && !shots.length) return 'Nenhum capítulo novo para escrever: os capítulos prontos estão protegidos';
  if (locked.size) ctx.log(`Continuando a história: ${shots.length} parte(s) novas; ${p.shots.length - shots.length} parte(s) prontas ficam como estão`);
  if (draft) ctx.log(`Linha do tempo vazia: roteiro escrito por página (${shots.length}) para guiar a edição com IA`);
  const chOf = (s: Shot) => pageOf.get(s.pageId)!.chapter;
  const numOf = (s: Shot) => p!.pages.indexOf(pageOf.get(s.pageId)!) + 1;
  const texts = new Map<string, string>();
  // progresso salvo por parte: rodar de novo reaproveita o que já foi escrito, qualquer que seja o tamanho do lote
  const done = loadCheckpoint<string>(projectId, 'script', CK_VERSION);
  const reused = shots.filter((s) => done.has(s.id)).length;
  if (reused) ctx.log(`Retomando: ${reused} parte(s) já escritas antes foram reaproveitadas`);
  // continuação: tira o encerramento do trecho pronto e a história segue da última fala dele
  const tail = locked.size ? await trimOldOutro(projectId, llm, ctx) : [];
  let recent: string[] = tail; // últimas frases narradas, para a próxima parte continuar delas
  const remember = (got: string[]) => (recent = [...recent, ...got.filter(Boolean)].slice(-3));
  const focusNote = (ch: string) =>
    `${capped ? `Duração-alvo do vídeo: ${Math.round(budget / 60)} min no total. ${budgetHint(secPerPage)} ` : 'SEM teto de duração: o tamanho de cada texto acompanha o tempo da parte. '}Relevância deste capítulo: ${relOf(ch)}. Parte sem importância pode ficar com texto vazio ("") e a narração das importantes pode ser um pouco maior. O que foi pulado tem que ser costurado: o texto seguinte resume em poucas palavras o que aconteceu no meio e liga com naturalidade à cena atual, para a narração soar contínua, linear e sem saltos.
`;
  let calls = 0;
  for (let i = 0; i < shots.length; ) {
    if (ctx.signal?.aborted) throw new Error('Cancelado');
    const saved = done.get(shots[i].id);
    if (saved !== undefined) {
      if (saved) texts.set(shots[i].id, saved);
      remember([saved]);
      i++;
      continue;
    }
    // lote: partes seguidas, ainda não escritas, do mesmo capítulo (maior quando a IA atual é o Claude)
    const size = isClaude(llm) ? BATCH_CLAUDE : BATCH;
    const ch = chOf(shots[i]);
    const first = i + 1;
    const batch: Shot[] = [];
    while (i < shots.length && batch.length < size && chOf(shots[i]) === ch && !done.has(shots[i].id)) batch.push(shots[i++]);
    // descrição: cada página uma vez (acontecimentos e falas), depois o que cada parte mostra
    const seen = new Set<string>();
    const desc = batch
      .map((s, k) => {
        const note = notes[s.pageId];
        const head = !seen.has(s.pageId) && note ? `Página ${numOf(s)}: ${pageText(note)}\n` : '';
        seen.add(s.pageId);
        return `${head}Parte ${k + 1} (${s.duration}s, página ${numOf(s)}): mostra ${shotDesc(s, note)}${s.text ? ` · rascunho "${s.text.slice(0, 120)}"` : ''}`;
      })
      .join('\n');
    // prévia do que vem depois: rascunho/descrição do próximo trecho ou, se mudar de capítulo, o resumo do próximo capítulo
    const next = shots.slice(i, i + 3);
    const nextCh = next[0] && chOf(next[0]);
    const nextDraft = next.filter((s) => chOf(s) === ch).map((s) => s.text || shotDesc(s, notes[s.pageId])).filter(Boolean).join(' ').slice(0, 200);
    const ahead = !next.length
      ? 'FIM DO VÍDEO: o ÚLTIMO texto fecha com uma despedida empolgada, falando com o público: anuncie que este capítulo termina aqui, deixe um gancho forte e curioso para os próximos capítulos (o que pode vir, a tensão no ar) e convide para não perder a continuação (ex.: algo no tom de "e isso é só o começo... nos vemos nos próximos capítulos!", mas com palavras suas, criativas e diferentes a cada vídeo, sem soar robótico nem clichê)'
      : nextCh !== ch
        ? `próximo capítulo (${nextCh})${contexts[nextCh!] ? `: ${contexts[nextCh!].slice(0, 200)}` : ''}`
        : nextDraft || '';
    // limite folgado: modelos que "pensam" gastam parte dele; JSON cortado = lote perdido.
    // Se vier cortado, tenta de novo com o dobro e, em último caso, aproveita as frases que vieram completas.
    let got: string[] | null = null;
    for (let attempt = 1; attempt <= 2 && !got; attempt++) {
      try {
        calls++;
        const raw = await llm.complete({
          system,
          // parte fixa do job primeiro (memória da série, obra, duração), o que muda por lote depois: ajuda o cache de prompt
          prompt:
            `${memory}${p.context ? `Obra: ${p.context.slice(0, 2000)}\n` : ''}${focusNote(ch)}${contexts[ch] ? `Resumo de ${ch}: ${contexts[ch]}\n` : ''}` +
            `${recent.length ? `Narração até aqui: "${recent.join(' ')}"\n` : prevVideo ? `Início do vídeo, CONTINUAÇÃO do anterior, que terminou assim: "${prevVideo.slice(-300)}". Abra retomando em uma ou duas frases onde a história parou (para quem não viu o anterior entender) e siga.\n` : 'Início do vídeo: abra a história me apresentando e situando quem assiste.\n'}` +
            `${ahead ? `Vem depois: ${ahead}\n` : ''}\n${desc}`,
          maxTokens: (600 + batch.length * 200) * attempt,
          temperature: 0.6,
          signal: ctx.signal,
        });
        try {
          got = ((extractJson(raw) as { texts?: string[] }).texts ?? []).map((t) => (t ?? '').toString().trim());
        } catch (e) {
          const partial = partialTexts(raw);
          if (attempt === 2 && partial.length) {
            got = partial;
            ctx.log(`Partes ${first}–${i}: resposta cortada; aproveitadas ${partial.length} de ${batch.length} frases`);
          } else if (attempt === 1) ctx.log(`Partes ${first}–${i}: resposta cortada, tentando de novo com mais espaço`);
          else throw e;
        }
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        if (attempt === 2) ctx.log(`Partes ${first}–${i} falharam: ${(e as Error).message}`);
      }
    }
    if (got) {
      batch.forEach((s, k) => {
        if (got![k]) texts.set(s.id, cleanSpeechText(got![k]));
        if (k < got!.length) saveCheckpoint(projectId, 'script', CK_VERSION, s.id, got![k] ?? '');
      });
      remember(got);
    }
    ctx.progress(0.45 + (i / shots.length) * 0.55, `Escrevendo (${i}/${shots.length} partes)`);
  }
  updateProject(projectId, (cur) => {
    cur.shots.forEach((s) => texts.has(s.id) && (s.text = texts.get(s.id)!));
    // roteiro por página: a edição com IA usa para saber o que mostrar
    const byPage: Record<string, string> = Object.fromEntries(Object.entries(cur.pageScript ?? {}).filter(([id]) => locked.has(id)));
    for (const s of shots) {
      const t = texts.get(s.id) ?? s.text;
      if (t) byPage[s.pageId] = byPage[s.pageId] ? `${byPage[s.pageId]} ${t}` : t;
    }
    cur.pageScript = byPage;
  });
  clearCheckpoint(projectId, 'script'); // textos aplicados ao projeto: o progresso salvo não é mais necessário
  // duração: no máximo 20% acima da pedida. Passou disso, encurta o texto já escrito (só texto, barato)
  {
    const cur = readProject(projectId) as StudioProject;
    const words = scriptWords(cur.shots);
    if (capped && words > videoBudget(cur) * SCRIPT_WPS * MAX_OVER) {
      ctx.log(`Narração com ~${Math.round(words / SCRIPT_WPS / 60)} min passa do teto de ${Math.round((videoBudget(cur) * MAX_OVER) / 60)} min: encurtando`);
      ctx.log(await condenseScript(projectId, ctx));
    }
  }
  if (!draft) {
    const dropped = dropSilentShots(projectId);
    if (dropped) ctx.log(`${dropped} parte(s) sem fala removidas: toda imagem precisa de narração`);
  }
  await updateSeriesMemory(readProject(projectId) as StudioProject, llm, ctx.log);
  ctx.log(llm.report());
  return `Roteiro pronto: ${texts.size} de ${shots.length} partes · ${calls} chamada(s) de roteiro${llm.claudeCalls() ? ` · ${llm.claudeCalls()} chamada(s) no Claude no job` : ''}`;
}
