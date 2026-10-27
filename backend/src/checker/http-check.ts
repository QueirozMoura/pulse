import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { BlockedTargetError, createGuardedLookup, type Resolver } from "../security/guarded-lookup.js";
import { isPublicIp } from "../security/ip.js";
import { isPublicHostname } from "../domain/monitor-url.js";

export type ErrorKind =
  | "timeout"
  | "dns"
  | "connection"
  | "tls"
  | "http_status"
  | "redirect" // redirect inválido, em loop ou acima do limite
  | "blocked" // destino não permitido (rede interna, http, credenciais)
  | "unknown";

export interface CheckOutcome {
  success: boolean;
  statusCode: number | null;
  latencyMs: number;
  errorKind: ErrorKind | null;
}

export interface CheckOptions {
  timeoutMs: number;
  maxRedirects?: number;
  /** Resolver de DNS injetável (testes). Padrão: dns.lookup. */
  resolver?: Resolver;
  /** Somente para testes: relaxa as proteções para usar um servidor local. Nunca exposto por env. */
  unsafeTestOverrides?: { allowHttp?: boolean; trustedHosts?: string[] };
}

export const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA"]);
const CONNECTION_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET",
]);

class RedirectError extends Error {}

function codeOf(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  if (typeof e?.code === "string") return e.code;
  if (typeof e?.cause?.code === "string") return e.cause.code;
  return "";
}

/** Converte um erro bruto em uma categoria segura para expor. A mensagem original nunca é guardada. */
export function classifyError(err: unknown): ErrorKind {
  if (err instanceof BlockedTargetError) return "blocked";
  if (err instanceof RedirectError) return "redirect";
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  const code = codeOf(err);
  if (DNS_CODES.has(code)) return "dns";
  if (CONNECTION_CODES.has(code)) return "connection";
  if (/^(CERT_|ERR_TLS|ERR_SSL|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|HOSTNAME_MISMATCH)/.test(code)) return "tls";
  return "unknown";
}

/** Valida o destino de uma requisição (URL inicial ou de um redirect), antes de abrir qualquer conexão. */
function assertAllowedTarget(url: URL, o: NonNullable<CheckOptions["unsafeTestOverrides"]>): void {
  const protocolOk = url.protocol === "https:" || (o.allowHttp === true && url.protocol === "http:");
  if (!protocolOk) throw new BlockedTargetError("protocol not allowed");
  if (url.username !== "" || url.password !== "") throw new BlockedTargetError("credentials not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (o.trustedHosts?.includes(host)) return;
  // IP literal não passa pelo `lookup` do socket, então é checado aqui.
  if (isIP(host) ? !isPublicIp(host) : !isPublicHostname(host)) throw new BlockedTargetError("host not allowed");
}

interface Hop {
  status: number;
  location: string | undefined;
}

function requestOnce(url: URL, lookup: ReturnType<typeof createGuardedLookup>, signal: AbortSignal, allowHttp: boolean): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "http:" && allowHttp ? http : https;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { "user-agent": "Pulse-Monitor/0.1", accept: "*/*" },
        lookup,
        signal,
        agent: false, // sem keep-alive: cada hop faz sua própria resolução validada
      },
      (res) => {
        const location = res.headers.location;
        res.destroy(); // só precisamos dos cabeçalhos
        resolve({ status: res.statusCode ?? 0, location });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET com timeout total, redirects seguidos manualmente (limite + validação de
 * cada destino) e conexão apenas a IPs públicos validados.
 *
 * Sucesso = a resposta FINAL tem status < 400. Um 301 isolado não prova nada:
 * seguimos até a resposta final.
 */
export async function httpCheck(url: string, opts: CheckOptions): Promise<CheckOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const overrides = opts.unsafeTestOverrides ?? {};
  const lookup = createGuardedLookup({ resolver: opts.resolver, trustedHosts: overrides.trustedHosts });
  const signal = AbortSignal.timeout(opts.timeoutMs); // prazo único para a cadeia inteira

  const fail = (statusCode: number | null, errorKind: ErrorKind): CheckOutcome => ({
    success: false, statusCode, latencyMs: elapsed(), errorKind,
  });

  try {
    let current = new URL(url);
    const visited = new Set<string>();

    for (let hop = 0; ; hop++) {
      assertAllowedTarget(current, overrides);
      visited.add(current.href);

      const res = await requestOnce(current, lookup, signal, overrides.allowHttp === true);

      if (!REDIRECT_STATUSES.has(res.status)) {
        const ok = res.status > 0 && res.status < 400;
        return { success: ok, statusCode: res.status, latencyMs: elapsed(), errorKind: ok ? null : "http_status" };
      }

      if (hop >= maxRedirects) throw new RedirectError("too many redirects");
      if (!res.location) throw new RedirectError("redirect without location");
      let next: URL;
      try {
        next = new URL(res.location, current);
      } catch {
        throw new RedirectError("invalid location");
      }
      if (visited.has(next.href)) throw new RedirectError("redirect loop");
      current = next;
    }
  } catch (err) {
    if (signal.aborted) return fail(null, "timeout");
    return fail(null, classifyError(err));
  }
}
