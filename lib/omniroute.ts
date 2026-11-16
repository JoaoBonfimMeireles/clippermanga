// Cliente do OmniRoute (gateway local compatível com a API da OpenAI). Só roda no servidor.
// Implementa a mesma interface LLMProvider de @clipper/ai-providers, para o roteiro trocar de provedor sem mudar nada.
// Nunca registra a chave nem o conteúdo das requisições.
//
// Cadeias de modelos (montadas sozinhas a partir de GET /v1/models):
//   - visão (pedidos com imagens): OMNIROUTE_VISION_MODELS primeiro, depois os modelos GRÁTIS com visão detectados;
//   - texto: OMNIROUTE_TEXT_MODELS (padrão "auto") primeiro, depois os modelos GRÁTIS de texto detectados.
// Esfriamento por MODELO (e por provedor em erro de credencial), em memória do processo: um 429 tira só aquele modelo
// da fila por alguns segundos (ou horas, se a cota do dia acabou) e o pedido segue para o próximo na hora.
import type { LLMProvider, LLMRequest, LLMUsage } from '@clipper/ai-providers';

const env = (k: string) => process.env[k]?.trim() || '';
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const num = (k: string, def: number) => {
  const n = Number(env(k));
  return env(k) !== '' && Number.isFinite(n) ? n : def;
};
export const omniBaseUrl = () => (env('OMNIROUTE_BASE_URL') || 'http://localhost:20128/v1').replace(/\/+$/, '');
/** Raiz do servidor (sem /v1), usada pelas rotas de gerenciamento /api/... */
export const omniRootUrl = () => omniBaseUrl().replace(/\/v1$/, '');
export const omniConfigured = () => !!env('OMNIROUTE_API_KEY');

/** Modelos de texto do .env (OMNIROUTE_TEXT_MODEL, no singular, ainda vale). */
const TEXT_MODELS = () => list(env('OMNIROUTE_TEXT_MODELS') || env('OMNIROUTE_TEXT_MODEL') || 'auto');
const VISION_MODELS = () =>
  list(env('OMNIROUTE_VISION_MODELS') || 'gemini/gemini-3.1-flash-lite,openrouter/nvidia/nemotron-3.5-super-vl:free,openrouter/dots-studio/dots-3-note-preview:free');
const AUTO_FREE = () => env('OMNIROUTE_AUTO_FREE') !== '0';
const AUTO_MAX = () => Math.max(0, num('OMNIROUTE_AUTO_MAX', 25));
/**
 * Provedores cujo plano é grátis por inteiro (chave sem cobrança). "provedor/padrão" limita aos modelos que casam
 * (ex.: zai/*flash*). Fora daqui, só entra modelo marcado como grátis (":free", free=true ou preço zero).
 */
const FREE_PROVIDERS = () =>
  list(
    env('OMNIROUTE_FREE_PROVIDERS') ||
      'gemini,groq,cerebras,mistral,github,nvidia,cloudflare,sambanova,ollama-cloud,llm7,api-airforce,cohere,huggingchat,huggingface,free-ai,zai/*flash*',
  );
const EXCLUDE = () => list(env('OMNIROUTE_EXCLUDE_MODELS'));
const TIMEOUT_MS = () => Math.min(120_000, Math.max(20_000, num('OMNIROUTE_TIMEOUT_MS', 45_000)));
/** Máximo de modelos realmente chamados num pedido (os que estão esfriando são pulados de graça). */
const MAX_ATTEMPTS = () => Math.max(1, num('OMNIROUTE_MAX_ATTEMPTS', 8));
/** Esfriamento quando a cota do DIA de um modelo acabou e o provedor não diz quando volta. */
const DAILY_COOL_MS = () => Math.max(5, num('OMNIROUTE_DAILY_COOLDOWN_MIN', 60)) * 60_000;
const AUTH_COOL_MS = 30 * 60_000; // credencial do provedor recusada (401/403)
const GONE_COOL_MS = 6 * 60 * 60_000; // modelo sumiu (404/410) ou exige crédito (402)
const PAID_COOL_MS = 24 * 60 * 60_000; // modelo detectado como grátis que cobrou
const BAD_REQ_COOL_MS = 2 * 60_000; // recusou este pedido (400/413/422): tamanho, nº de imagens etc.
const RATE_STEPS = [20_000, 60_000, 3 * 60_000, 10 * 60_000]; // 429 sem dica de quando volta
const FAIL_STEPS = [30_000, 2 * 60_000, 10 * 60_000]; // 5xx, timeout, resposta vazia

export class OmniRouteError extends Error {
  status: number;
  /** Servidor fora do ar / chave do OmniRoute recusada / nenhum modelo: vale re-testar só depois de um tempo. */
  down?: boolean;
  /** Todos os modelos grátis falharam ou estão esfriando: em quanto tempo o primeiro volta (0 = já há modelo livre). */
  retryInMs?: number;
  /** Modelo que volta primeiro. */
  nextModel?: string;
  constructor(message: string, status = 0, extra?: { down?: boolean; retryInMs?: number; nextModel?: string }) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function key(): string {
  const k = env('OMNIROUTE_API_KEY');
  if (!k) throw new OmniRouteError('OMNIROUTE_API_KEY não definida. Copie .env.example para .env e preencha a chave.', 0, { down: true });
  return k;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export const fmtWait = (ms: number) => (ms < 90_000 ? `${Math.ceil(ms / 1000)} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

// ---------------------------------------------------------------- catálogo

export interface OmniModelInfo {
  id: string;
  owned_by?: string;
  parent?: string | null;
  root?: string;
  name?: string;
  type?: string;
  free?: boolean;
  context_length?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  capabilities?: { vision?: boolean; [k: string]: unknown };
  pricing?: { input?: number; output?: number; [k: string]: unknown };
}

/** Modelos disponíveis (GET /v1/models) + provedores conectados (/api/providers, se houver chave de gerenciamento), em cache por 5 min. */
let catalog: { at: number; models: Map<string, OmniModelInfo>; connected: Set<string> | null } | null = null;

async function loadCatalog(force = false) {
  if (!force && catalog && Date.now() - catalog.at < 5 * 60_000) return catalog;
  let res: Response;
  try {
    res = await fetch(`${omniBaseUrl()}/models`, { headers: { authorization: `Bearer ${key()}` }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new OmniRouteError('OmniRoute não respondeu em ' + omniBaseUrl() + '. Rode "omniroute" no PowerShell e deixe a janela aberta.', 0, { down: true });
  }
  if (res.status === 401) throw new OmniRouteError('OmniRoute recusou a chave (401). Confira OMNIROUTE_API_KEY.', 401, { down: true });
  if (!res.ok) throw new OmniRouteError(`OmniRoute /models respondeu HTTP ${res.status}`, res.status, { down: true });
  const j = (await res.json()) as { data?: OmniModelInfo[] };
  catalog = { at: Date.now(), models: new Map((j.data ?? []).map((m) => [m.id, m])), connected: await loadConnected() };
  chainsCache = null;
  return catalog;
}

/** Provedores com conexão ativa no painel (null = sem chave de gerenciamento: não filtra). */
async function loadConnected(): Promise<Set<string> | null> {
  const mk = env('OMNIROUTE_MANAGEMENT_KEY');
  if (!mk) return null;
  try {
    const res = await fetch(`${omniRootUrl()}/api/providers`, { headers: { authorization: `Bearer ${mk}` }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { connections?: { provider: string; isActive?: boolean }[] };
    if (!Array.isArray(j.connections)) return null;
    return new Set(j.connections.filter((c) => c.isActive !== false).map((c) => c.provider));
  } catch {
    return null;
  }
}

/** Ids dos modelos (compatível com a versão anterior). */
export async function listModels(force = false): Promise<Set<string>> {
  return new Set((await loadCatalog(force)).models.keys());
}

const providerOf = (id: string) => catalog?.models.get(id)?.owned_by || id.split('/')[0];
const glob = (pat: string, s: string) => new RegExp('^' + pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(s);
const EFFORT = /[-:](none|minimal|low|medium|high|xhigh|max)$/i;
const NOT_CHAT = /embed|rerank|whisper|transcribe|tts|guard|lyria|veo|seedance|image-preview|-image\b|audio|music|ocr-only/i;
const VISION_NAME = /(^|[/\-_.:])(vl|vision|omni)([/\-_.:]|$)|gemini|gemma-?[34]|pixtral|llama-?4|qwen[\d.]*-?vl|glm-[\d.]+v\b|kimi-k2\.[5-9]|minimax-m3/i;

function isFree(m: OmniModelInfo): boolean {
  if (m.free === true || /:free$/i.test(m.id) || /\(free\)|gr[aá]tis/i.test(m.name ?? '')) return true;
  const prov = m.owned_by || m.id.split('/')[0];
  const rest = m.id.slice(m.id.indexOf('/') + 1);
  for (const rule of FREE_PROVIDERS()) {
    const [p, pat] = rule.includes('/') ? [rule.slice(0, rule.indexOf('/')), rule.slice(rule.indexOf('/') + 1)] : [rule, '*'];
    if (p.toLowerCase() === prov.toLowerCase() && glob(pat, rest)) return true;
  }
  const pr = m.pricing;
  return !!pr && Number(pr.input ?? 1) === 0 && Number(pr.output ?? 1) === 0;
}

const hasVision = (m: OmniModelInfo) =>
  m.input_modalities ? m.input_modalities.includes('image') : m.capabilities?.vision === true || VISION_NAME.test(m.id);

/** Preferência (maior primeiro): qualidade para ler mangá e escrever roteiro em português. */
const RANK: [RegExp, number][] = [
  [/gemini-[\d.]+-flash(?!-lite)|gemini-flash/i, 100],
  [/gemini-[\d.]+-flash-lite/i, 95],
  [/gemini-[\d.]+-pro|gemini-4/i, 90],
  [/gemini/i, 85],
  [/deepseek-v[34]|kimi-k2|glm-5|qwen3\.[5-9]-?(397|235|122)|qwen3\.[5-9]:397/i, 82],
  [/gpt-oss-120b|nemotron-3(\.5)?-(super|ultra)|minimax-m[23]|llama-?4-maverick|mistral-(large|medium)|pixtral-large/i, 78],
  [/gemma-?4[-:]?31|qwen3\.[5-9]|glm-[\d.]+v|command-a|claude|grok-3/i, 74],
  [/gemma-?4|llama-3\.3-70b|llama-?4-scout|gpt-4o|gpt-4\.1|gpt-5|qwen3/i, 66],
];
const SMALL = /\b(0\.\d|[1-9]|1[0-4])b\b|[-_](1|2|3|4|7|8|9)b[-_:]|nano|tiny|micro|lfm|allam|r7b|lightning/i;
function score(m: OmniModelInfo): number {
  let s = 50;
  for (const [re, v] of RANK) if (re.test(m.id)) { s = v; break; }
  if (SMALL.test(m.id)) s -= 25;
  if (m.id === 'openrouter/free') s = 30; // roteador de grátis do OpenRouter: último recurso
  return s;
}

export interface ChainEntry {
  model: string;
  source: 'env' | 'auto';
  provider: string;
  vision: boolean;
  context?: number;
}
let chainsCache: { vision: ChainEntry[]; text: ChainEntry[] } | null = null;

/** Monta (ou devolve do cache) as cadeias de visão e de texto. */
export async function omniChains(force = false): Promise<{ vision: ChainEntry[]; text: ChainEntry[] }> {
  const cat = await loadCatalog(force);
  if (chainsCache && !force) return chainsCache;
  const exclude = EXCLUDE();
  const excluded = (id: string) => exclude.some((p) => glob(p.includes('*') ? p : `*${p}*`, id));
  const entry = (id: string, source: ChainEntry['source']): ChainEntry => {
    const m = cat.models.get(id);
    return { model: id, source, provider: providerOf(id), vision: m ? hasVision(m) : VISION_NAME.test(id), context: m?.context_length };
  };
  const explicit = (ids: string[]) => ids.filter((id) => id === 'auto' || cat.models.has(id)).map((id) => entry(id, 'env'));

  // candidatos grátis: sem aliases (parent), sem variantes de esforço repetidas, só chat de texto, de provedor conectado
  const seen = new Set<string>();
  const free: OmniModelInfo[] = [];
  if (AUTO_FREE())
    for (const m of [...cat.models.values()].sort((a, b) => a.id.length - b.id.length)) {
      const prov = m.owned_by || '';
      if (m.parent || prov === 'combo' || m.id.startsWith('auto/') || m.id.startsWith('no-think/')) continue;
      if (m.type && m.type !== 'chat') continue;
      if (m.output_modalities && !m.output_modalities.includes('text')) continue;
      if (NOT_CHAT.test(m.id) || excluded(m.id) || !isFree(m)) continue;
      if (cat.connected && !cat.connected.has(prov)) continue;
      const base = `${prov}|${(m.root || m.id).replace(EFFORT, '')}`;
      if (seen.has(base)) continue;
      seen.add(base);
      free.push(m);
    }

  // ordena por preferência, alternando provedores para uma cota esgotada não travar vários modelos seguidos
  const spread = (ms: OmniModelInfo[]) => {
    const pool = ms.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const out: OmniModelInfo[] = [];
    let last = '';
    while (pool.length) {
      let i = pool.findIndex((m) => (m.owned_by || '') !== last && score(m) >= score(pool[0]) - 10);
      if (i < 0) i = 0;
      const [m] = pool.splice(i, 1);
      out.push(m);
      last = m.owned_by || '';
    }
    return out.slice(0, AUTO_MAX());
  };
  const merge = (head: ChainEntry[], tail: OmniModelInfo[]) => {
    const ids = new Set(head.map((e) => e.model));
    return [...head, ...tail.filter((m) => !ids.has(m.id)).map((m) => entry(m.id, 'auto'))];
  };
  chainsCache = {
    vision: merge(explicit(VISION_MODELS()).filter((e) => e.model !== 'auto'), spread(free.filter(hasVision))),
    text: merge(explicit(TEXT_MODELS()), spread([...free])),
  };
  return chainsCache;
}

// ---------------------------------------------------------------- esfriamento (em memória do processo)

interface Cool {
  until: number;
  reason: string;
  strikes: number;
}
const cool = new Map<string, Cool>(); // chave: id do modelo, ou "prov:<provedor>"
const provKey = (model: string) => `prov:${providerOf(model)}`;

function coolDown(k: string, ms: number, reason: string) {
  const prev = cool.get(k);
  cool.set(k, { until: Date.now() + ms, reason, strikes: (prev?.strikes ?? 0) + 1 });
}
const strikes = (k: string) => cool.get(k)?.strikes ?? 0;
/** Quanto falta para o modelo (ou o provedor dele) voltar; null = livre. */
function coolingLeft(model: string): { ms: number; reason: string } | null {
  let best: { ms: number; reason: string } | null = null;
  for (const k of model === 'auto' ? [model] : [model, provKey(model)]) {
    const c = cool.get(k);
    const ms = c ? c.until - Date.now() : 0;
    if (c && ms > 0 && (!best || ms > best.ms)) best = { ms, reason: c.reason };
  }
  return best;
}

/** Estado atual (para logs, testes e telas). */
export function omniCooldowns() {
  return [...cool.entries()].filter(([, c]) => c.until > Date.now()).map(([k, c]) => ({ key: k, inMs: c.until - Date.now(), reason: c.reason, strikes: c.strikes }));
}
/** Zera esfriamentos e caches (testes). */
export function resetOmniState() {
  cool.clear();
  catalog = null;
  chainsCache = null;
  noJson.clear();
  lastServed.text = lastServed.vision = '';
}

// ---------------------------------------------------------------- dicas de "quando volta"

function parseDuration(s: string): number | undefined {
  let ms = 0;
  let hit = false;
  for (const [, v, u] of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m(?!s)|s)/gi)) {
    hit = true;
    ms += Number(v) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as Record<string, number>)[u.toLowerCase()];
  }
  return hit ? Math.round(ms) : undefined;
}

function retryHint(res: Response, text: string): { ms?: number; daily: boolean } {
  let ms: number | undefined;
  const ra = res.headers.get('retry-after');
  if (ra) {
    const n = Number(ra);
    ms = Number.isFinite(n) ? n * 1000 : Date.parse(ra) - Date.now();
  }
  const reset = res.headers.get('x-ratelimit-reset') || res.headers.get('x-ratelimit-reset-requests') || res.headers.get('x-ratelimit-reset-tokens');
  if (ms == null && reset) {
    const n = Number(reset);
    ms = /^\d{13}$/.test(reset) ? n - Date.now() : /^\d{10}$/.test(reset) ? n * 1000 - Date.now() : Number.isFinite(n) ? n * 1000 : parseDuration(reset);
  }
  if (ms == null) {
    const m = text.match(/"retryDelay"\s*:\s*"([\d.]+s)"/i) || text.match(/(?:retry|try again|reset)[^0-9]{0,30}?((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\b\s*)+)/i);
    if (m) ms = parseDuration(m[1]);
  }
  const daily = /per[ _-]?day|daily|PerDay|\bRPD\b|\bTPD\b|free-models-per-day|di[aá]ri[ao]/i.test(text);
  return { ms: ms != null && ms > 0 ? Math.min(ms, PAID_COOL_MS) : undefined, daily };
}

// ---------------------------------------------------------------- chamada a um modelo

type Outcome = { text: string; model: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; cost?: number; provider?: string };
class Skip extends Error {
  skip = true;
}
const noJson = new Set<string>(); // modelos que recusaram response_format
const lastServed = { text: '', vision: '' };
const explicitIds = () => new Set([...TEXT_MODELS(), ...VISION_MODELS()]);

/** Chama um modelo. Em falha, esfria o modelo (ou o provedor) e lança Skip para seguir ao próximo. */
async function tryModel(model: string, body: Record<string, unknown>, signal: AbortSignal | undefined, notice?: (m: string) => void): Promise<Outcome> {
  let jsonMode = !!body.response_format && !noJson.has(model);
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response | null = null;
    let fail = '';
    try {
      const t = AbortSignal.timeout(TIMEOUT_MS());
      const b: Record<string, unknown> = { ...body, model };
      if (!jsonMode) delete b.response_format;
      res = await fetch(`${omniBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key()}` },
        body: JSON.stringify(b),
        signal: signal ? AbortSignal.any([signal, t]) : t,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      fail = /timeout|abort/i.test(String((e as Error)?.name) + String((e as Error)?.message)) ? 'timeout' : 'falha de rede';
    }
    if (res) {
      const st = res.status;
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as any;
        const c = j?.choices?.[0]?.message?.content;
        const text = (Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('') : (c ?? '')).toString().trim();
        if (text) {
          cool.delete(model);
          const cost = Number(res.headers.get('x-omniroute-response-cost') || 0);
          if (cost > 0) {
            if (!explicitIds().has(model)) {
              coolDown(model, PAID_COOL_MS, `cobrou US$ ${cost}`);
              notice?.(`OmniRoute: ${model} cobrou US$ ${cost}; tirado da cadeia grátis por 24 h`);
            } else notice?.(`OmniRoute: ${model} (do .env) cobrou US$ ${cost}`);
          }
          return { text, model: j?.model || model, usage: j?.usage, cost, provider: res.headers.get('x-omniroute-provider') || undefined };
        }
        fail = `resposta vazia${j?.choices?.[0]?.finish_reason ? ` (${j.choices[0].finish_reason})` : ''}`;
      } else {
        const errText = (await res.text().catch(() => '')).slice(0, 2000);
        let short = errText;
        try {
          short = String(JSON.parse(errText)?.error?.message ?? errText);
        } catch {}
        short = short.replace(/\s+/g, ' ').slice(0, 140);
        // 401 sem conexão selecionada = o OmniRoute recusou a NOSSA chave: não adianta trocar de modelo
        if (st === 401 && !res.headers.get('x-omniroute-selected-connection-id') && /api key|unauthori|token/i.test(errText) && !/\[\d{3}\]/.test(errText))
          throw new OmniRouteError(`OmniRoute recusou a chave (401). Confira OMNIROUTE_API_KEY.`, 401, { down: true });
        if (st === 401 || st === 403) {
          // alias do roteador ("auto", "auto/..."): esfria só o alias, por pouco tempo (na próxima ele pode escolher outro provedor)
          if (model === 'auto' || model.startsWith('auto/')) {
            coolDown(model, BAD_REQ_COOL_MS, `credencial recusada (${st})`);
            throw new Skip(`escolheu um provedor com credencial recusada (${st}: ${short}); em espera por 2 min`);
          }
          coolDown(provKey(model), AUTH_COOL_MS, `credencial recusada (${st})`);
          throw new Skip(`credencial do provedor ${providerOf(model)} recusada (${st}: ${short}); provedor em espera por 30 min — confira a conexão no painel do OmniRoute`);
        }
        if (st === 429) {
          const h = retryHint(res, errText);
          if (h.ms != null && h.ms <= 3000 && attempt === 1) {
            await sleep(h.ms + 200, signal);
            continue;
          }
          const ms = h.daily ? Math.max(h.ms ?? 0, DAILY_COOL_MS()) : h.ms != null ? h.ms + 1000 : RATE_STEPS[Math.min(strikes(model), RATE_STEPS.length - 1)];
          coolDown(model, ms, h.daily ? 'cota do dia' : 'limite por minuto');
          throw new Skip(`${h.daily ? 'cota do dia esgotada' : 'limite (429)'}; em espera por ${fmtWait(ms)}`);
        }
        if (st === 402 || st === 404 || st === 410) {
          if (st !== 402) catalog = null;
          coolDown(model, GONE_COOL_MS, st === 402 ? 'exige crédito (402)' : `fora do ar (${st})`);
          throw new Skip(`${st === 402 ? 'exige crédito (402)' : `saiu do ar (${st})`}; em espera por 6 h`);
        }
        if ((st === 400 || st === 422) && jsonMode && /response_format|json|schema|structured/i.test(errText)) {
          jsonMode = false;
          noJson.add(model);
          continue; // tenta de novo sem response_format
        }
        if ((st === 400 || st === 422) && Array.isArray((body.messages as any[])?.at(-1)?.content) && /image|vision|multimodal|text-only/i.test(errText)) {
          coolDown(model, GONE_COOL_MS, 'não aceita imagens');
          throw new Skip(`não aceita imagens (${short}); fora por 6 h`);
        }
        if (st === 400 || st === 413 || st === 422) {
          coolDown(model, BAD_REQ_COOL_MS, `recusou o pedido (${st})`);
          throw new Skip(`recusou o pedido (${st}: ${short}); em espera por 2 min`);
        }
        fail = `HTTP ${st}${short ? `: ${short}` : ''}`;
      }
    }
    // falha passageira: uma nova tentativa rápida no mesmo modelo, depois esfria e passa adiante
    if (attempt < 2) {
      notice?.(`OmniRoute ${model}: ${fail}; nova tentativa`);
      await sleep(1500, signal);
      continue;
    }
    const ms = FAIL_STEPS[Math.min(strikes(model), FAIL_STEPS.length - 1)];
    coolDown(model, ms, fail);
    throw new Skip(`${fail}; em espera por ${fmtWait(ms)}`);
  }
  throw new Skip('sem resposta');
}

// ---------------------------------------------------------------- cadeia

export interface OmniChatRequest extends LLMRequest {
  json?: boolean;
  onNotice?: (m: string) => void;
}

/** Chat com cadeia de modelos (texto ou visão), pulando os que estão esfriando. */
export async function omniChat(req: OmniChatRequest): Promise<Outcome> {
  const hasImages = !!req.images?.length;
  const kind = hasImages ? 'vision' : 'text';
  const chains = await omniChains();
  const chain = chains[kind];
  if (!chain.length)
    throw new OmniRouteError(
      hasImages ? 'Nenhum modelo de visão existe hoje no OmniRoute. Ajuste OMNIROUTE_VISION_MODELS ou conecte um provedor grátis com visão.' : 'Nenhum modelo de texto existe no OmniRoute. Ajuste OMNIROUTE_TEXT_MODELS.',
      0,
      { down: true },
    );

  const content = hasImages
    ? [{ type: 'text', text: req.prompt }, ...req.images!.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } }))]
    : req.prompt;
  const body: Record<string, unknown> = {
    messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content }],
    max_tokens: req.maxTokens ?? 4000,
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.json ? { response_format: { type: 'json_object' } } : {}),
  };
  // tamanho aproximado em tokens, para não mandar a modelos de contexto pequeno
  const est = Math.ceil(((req.system?.length ?? 0) + req.prompt.length) / 3) + (req.images?.length ?? 0) * 1600 + Number(body.max_tokens);

  const failed: string[] = [];
  let waiting = 0;
  let attempts = 0;
  for (const e of chain) {
    if (e.context && e.context < est) continue;
    if (coolingLeft(e.model)) {
      waiting++;
      continue;
    }
    if (attempts >= MAX_ATTEMPTS()) break;
    attempts++;
    try {
      const out = await tryModel(e.model, body, req.signal, req.onNotice);
      const served = out.model && out.model !== e.model ? `${e.model} → ${out.provider ? `${out.provider}/` : ''}${out.model}` : e.model;
      if (failed.length || lastServed[kind] !== e.model)
        req.onNotice?.(`OmniRoute (${kind === 'vision' ? 'visão' : 'texto'}): atendido por ${served}${e.source === 'auto' ? ' [grátis, detectado]' : ''}${waiting ? `; ${waiting} em espera` : ''}`);
      lastServed[kind] = e.model;
      return out;
    } catch (err) {
      if (!(err instanceof Skip)) throw err;
      failed.push(`${e.model}: ${err.message}`);
      req.onNotice?.(`OmniRoute: ${e.model} ${err.message} → próximo modelo`);
    }
  }
  // nenhum atendeu: quando volta o primeiro?
  let next: { ms: number; model: string } | null = null;
  for (const e of chain) {
    if (e.context && e.context < est) continue;
    const c = coolingLeft(e.model);
    const ms = c ? c.ms : 0;
    if (!next || ms < next.ms) next = { ms, model: e.model };
  }
  if (!next)
    throw new OmniRouteError(`Nenhum modelo ${hasImages ? 'de visão ' : ''}do OmniRoute aceita um pedido deste tamanho (~${est} tokens).`, 0, { down: true });
  throw new OmniRouteError(
    `limite: nenhum modelo grátis do OmniRoute atendeu (${attempts} tentado(s), ${waiting} em espera; o primeiro volta em ${fmtWait(next.ms)}: ${next.model})${failed.length ? ` — ${failed.slice(-3).join(' | ')}` : ''}`,
    429,
    { retryInMs: next.ms, nextModel: next.model },
  );
}

/** Adaptador para a interface usada pelo roteiro (lib/script.ts). */
export function createOmniRouteLLM(): LLMProvider {
  const usage: LLMUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const p: LLMProvider = {
    name: 'omniroute',
    model: TEXT_MODELS()[0] ?? 'auto',
    supportsImages: true,
    maxPromptChars: 200_000,
    free: true,
    usage,
    async complete(req) {
      const out = await omniChat({ ...req, json: true, onNotice: p.onNotice });
      usage.calls++;
      usage.inputTokens += out.usage?.prompt_tokens ?? 0;
      usage.outputTokens += out.usage?.completion_tokens ?? 0;
      p.model = out.model;
      return out.text;
    },
  };
  return p;
}
