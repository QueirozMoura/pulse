import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Rede de segurança: mesmo que alguém exporte chaves reais no shell, a suíte nunca envia e-mail.
    env: { ALERT_DELIVERY: "off", RESEND_API_KEY: "", ALERT_EMAIL_TO: "", ALERT_EMAIL_FROM: "" },
    include: ["test/**/*.test.ts"],
    // Os testes com banco compartilham as mesmas tabelas: arquivos rodam em sequência.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
