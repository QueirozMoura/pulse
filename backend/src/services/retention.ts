import type { Db } from "../lib/db.js";

/**
 * Apaga checagens mais antigas que `days`, em lotes (não trava a tabela nem estoura memória
 * se houver muito para limpar). Devolve quantas linhas foram removidas.
 */
export async function purgeOldChecks(db: Db, days: number, batchSize = 5000): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  let total = 0;
  for (;;) {
    const rows = await db.checkResult.findMany({
      where: { checkedAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (rows.length === 0) return total;
    const { count } = await db.checkResult.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    total += count;
    if (rows.length < batchSize) return total;
  }
}
