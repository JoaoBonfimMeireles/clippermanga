// Tipos do app de mangá (seguros para o navegador). Páginas e formatos vêm de @clipper/shared.
import type { MangaFormat, MangaPanel } from '@clipper/shared';

export type Rect = MangaPanel; // frações da página (0..1)
export type Motion = 'zoom-in' | 'zoom-out' | 'pan' | 'static';
/** text = só legenda/silêncio; voice = voz da IA; mic = a sua voz gravada no painel Minha narração. */
export type NarrationMode = 'text' | 'voice' | 'mic';

export interface StudioPage {
  id: string;
  file: string; // relativo à pasta do projeto
  width: number;
  height: number;
  chapter: string;
}

/** Uma parte do vídeo: uma página, o foco desenhado pelo usuário, o movimento da câmera e o texto. */
export interface Shot {
  id: string;
  pageId: string;
  duration: number; // segundos
  focus: Rect;
  motion: Motion;
  /** contain = quadro inteiro com laterais desfocadas; cover = tela cheia (ação). Padrão: contain. */
  fit?: 'contain' | 'cover';
  /** Scroll: faixa alta percorrida de cima para baixo (down) ou de baixo para cima (up) durante a fala. Sempre com motion 'pan' e fit 'cover' (lib/autoedit.ts, lib/camera.ts). */
  scroll?: 'down' | 'up';
  /** Gira o recorte, sentido horário: 0, 90, 180 ou 270. */
  rotate?: number;
  /** Estica na horizontal (1 = original). A IA usa até 1.35; à mão, o quanto quiser. */
  stretch?: number;
  /** Aproxima o recorte na tela (1 = encaixado). */
  zoom?: number;
  /** Faixa do recorte usada no fundo desfocado (evita texto/balão no fundo). Padrão: top. */
  bgBand?: 'top' | 'bottom' | 'full';
  /** Classificação da IA (só informativa). */
  kind?: 'action' | 'reaction' | 'dialogue' | 'scene';
  /** Nota de impacto da IA (1-10): define quanto tempo o recorte fica na tela. */
  impact?: number;
  text: string;
  /** Gancho de parte (lib/parts.ts): intro = "esta é a parte N + o que houve antes"; outro = "na próxima parte...". Saem do vídeo completo. */
  hook?: 'intro' | 'outro';
  /** Trechos cortados da fala desta parte ([início, fim] em segundos do áudio original da fala), aplicados no render. */
  audioCuts?: [number, number][];
  /** Velocidade da parte (1 = normal; 1.5 = 50% mais rápida, voz e imagem). */
  speed?: number;
  /** Imagem trocada depois do último render: o editor mostra a imagem nova até renderizar de novo. */
  newImage?: boolean;
  /** Mais imagens mostradas DURANTE a mesma fala, em sequência depois da principal (a voz não para; o tempo da parte é dividido entre elas). */
  extra?: ShotView[];
}

/** Uma imagem na tela: página, recorte e câmera (sem fala). */
export type ShotView = Pick<Shot, 'pageId' | 'focus' | 'fit' | 'rotate' | 'stretch' | 'zoom' | 'motion' | 'bgBand' | 'scroll'>;

export interface Doubt {
  id: string;
  shotId: string;
  part: number;
  text: string;
  question: string;
  options: { label: string; pageId: string; focus: Rect; /** esticar que a opção precisa para ocupar o piso da tela */ stretch?: number }[];
  /** Opção escolhida no modal (ainda não aplicada: "Seguir" aplica). */
  chosen?: number;
  /** Com "Repetir o quadro anterior" escolhido: a cena anterior também não serviu, então ela troca para a cena desta parte. */
  prevToo?: boolean;
  nextToo?: boolean;
}

export interface TestMode {
  /** Quantos capítulos do lote são o teste (1 ou 2). */
  count: number;
  /** Nomes dos capítulos em teste. */
  chapters: string[];
  startedAt: string;
}

export interface PartInfo {
  /** Número da parte (3 = "parte 3"). */
  number: number;
  /** Link das partes anteriores no YouTube: o gancho de abertura manda procurar na descrição e a publicação o inclui. */
  recapUrl?: string;
  /** Falas dos ganchos (a fonte é a parte da linha do tempo com `hook`; estes são o último texto gerado/editado). */
  intro?: string;
  outro?: string;
}

export interface StudioProject {
  id: string;
  title: string;
  context: string;
  format: MangaFormat;
  narration: NarrationMode;
  /** Nome da série (obra) para a memória entre vídeos. Vazio = título sem os números de capítulo. */
  series?: string;
  /** Este vídeo é uma PARTE de uma série (ex.: parte 3 = capítulos 16-22), com ganchos de abertura e fechamento (lib/parts.ts). */
  part?: PartInfo;
  /** Nome da parte no painel (ex.: "Parte 1 e 2"). Vazio = "Parte N". */
  partLabel?: string;
  /** Vídeo completo montado juntando todas as partes da série (sem os ganchos). Fica no projeto da última parte. */
  joined?: { file: string; at: string; duration: number; parts: number[]; /** projetos juntados, na ordem */ ids?: string[]; /** nomes das partes no painel */ labels?: string[] };
  /** Duração-alvo do vídeo em minutos (máximo). Vazio = automático: sem teto, a IA decide pela relevância de cada capítulo. */
  targetMinutes?: number;
  /** Relevância de cada capítulo para a história (decidida pela IA no passo 1): define quanto ele é destrinchado. */
  chapterRelevance?: Record<string, 'alta' | 'media' | 'baixa' | 'pular'>;
  /** Voz da narração (id de lib/voices.ts). */
  voice?: string;
  /** Depois do vídeo em português, gera também a versão com narração em inglês (roteiro traduzido pela IA + voz). Opcional. */
  englishAudio?: boolean;
  /** Se a OmniRoute acabar, usa o Claude direto (sem perguntar na tela). */
  autoPaid?: boolean;
  /** Narração traduzida para inglês por parte (id da parte → texto), para baixar roteiro e legenda. */
  englishTexts?: Record<string, string>;
  /** Versão em inglês já gerada: arquivo (relativo à pasta do projeto), texto traduzido por parte (id da parte) e de qual render veio. */
  english?: { file: string; at: string; duration: number; renderAt: string; texts: Record<string, string> };
  /** Legenda queimada no vídeo. Padrão: desligada. */
  subtitles?: boolean;
  /** Silêncio no fim do vídeo (s), com a última imagem e fade: encerra sem corte seco. Padrão 3; 0 = sem. */
  endSilence?: number;
  /** Folga depois da última palavra da última fala (s), para ela nunca ser cortada. Padrão 0,8. */
  endTalkPad?: number;
  /** Resumo curto de cada capítulo feito pela IA (nome do capítulo → texto). */
  chapterContexts?: Record<string, string>;
  /** Roteiro narrado por página (id da página → texto), usado pela edição com IA para saber o que focar. */
  pageScript?: Record<string, string>;
  pages: StudioPage[];
  shots: Shot[];
  /** Palavras cortadas do áudio no render (ex.: ["cara"]), sem gerar a voz de novo. */
  cutWords?: string[];
  /** segments: onde cada parte começa no vídeo final (para a linha do tempo seguir o vídeo). */
  /** Material de publicação (etapa 3): thumbnail, título, descrição e tags para o YouTube. */
  publish?: PublishInfo;
  /** Shorts verticais com os melhores momentos do vídeo, cada um com texto para o YouTube. */
  shorts?: ShortInfo[];
  /** Plano de shorts esperando aprovação (checkbox "pausar quando houver narração nova"): nada de voz foi gasto ainda. */
  shortsPlan?: ShortsPlan;
  /** Link do vídeo completo no YouTube: entra no fim da descrição de todos os shorts. */
  fullVideoUrl?: string;
  /** Legendas: tradução em chinês simplificado por parte (id do shot) e o vídeo final com ela queimada. */
  subs?: { zh: { id: string; text: string }[]; zhAt?: string; zhVideo?: { file: string; at: string; renderAt: string } };
  /** Páginas de capítulos já prontos (renderizados antes de importar mais): roteiro, edição e validação não mexem nelas. */
  lockedPages?: string[];
  /** Modo teste (lib/cut-profiles.ts): só os primeiros capítulos do lote passam pelo fluxo; o resto fica estacionado (`parked`) até "Teste finalizado". */
  test?: TestMode;
  /** Capítulos já baixados que esperam o fim do teste: fora de `pages`, então roteiro, edição, validação e render nem os veem. */
  parked?: { chapter: string; pages: StudioPage[] }[];
  /** Resumo (texto) do que o último teste ensinou, para a tela. */
  testSummary?: string;
  /** Parte em que o encerramento ("não percam os próximos capítulos") já foi retirado ao continuar a história. */
  outroTrimmedFor?: string;
  /** Projeto criado com o scroll de faixas altas ligado (só projetos novos; os antigos seguem como estavam). */
  scrollEdit?: boolean;
  /** Modo automático (roteiro → edição → validação → render): fica salvo no projeto e é o SERVIDOR que emenda os passos (lib/jobs.ts), então vale mesmo com a tela fechada ou recarregada. */
  auto?: boolean;
  /** Quantos capítulos baixados entram nos processos (roteiro, edição, validação, render), em ordem de capítulo. Vazio = todos. Os demais ficam estacionados (`parked`) e voltam ao aumentar o número ou na próxima parte (lib/chapter-limit.ts). */
  chapterLimit?: number;
  /** Último link usado para baixar capítulos (um por linha, pode ter {n}). */
  lastImportUrl?: string;
  /** Nome da obra como está no canal (editável na tela inicial; se vazio, usa o título gerado em Publicação). */
  ytTitle?: string;
  /** ISO da data em que o vídeo foi publicado no YouTube (vazio = não publicado). */
  publishedAt?: string;
  /** Data anterior de publicação (para desfazer um clique errado no check). */
  prevPublishedAt?: string;
  /** Dúvidas da IA sobre o recorte (lib/restyle.ts): o usuário escolhe no modal do editor. */
  doubts?: Doubt[];
  lastRender: { file: string; at: string; duration: number; /** assinatura da linha do tempo usada (lib/sig.ts) */ sig?: string; segments?: { id: string; start: number; dur: number; cuts?: [number, number][]; speed?: number }[] } | null;
  createdAt: string;
  updatedAt: string;
}

/** Uma parte (imagem) de um short do Diretor: com `text` a narração é nova (voz do vídeo longo); sem, usa a original. */
export interface ShortPart {
  /** Id da parte na linha do tempo do vídeo longo. */
  shot: string;
  text?: string;
}
export interface PlanItem {
  id: string;
  /** cut = só corte (voz original); narrated = narração nova escrita pela IA no lugar da original. */
  mode: 'cut' | 'narrated';
  title: string;
  summary: string;
  description: string;
  tags: string[];
  /** Por que a IA escolheu esse formato (aparece na tela de aprovação). */
  why: string;
  parts: ShortPart[];
}
export interface ShortsPlan {
  at: string;
  items: PlanItem[];
}

export interface ShortInfo {
  id: string;
  /** Short do Diretor: formato e partes (podem ser fora de ordem ou de pontos diferentes do vídeo). Sem isso = trecho seguido. */
  mode?: 'cut' | 'narrated';
  parts?: ShortPart[];
  /** Partes do vídeo usadas (índices na linha do tempo, inclusive). */
  from: number;
  to: number;
  /** Ids da primeira e da última parte (as posições mudam quando partes são apagadas). */
  fromId?: string;
  toId?: string;
  /** Ids das partes do trecho que foram tiradas do short no modal (o vídeo principal não muda). */
  skip?: string[];
  /** Pedaços cortados do short, em segundos do próprio short (depois de tirar as partes): [início, fim]. */
  cuts?: [number, number][];
  /** Enquadramento escolhido para o short, por parte (id da parte → recorte na página); sem = o do vídeo principal. */
  frames?: Record<string, Rect>;
  title: string;
  /** Resumo curto do momento (para você saber do que se trata). */
  summary: string;
  description: string;
  tags: string[];
  /** Vídeo vertical (relativo à pasta do projeto). */
  file: string;
  duration: number;
  at: string;
}

export interface PublishInfo {
  title: string;
  /** Três títulos diferentes para teste A/B (cada um já com [capítulos] no fim). */
  titles?: string[];
  /** Capítulos que o vídeo cobre, usados no [ ] do título (ex.: "1-2"). */
  chapters?: string;
  description: string;
  tags: string[];
  /** Thumbs geradas (relativas à pasta do projeto). ai = gerada por modelo de imagem; montagem = página do mangá + texto. */
  thumbs: { file: string; source: 'ai' | 'montagem'; model?: string }[];
  /** Texto grande escrito na thumb. */
  thumbText: string;
  /** Pedido do usuário e imagens de referência usados. */
  prompt: string;
  refs: string[];
  /** Por que não saiu thumb por IA (nenhum modelo de imagem respondeu). */
  imageNote?: string;
  at: string;
}

export interface JobInfo {
  id: string;
  kind: 'import' | 'script' | 'edit' | 'check' | 'render' | 'context' | 'polish' | 'publish' | 'subs' | 'shorts' | 'english' | 'restyle' | 'audit' | 'test' | 'hooks' | 'join';
  projectId: string;
  status: 'running' | 'done' | 'error';
  progress: number;
  message: string;
  /** Etapas e avisos, cada um com horário ("hh:mm:ss  texto"). */
  logs: string[];
  startedAt?: number;
  endedAt?: number;
  /** A OmniRoute caiu: o job está esperando a resposta "usar o Claude?" (Sim/Não na tela). */
  askPaid?: boolean;
  /** Resposta dada a essa pergunta neste job. */
  paid?: 'yes' | 'no';
  /** Quanto do limite de 5 h do plano do Claude (0 a 1) este processo gastou: soma das subidas do medidor enquanto ele rodou (inclui qualquer outro uso do plano no mesmo período). */
  quotaUsed?: number;
}

export const FULL: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
export const MOTIONS: Record<Motion, string> = { 'zoom-in': 'Aproximar levemente', 'zoom-out': 'Afastar levemente', pan: 'Percorrer o quadro (tela cheia)', static: 'Parado' };

/** Estima o gasto do limite de 5 h pelas leituras "Claude 5h: N%" que o processo anotou no registro (para os que rodaram antes do medidor). */
export function quotaFromLogs(logs: string[] | undefined): number | undefined {
  let base: number | null = null, peak = 0, done = 0;
  for (const l of logs ?? []) {
    const m = /Claude 5h: (\d+)%/.exec(l);
    if (!m) continue;
    const q = Number(m[1]) / 100;
    if (base === null) base = peak = q;
    else if (q < peak - 0.15) {
      done += peak - base;
      base = peak = q;
    } else if (q > peak) peak = q;
  }
  return base === null ? undefined : done + (peak - base);
}

/** "12%" do limite de 5 h; "<1%" quando foi muito pouco. */
export const quotaText = (q: number) => (q < 0.005 ? '<1%' : `${Math.round(q * 100)}%`);

/** Tempo restante estimado de um job em andamento ("≈ 11 min"), pelo ritmo até agora; vazio se ainda é cedo. */
export function jobEta(j: Pick<JobInfo, 'status' | 'progress' | 'startedAt'>): string {
  if (j.status !== 'running' || !j.startedAt || j.progress < 0.02 || j.progress >= 1) return '';
  const el = (Date.now() - j.startedAt) / 1000;
  if (el < 15) return '';
  const s = Math.round((el * (1 - j.progress)) / j.progress);
  if (s < 60) return `faltam ≈ ${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `faltam ≈ ${m} min` : `faltam ≈ ${Math.floor(m / 60)} h ${m % 60} min`;
}
