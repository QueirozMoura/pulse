import { defineConfig } from "vitest/config";

export default defineConfig({
  // Os testes com banco compartilham as mesmas tabelas: arquivos rodam em sequência.
  test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 20_000 },
});
