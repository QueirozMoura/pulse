import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

describe("hash de senha (scrypt)", () => {
  it("guarda parâmetros e salt no hash, sem a senha em claro", async () => {
    const h = await hashPassword("uma senha bem longa 123");
    expect(h).toMatch(/^scrypt\$65536\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(h).not.toContain("uma senha");
  });

  it("verifica a senha correta e rejeita a errada", async () => {
    const h = await hashPassword("uma senha bem longa 123");
    expect(await verifyPassword("uma senha bem longa 123", h)).toBe(true);
    expect(await verifyPassword("uma senha bem longa 124", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });

  it("o mesmo texto gera hashes diferentes (salt aleatório)", async () => {
    expect(await hashPassword("mesma-senha-123456")).not.toBe(await hashPassword("mesma-senha-123456"));
  });

  it.each(["", "lixo", "scrypt$1$2$3", "bcrypt$x$y$z$a$b", "scrypt$99999999999$8$1$AAAA$AAAA"])(
    "hash malformado %j nunca valida (e não explode)",
    async (stored) => {
      expect(await verifyPassword("qualquer", stored)).toBe(false);
    },
  );
});
