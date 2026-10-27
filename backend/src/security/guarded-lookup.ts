import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { isPublicIp } from "./ip.js";

export class BlockedTargetError extends Error {
  readonly code = "PULSE_BLOCKED_TARGET";
  constructor(message = "target not allowed") {
    super(message);
    this.name = "BlockedTargetError";
  }
}

export type Resolver = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/**
 * `lookup` para sockets (http/https.request). Resolve o nome, valida TODOS os
 * endereços devolvidos e entrega ao socket exatamente os endereços validados.
 * Como a conexão usa o resultado desta mesma resolução, não existe uma segunda
 * consulta de DNS entre "validar" e "conectar" (fecha a janela de DNS rebinding).
 */
export function createGuardedLookup(opts: { resolver?: Resolver; trustedHosts?: string[] } = {}): LookupFunction {
  const resolver: Resolver = opts.resolver ?? ((h, o, cb) => dns.lookup(h, o, cb));

  return (hostname, options, callback) => {
    resolver(hostname, { all: true, family: options.family, hints: options.hints }, (err, addresses) => {
      if (err) return (callback as (e: Error) => void)(err);
      if (addresses.length === 0) {
        const e: NodeJS.ErrnoException = new Error("no addresses");
        e.code = "ENOTFOUND";
        return (callback as (e: Error) => void)(e);
      }
      // Basta um endereço interno para recusar: evita "misturar" IP público com interno.
      if (!opts.trustedHosts?.includes(hostname) && addresses.some((a) => !isPublicIp(a.address))) {
        return (callback as (e: Error) => void)(new BlockedTargetError());
      }
      if (options.all) {
        return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
      }
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    });
  };
}
