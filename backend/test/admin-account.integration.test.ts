import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminAccountError, createAdminAccount, resetAdminPassword } from "../src/auth/admin-account.js";
import { ADMIN_PASSWORD, ADMIN_USER, TEST_DB_URL, resetDb, setup, type Ctx } from "./helpers.js";

describe.skipIf(!TEST_DB_URL)("conta de administrador única (PostgreSQL real)", () => {
  let c: Ctx;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(() => resetDb(c.db));

  it("cria a conta guardando só um hash scrypt", async () => {
    await createAdminAccount(c.db, "Admin", ADMIN_PASSWORD);
    const row = await c.db.adminUser.findFirstOrThrow();
    expect(row.username).toBe("admin");
    expect(row.passwordHash).toMatch(/^scrypt\$/);
    expect(row.passwordHash).not.toContain(ADMIN_PASSWORD);
  });

  it("recusa uma segunda conta", async () => {
    await createAdminAccount(c.db, ADMIN_USER, ADMIN_PASSWORD);
    await expect(createAdminAccount(c.db, "outro", ADMIN_PASSWORD)).rejects.toBeInstanceOf(AdminAccountError);
    expect(await c.db.adminUser.count()).toBe(1);
  });

  it("o banco impede a 2ª conta mesmo contornando a aplicação", async () => {
    await createAdminAccount(c.db, ADMIN_USER, ADMIN_PASSWORD);
    await expect(c.db.adminUser.create({ data: { username: "intruso", passwordHash: "x" } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("duas criações simultâneas resultam em exatamente uma conta", async () => {
    const results = await Promise.allSettled([
      createAdminAccount(c.db, "um", ADMIN_PASSWORD),
      createAdminAccount(c.db, "dois", ADMIN_PASSWORD),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await c.db.adminUser.count()).toBe(1);
  });

  it.each([["curta123"], ["x".repeat(129)]])("senha fora da política é recusada (%s)", async (pw) => {
    await expect(createAdminAccount(c.db, ADMIN_USER, pw)).rejects.toThrow();
    expect(await c.db.adminUser.count()).toBe(0);
  });

  it("recusa senha que contém o usuário e usuário inválido", async () => {
    await expect(createAdminAccount(c.db, "gustavo", "gustavo-senha-longa")).rejects.toBeInstanceOf(AdminAccountError);
    await expect(createAdminAccount(c.db, "a b", ADMIN_PASSWORD)).rejects.toThrow();
  });

  it("reset-password sem conta existente falha com mensagem clara", async () => {
    await expect(resetAdminPassword(c.db, ADMIN_PASSWORD)).rejects.toBeInstanceOf(AdminAccountError);
  });
});
