import type { FastifyBaseLogger } from "fastify";

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  /** Chave de idempotência do provedor (id do evento): reenviar a mesma chave não gera outro e-mail. */
  idempotencyKey: string;
}

export type SendFailureKind = "timeout" | "network" | "rate_limited" | "unauthorized" | "rejected" | "server_error" | "unknown";

export type SendResult = { ok: true; messageId: string | null } | { ok: false; kind: SendFailureKind; httpStatus?: number };

export interface EmailTransport {
  send(msg: EmailMessage): Promise<SendResult>;
}

export const RESEND_API_URL = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 15_000;

/**
 * Resend via API HTTPS (fetch nativo). O corpo de erro do provedor é ignorado de propósito:
 * só o status HTTP vira uma categoria, então nada do que o provedor devolver chega ao banco ou ao log.
 */
export function createResendTransport(apiKey: string, opts: { url?: string; timeoutMs?: number } = {}): EmailTransport {
  const url = opts.url ?? RESEND_API_URL;
  return {
    async send(msg) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": msg.idempotencyKey,
          },
          body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        return { ok: false, kind: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
      }

      if (res.ok) {
        let messageId: string | null = null;
        try {
          const body = (await res.json()) as { id?: unknown };
          if (typeof body.id === "string") messageId = body.id.slice(0, 100);
        } catch {
          /* resposta 2xx sem JSON: o e-mail foi aceito mesmo assim */
        }
        return { ok: true, messageId };
      }
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 429) return { ok: false, kind: "rate_limited", httpStatus: 429 };
      if (res.status === 401 || res.status === 403) return { ok: false, kind: "unauthorized", httpStatus: res.status };
      if (res.status >= 500) return { ok: false, kind: "server_error", httpStatus: res.status };
      return { ok: false, kind: "rejected", httpStatus: res.status };
    },
  };
}

/** Modo de desenvolvimento: nada sai da máquina; o e-mail renderizado vai para o log. */
export function createLogTransport(log: FastifyBaseLogger): EmailTransport {
  return {
    async send(msg) {
      log.info({ to: msg.to, subject: msg.subject, text: msg.text, idempotencyKey: msg.idempotencyKey }, "alert email (log only, NOT sent)");
      return { ok: true, messageId: null };
    },
  };
}
