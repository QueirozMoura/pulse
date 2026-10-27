/**
 * CLI da conta de administrador (conta única).
 *
 *   npm run admin -- create --username <usuario>
 *   npm run admin -- reset-password
 *
 * A senha NUNCA vem de argumento ou variável de ambiente (apareceria em histórico/`ps`):
 * é lida de um prompt oculto no terminal ou, sem TTY, da primeira linha do stdin.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { ZodError } from "zod";
import { AdminAccountError, createAdminAccount, resetAdminPassword } from "../auth/admin-account.js";
import { createDb } from "../lib/db.js";

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: out, terminal: process.stdin.isTTY });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
    muted = hidden; // o texto da pergunta já foi escrito; o que for digitado não ecoa
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    // sem terminal: uma linha no stdin (ex.: gerenciador de segredos | npm run admin -- create ...)
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) return line;
    return "";
  }
  const first = await ask("Senha (mín. 12 caracteres): ", true);
  const second = await ask("Repita a senha: ", true);
  if (first !== second) throw new AdminAccountError("as senhas não coincidem");
  return first;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "create" && command !== "reset-password") {
    console.error("Uso: admin create --username <usuario> | admin reset-password");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new AdminAccountError("DATABASE_URL não definida");

  const db = createDb(url);
  try {
    if (command === "create") {
      const username = flag("username");
      if (!username) throw new AdminAccountError("informe --username");
      await createAdminAccount(db, username, await readPassword());
      console.log(`Administrador "${username.toLowerCase()}" criado.`);
    } else {
      const username = await resetAdminPassword(db, await readPassword());
      console.log(`Senha de "${username}" redefinida e todas as sessões encerradas.`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  if (err instanceof AdminAccountError) console.error(`Erro: ${err.message}`);
  else if (err instanceof ZodError) console.error(`Erro: ${err.issues.map((i) => i.message).join("; ")}`);
  else console.error("Erro inesperado:", err instanceof Error ? err.message : err);
  process.exit(1);
});
