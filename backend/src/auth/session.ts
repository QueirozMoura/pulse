import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../lib/db.js";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");

export interface CreatedSession {
  token: string; // vai para o cookie; nunca é guardado
  csrfToken: string;
  expiresAt: Date;
}

export interface ActiveSession {
  id: string;
  adminId: string;
  username: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(db: Db, adminId: string, ttlHours: number): Promise<CreatedSession> {
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await db.session.create({ data: { id: sha256(token), adminId, csrfToken, expiresAt } });
  return { token, csrfToken, expiresAt };
}

export async function resolveSession(db: Db, token: string): Promise<ActiveSession | null> {
  const row = await db.session.findUnique({ where: { id: sha256(token) }, include: { admin: true } });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.session.delete({ where: { id: row.id } }).catch(() => undefined);
    return null;
  }
  return { id: row.id, adminId: row.adminId, username: row.admin.username, csrfToken: row.csrfToken, expiresAt: row.expiresAt };
}

export async function destroySession(db: Db, sessionId: string): Promise<void> {
  await db.session.deleteMany({ where: { id: sessionId } });
}

/** Limpeza oportunista de sessões vencidas. */
export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}
