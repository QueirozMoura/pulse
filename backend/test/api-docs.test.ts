import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/lib/db.js";

const docs = readFileSync(new URL("../docs/API.md", import.meta.url), "utf8");

/** Rotas documentadas: títulos `### \`MÉTODO /caminho\`` (um título pode listar várias, separadas por " e "). */
function documentedRoutes(): Set<string> {
  const found = new Set<string>();
  for (const line of docs.split("\n")) {
    if (!line.startsWith("### ")) continue;
    for (const m of line.matchAll(/`((?:GET|POST|PATCH|DELETE) \/\S*)`/g)) found.add(m[1]!);
  }
  return found;
}

describe("docs/API.md acompanha o código", () => {
  const app = buildApp(loadConfig({ DATABASE_URL: "postgresql://x@localhost/x", LOG_LEVEL: "silent" }), {} as Db);

  it("toda rota registrada está documentada, e toda rota documentada existe", async () => {
    await app.ready();
    const registered = new Set(app.routeTable.map((r) => `${r.method} ${r.url}`));
    const documented = documentedRoutes();
    expect([...registered].filter((r) => !documented.has(r)).sort(), "rotas sem documentação").toEqual([]);
    expect([...documented].filter((r) => !registered.has(r)).sort(), "rotas documentadas que não existem").toEqual([]);
  });

  it("a tabela-resumo lista as mesmas rotas", () => {
    const summary = docs.split("## 2. Resumo das rotas")[1]!.split("## 3.")[0]!;
    const inSummary = new Set([...summary.matchAll(/\| `((?:GET|POST|PATCH|DELETE) \/\S*)` \|/g)].map((m) => m[1]!));
    expect(inSummary).toEqual(documentedRoutes());
  });

  it("todos os códigos de erro emitidos pelo servidor estão no catálogo", () => {
    const catalog = docs.split("## 6. Catálogo de erros")[1]!.split("## 7.")[0]!;
    const emitted = ["validation_error", "bad_request", "unauthorized", "invalid_credentials", "csrf", "origin_not_allowed", "not_found",
      "monitor_limit_reached", "payload_too_large", "unsupported_media_type", "too_many_attempts", "internal_error"];
    for (const code of emitted) expect(catalog, code).toContain(`\`${code}\``);
  });

  it("os exemplos de erro da documentação têm o formato padrão", () => {
    const blocks = [...docs.matchAll(/HTTP\/1\.1 (?:4\d\d|5\d\d) [^\n]*\n(?:[a-z-]+: [^\n]*\n)*\n(\{[^`]*?\})\n```/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(8);
    for (const [, json] of blocks) {
      const body = JSON.parse(json!);
      expect(body, json).toMatchObject({ error: expect.any(String), message: expect.any(String), requestId: expect.any(String) });
    }
  });

  it("os exemplos não contêm segredos reais", () => {
    expect(docs).not.toMatch(/uma senha de exemplo|pulse_session=(?!<token>)[A-Za-z0-9_-]{20,}/);
  });
});
