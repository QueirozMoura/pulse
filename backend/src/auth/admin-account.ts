import { z } from "zod";
import type { Db } from "../lib/db.js";
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN } from "./password.js";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._@-]{3,64}$/, "usuário: 3-64 caracteres entre a-z, 0-9, . _ @ -");

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN, `a senha deve ter ao menos ${PASSWORD_MIN} caracteres`)
  .max(PASSWORD_MAX, `a senha deve ter no máximo ${PASSWORD_MAX} caracteres`);

export class AdminAccountError extends Error {}

/** Cria a conta única. Falha se já existir uma (também garantido por índice no banco). */
export async function createAdminAccount(db: Db, rawUsername: string, password: string): Promise<void> {
  const username = usernameSchema.parse(rawUsername);
  newPasswordSchema.parse(password);
  if (password.toLowerCase().includes(username)) throw new AdminAccountError("a senha não pode conter o usuário");

  if ((await db.adminUser.count()) > 0) {
    throw new AdminAccountError("já existe uma conta de administrador; use reset-password");
  }
  try {
    await db.adminUser.create({ data: { username, passwordHash: await hashPassword(password) } });
  } catch (err) {
    // corrida entre dois "create": o índice único é a palavra final
    if ((err as { code?: string }).code === "P2002") throw new AdminAccountError("já existe uma conta de administrador");
    throw err;
  }
}

/** Troca a senha da conta única e encerra todas as sessões abertas. */
export async function resetAdminPassword(db: Db, password: string): Promise<string> {
  newPasswordSchema.parse(password);
  const admin = await db.adminUser.findFirst();
  if (!admin) throw new AdminAccountError("nenhuma conta de administrador; use create");
  if (password.toLowerCase().includes(admin.username)) throw new AdminAccountError("a senha não pode conter o usuário");
  const passwordHash = await hashPassword(password);
  await db.$transaction([
    db.adminUser.update({ where: { id: admin.id }, data: { passwordHash } }),
    db.session.deleteMany({ where: { adminId: admin.id } }),
    db.loginFailure.deleteMany(),
  ]);
  return admin.username;
}
