import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../lib/db.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { resolveSession, type ActiveSession } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Preenchido pelo guard de autenticação; nulo em rotas públicas. */
    session: ActiveSession | null;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function sessionCookieName(config: Pick<Config, "NODE_ENV">): string {
  // O prefixo __Host- obriga Secure + Path=/ + sem Domain: o navegador recusa o cookie se algo estiver errado.
  return config.NODE_ENV === "production" ? "__Host-pulse_session" : "pulse_session";
}

export function cookieOptions(config: Config, expires: Date) {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: config.SESSION_COOKIE_SAMESITE,
    path: "/",
    expires,
  } as const;
}

/** Rejeita requisições com cabeçalho Origin que não seja o próprio servidor nem o frontend configurado. */
export function assertAllowedOrigin(req: FastifyRequest, config: Config): void {
  const origin = req.headers.origin;
  if (!origin) return; // clientes não-navegador; navegadores sempre enviam Origin em POST/PATCH/DELETE
  const allowed = new Set<string>([`${req.protocol}://${req.headers.host}`]);
  if (config.CORS_ALLOWED_ORIGIN) allowed.add(new URL(config.CORS_ALLOWED_ORIGIN).origin);
  if (!allowed.has(origin)) throw forbidden("origin_not_allowed", "Origem não permitida");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function createGuards(db: Db, config: Config) {
  const cookieName = sessionCookieName(config);

  /** onRequest: exige sessão válida (cookie → hash no banco → não expirada). */
  async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = req.cookies[cookieName];
    const session = token ? await resolveSession(db, token) : null;
    if (!session) throw unauthorized();
    req.session = session;
  }

  /** onRequest (depois de authenticate): CSRF nas operações que alteram estado. */
  async function csrf(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (SAFE_METHODS.has(req.method)) return;
    assertAllowedOrigin(req, config);
    const header = req.headers["x-csrf-token"];
    const sent = Array.isArray(header) ? header[0] : header;
    if (!req.session || !sent || !safeEqual(sent, req.session.csrfToken)) {
      throw forbidden("csrf", "Token CSRF ausente ou inválido");
    }
  }

  return { authenticate, csrf, cookieName };
}
