import { z } from "zod";

/**
 * Cursor de paginação opaco: (timestamp, id) da última linha entregue. O id desempata linhas com o
 * mesmo timestamp, então nenhuma linha é pulada ou repetida, e o cursor continua válido se a linha for apagada.
 */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

export interface Cursor {
  at: Date;
  id: string;
}

export const cursorSchema = z
  .string()
  .max(120)
  .transform((raw, ctx): Cursor => {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    const at = new Date(iso ?? "");
    if (!iso || !id || Number.isNaN(at.getTime()) || !z.uuid().safeParse(id).success) {
      ctx.addIssue({ code: "custom", message: "cursor inválido" });
      return z.NEVER;
    }
    return { at, id };
  });

/** Busca limit+1 linhas para saber se há próxima página, sem uma segunda consulta de contagem. */
export function paginate<T>(rows: T[], limit: number, cursorOf: (row: T) => string): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? cursorOf(last) : null };
}
