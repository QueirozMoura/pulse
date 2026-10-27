import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

export type Db = PrismaClient;

export interface DbOptions {
  /** Conexões simultâneas no pool. */
  max?: number;
  /** Tempo para obter uma conexão. Folgado de propósito: um banco com escala-a-zero (Neon) leva alguns segundos para acordar. */
  connectionTimeoutMs?: number;
  /** Tempo máximo de uma consulta no servidor (statement_timeout). Impede que uma consulta travada prenda um processo curto. */
  statementTimeoutMs?: number;
}

export function createDb(connectionString: string, opts: DbOptions = {}): Db {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: opts.max ?? 10,
      connectionTimeoutMillis: opts.connectionTimeoutMs ?? 20_000,
      idleTimeoutMillis: 30_000,
      ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
    }),
  });
}
