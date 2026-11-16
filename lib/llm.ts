// Provedor de IA com reserva: usa os modelos GRÁTIS do OmniRoute primeiro e só vai para o provedor do app de cortes
// (../videos, Configurações — na prática o Claude) quando todos os grátis estão esgotados por mais tempo do que vale
// esperar. Se o OmniRoute não estiver configurado, usa direto o provedor do app.
//
// Ordem de cada chamada:
//   1. cadeia grátis do OmniRoute (lib/omniroute.ts: pula na hora os modelos que estão esfriando);
//   2. todos esfriando, mas o primeiro volta em ≤ MANGA_FREE_WAIT_MAX_S (90 s): espera e tenta de novo;
//   3. reserva paga — a não ser que { paidBackup: false } ou o limite MANGA_MAX_PAID_CALLS do job tenha sido atingido:
//      nesse caso lança erro de limite e withQuotaWait espera os grátis voltarem.
// OmniRoute fora do ar (servidor parado, chave recusada) é re-testado por tempo: a cada OMNIROUTE_RETEST_S (120 s).
import { createLLM, type LLMProvider, type LLMRequest, type LLMUsage } from '@clipper/ai-providers';
import { getAppSettings } from '@clipper/shared/server';
import fs from 'node:fs';
import path from 'node:path';
import { studioDir } from './store';
import { supervise } from './review';
import { createOmniRouteLLM, fmtWait, omniConfigured, OmniRouteError } from './omniroute';

export interface MangaLLMOptions {
  /** false = nunca usa reserva paga (Claude): sem modelo grátis, lança erro de limite (o job espera). Padrão: true. */
  paidBackup?: boolean;
  /** Máximo de chamadas pagas nesta instância (um job/etapa). Padrão: MANGA_MAX_PAID_CALLS (vazio = sem limite). */
  maxPaidCalls?: number;
  /** Troca a fábrica da reserva (testes). Padrão: provedor do app de cortes. */
  backup?: () => LLMProvider | null;
  /** Portão do Claude do job (pergunta Sim/Não na tela). Sem ele, a reserva paga nunca é usada. */
  paidGate?: { allowed(): boolean; denied(): boolean; ask(): void };
}

const envNum = (k: string): number | undefined => {
  const v = process.env[k]?.trim();
  const n = Number(v);
  return v && Number.isFinite(n) ? n : undefined;
};
/**
 * Trava de segurança: a reserva PAGA (Claude) só é usada se o usuário disser Sim na tela do job (paidGate). Não → o job
 * espera a OmniRoute voltar sem gastar (erro de limite → withQuotaWait testa de novo). Fora de um job: não usa.
 */
const PAID_LOCKED = 'Limite: OmniRoute indisponível e você não liberou o Claude; esperando a OmniRoute voltar (nada é gasto)';
const WAIT_MAX_MS = () => (envNum('MANGA_FREE_WAIT_MAX_S') ?? 90) * 1000;
const RETEST_MS = () => (envNum('OMNIROUTE_RETEST_S') ?? 120) * 1000;
/** Rodadas de espera curta seguidas numa mesma chamada antes de aceitar a reserva. */
const MAX_WAIT_ROUNDS = 8;

function appProvider(): LLMProvider | null {
  try {
    return createLLM(getAppSettings(), 'edit');
  } catch {
    return null; // provedor do app sem chave/instalação: fica sem reserva
  }
}

/** Provedor do gestor (Opus via Claude do app), para revisões que não passam pelo OmniRoute. null = sem Claude configurado. */
export const managerProvider = appProvider;

/** Erro de limite/cota do plano (Claude, OmniRoute, etc.): esperar resolve, trocar de página não. */
export const isQuotaError = (e: unknown) => /limite|limit|quota|cota|429|rate|esgot|exhaust|usage/i.test((e as Error)?.message ?? '');

const QUICK_RETRIES = 3;
const QUICK_WAIT_MS = 20_000;
const POLL_MS = 5 * 60_000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((ok, fail) => {
    if (signal?.aborted) return fail(new Error('Cancelado'));
    const t = setTimeout(ok, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), fail(new Error('Cancelado'))), { once: true });
  });

/**
 * Sem limite em nenhuma IA: em vez de queimar as páginas seguintes falhando, tenta 3 vezes e depois TRAVA,
 * testando a cada 5 min até alguma IA voltar a ter limite. O job continua sozinho do ponto onde parou
 * (ou o usuário cancela e roda de novo: o progresso fica salvo).
 */
function withQuotaWait<T extends LLMProvider>(inner: T): T {
  const complete = inner.complete.bind(inner);
  inner.complete = async (req: LLMRequest) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await complete(req);
        if (attempt > QUICK_RETRIES + 1) inner.onNotice?.('Limite da IA voltou; continuando de onde parou');
        return out;
      } catch (e) {
        if (req.signal?.aborted || !isQuotaError(e)) throw e;
        const msg = (e as Error).message.slice(0, 220);
        if (attempt <= QUICK_RETRIES) {
          inner.onNotice?.(`Limite da IA (${msg}); tentativa ${attempt}/${QUICK_RETRIES}, tentando de novo em ${QUICK_WAIT_MS / 1000} s`);
          await sleep(QUICK_WAIT_MS, req.signal);
        } else {
          inner.onNotice?.(`Sem limite em nenhuma IA (${msg}). Pausado: testo de novo a cada 5 min (${new Date(Date.now() + POLL_MS).toLocaleTimeString('pt-BR')}). O que já foi feito está salvo.`);
          await sleep(POLL_MS, req.signal);
        }
      }
    }
  };
  return inner;
}

/** Arquivo-sinal `.force-claude` na pasta dos projetos: pula os modelos grátis e usa o Claude desde o início (sem reiniciar o servidor). */
const forceClaudeFlag = () => {
  try {
    return fs.existsSync(path.join(studioDir(), '.force-claude'));
  } catch {
    return false;
  }
};

/** Provedor usado pelo app. `paidCalls` = chamadas que foram para a reserva paga nesta instância. */
export type MangaLLM = LLMProvider & { readonly paidCalls: number };

export function createMangaLLM(opts: MangaLLMOptions = {}): MangaLLM {
  // revisão do gestor (Opus, só texto) sobre toda resposta, do OmniRoute ou do Haiku; reprovou = refaz (lib/review.ts)
  return supervise(withQuotaWait(createRawLLM(opts)), () => appProvider());
}

function addUsage(to: LLMUsage, from: LLMUsage, before: LLMUsage) {
  to.inputTokens += from.inputTokens - before.inputTokens;
  to.outputTokens += from.outputTokens - before.outputTokens;
}

function createRawLLM(opts: MangaLLMOptions): MangaLLM {
  const makeBackup = opts.backup ?? appProvider;
  const maxPaid = opts.maxPaidCalls ?? envNum('MANGA_MAX_PAID_CALLS');
  if (!omniConfigured()) {
    const app = makeBackup();
    if (!app) throw new Error('Configure o OmniRoute (.env) ou um provedor de IA no app de cortes');
    if (opts.paidBackup === false) throw new Error('OmniRoute não configurado e o provedor do app é pago (reserva paga desativada nesta etapa)');
    if (!opts.paidGate?.allowed()) throw new Error('OmniRoute não configurado: o Claude fica travado para não gastar o seu plano');
    return Object.assign(app, { paidCalls: 0 });
  }
  const omni = createOmniRouteLLM();
  let backup: LLMProvider | null | undefined;
  let current: LLMProvider = omni;
  let downUntil = 0; // OmniRoute fora do ar: só re-testa depois disso
  let paidCalls = 0;
  let notice: ((m: string) => void) | undefined;
  const usage: LLMUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const time = (t: number) => new Date(t).toLocaleTimeString('pt-BR');

  // pergunta na tela (uma vez por job) e espera a resposta; true = pode usar o Claude
  const gateOpen = async (signal?: AbortSignal): Promise<boolean> => {
    const g = opts.paidGate;
    if (!g) return false;
    if (g.allowed()) return true;
    if (g.denied()) return false;
    g.ask();
    while (!g.allowed() && !g.denied()) await sleep(1500, signal);
    return g.allowed();
  };

  const useBackup = async (req: LLMRequest, reason: string, retryIn?: number): Promise<string> => {
    if (backup === undefined) {
      backup = makeBackup();
      if (backup) backup.onNotice = notice;
    }
    const b = backup;
    // qualquer reserva fora do OmniRoute pede permissão — inclusive a assinatura (claude-code), que gasta a cota do plano
    const paid = !!b;
    const block = !b
      ? 'sem reserva: configure um provedor de IA no app de cortes'
      : req.images?.length && !b.supportsImages
        ? `a reserva ${b.name} não aceita imagens`
        : paid && opts.paidBackup === false
          ? 'reserva paga desativada nesta etapa'
          : paid && req.tier !== 'manager' && !(await gateOpen(req.signal))
            ? 'Claude travado'
          : paid && maxPaid != null && paidCalls >= maxPaid
            ? `limite de ${maxPaid} chamada(s) paga(s) por job atingido (MANGA_MAX_PAID_CALLS)`
            : null;
    // sem tela para perguntar (fora de um job): avisa na hora em vez de ficar esperando
    if (block === 'Claude travado' && !opts.paidGate) throw new Error(`${reason.slice(0, 160)} (OmniRoute fora do ar; o Claude fica travado para não gastar o seu plano)`);
    if (block === 'Claude travado') throw new Error(PAID_LOCKED);
    if (block || !b) {
      // modelos grátis só esfriando: erro de LIMITE (withQuotaWait espera eles voltarem); servidor fora: erro comum
      if (retryIn != null) throw new Error(`Limite: modelos grátis esgotados por ora (o primeiro volta em ${fmtWait(retryIn)}); ${block}`);
      throw new Error(`${reason} (${block})`);
    }
    const tag = paid ? ` — chamada PAGA ${paidCalls + 1}${maxPaid != null ? `/${maxPaid}` : ''} neste job` : '';
    notice?.(`${current !== b ? 'Modelos grátis esgotados' : 'Ainda sem modelo grátis'} (${reason.slice(0, 220)}); usando a reserva ${b.name} (${req.tier === 'small' && b.name === 'claude-code' ? 'haiku' : req.tier === 'manager' && b.name === 'claude-code' ? 'opus' : b.model})${tag}`);
    current = b;
    if (paid) paidCalls++;
    const before = { ...b.usage };
    const out = await b.complete(req);
    usage.calls++;
    addUsage(usage, b.usage, before);
    return out;
  };

  const p: MangaLLM = {
    get name() { return current.name; },
    get model() { return current.model; },
    supportsImages: true,
    get maxPromptChars() { return current.maxPromptChars; },
    get free() { return current.free; },
    usage,
    get paidCalls() { return paidCalls; },
    get onNotice() { return notice; },
    set onNotice(fn) {
      notice = fn;
      omni.onNotice = fn;
      if (backup) backup.onNotice = fn;
    },
    async complete(req) {
      for (let round = 0; ; round++) {
        let reason: string;
        let retryIn: number | undefined;
        // teste de consumo: MANGA_FORCE_CLAUDE=1 no .env pula os grátis e vai direto ao Claude (ainda com a permissão do job)
        // o gestor é sempre o Opus (Claude), mesmo quando o trabalho foi do OmniRoute
        if (req.tier === 'manager') reason = 'gestor: sempre Opus';
        else if (process.env.MANGA_FORCE_CLAUDE === '1' || forceClaudeFlag()) reason = 'teste: só Claude (MANGA_FORCE_CLAUDE=1)';
        else if (Date.now() >= downUntil) {
          try {
            const before = { ...omni.usage };
            const out = await omni.complete(req);
            if (current !== omni) notice?.('OmniRoute voltou; usando os modelos grátis de novo');
            current = omni;
            usage.calls++;
            addUsage(usage, omni.usage, before);
            return out;
          } catch (e) {
            if (req.signal?.aborted) throw e;
            reason = (e as Error).message;
            const oe = e instanceof OmniRouteError ? e : null;
            if (oe?.retryInMs != null) {
              retryIn = oe.retryInMs;
              // o grátis mais próximo volta logo: vale esperar em vez de pagar
              if (retryIn <= WAIT_MAX_MS() && round < MAX_WAIT_ROUNDS) {
                if (retryIn > 0) {
                  notice?.(`Modelos grátis em espera; ${oe.nextModel} volta em ${fmtWait(retryIn)} — esperando em vez de usar a reserva paga`);
                  await sleep(retryIn + 300, req.signal);
                }
                continue;
              }
            } else {
              downUntil = Date.now() + RETEST_MS();
              notice?.(`OmniRoute indisponível (${reason.slice(0, 200)}); testo de novo às ${time(downUntil)}`);
            }
          }
        } else reason = `OmniRoute indisponível; novo teste às ${time(downUntil)}`;
        return useBackup(req, reason, retryIn);
      }
    },
  };
  return p;
}
