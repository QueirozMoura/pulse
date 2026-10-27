import { isIP } from "node:net";
import { z } from "zod";
import { isPublicIp } from "../security/ip.js";

/**
 * Checagem sintática do host (sem DNS): localhost, sufixos internos e IPs privados/reservados.
 * A defesa real contra DNS que aponta para rede interna fica no momento da conexão
 * (security/guarded-lookup.ts); isto apenas rejeita cedo o que é óbvio.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|corp|intranet|private)$/.test(host)) return false;
  if (isIP(host)) return isPublicIp(host);
  return true;
}

export const monitorUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => URL.canParse(v), "URL inválida")
  .transform((v) => new URL(v))
  .refine((u) => u.protocol === "https:", "A URL deve usar HTTPS")
  .refine((u) => u.username === "" && u.password === "", "A URL não pode conter credenciais")
  .refine((u) => isPublicHostname(u.hostname), "Host não permitido")
  .transform((u) => u.toString());
