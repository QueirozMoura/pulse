import type { ValidationIssue } from "./types";

/** URL base da API. Em desenvolvimento, o padrão é o backend local; em produção, defina VITE_API_URL (ou "" para mesma origem). */
export const API_BASE: string = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "http://localhost:3000" : "")).replace(/\/+$/, "");

/**
 * Erro de chamada à API. `code` é o campo `error` do contrato (estável); `network` indica que nem houve resposta.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly issues: ValidationIssue[] = [],
    /** Só existe se o navegador puder ler o cabeçalho Retry-After (exige CORS expose-headers no backend). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get network(): boolean {
    return this.status === 0;
  }
}

/**
 * Token CSRF da sessão atual. Fica SÓ em memória (variável do módulo): nunca em localStorage/sessionStorage/cookie
 * legível. Depois de recarregar a página ele é recuperado com GET /auth/session.
 */
let csrfToken: string | null = null;
export const csrf = {
  set(token: string) {
    csrfToken = token;
  },
  clear() {
    csrfToken = null;
  },
  get() {
    return csrfToken;
  },
};

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Rotas públicas não levam cookie (credentials "omit"); o resto leva (credentials "include"), como pede o API.md. */
const isPublicPath = (path: string) => path === "/health" || path.startsWith("/public/");

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") qs.set(k, String(v));
  const url = `${API_BASE}${path}${qs.size > 0 ? `?${qs}` : ""}`;

  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (!SAFE.has(method) && csrfToken) headers["x-csrf-token"] = csrfToken;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: isPublicPath(path) ? "omit" : "include",
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Não foi possível conectar à API.");
  }

  if (res.status === 204) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* corpo vazio ou não-JSON */
  }

  if (!res.ok) {
    const b = (payload ?? {}) as { error?: string; message?: string; requestId?: string; issues?: ValidationIssue[] };
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ApiError(
      res.status,
      b.error ?? `http_${res.status}`,
      b.message ?? "Erro inesperado.",
      b.requestId,
      Array.isArray(b.issues) ? b.issues : [],
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return payload as T;
}
