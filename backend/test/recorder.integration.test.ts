import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordCheck } from "../src/services/check-recorder.js";
import { TEST_DB_URL, down, mkMonitors, ok, resetDb, setup, type Ctx } from "./helpers.js";

const at = (ms: number) => new Date(Date.UTC(2026, 9, 27, 12, 0, 0) + ms);

describe.skipIf(!TEST_DB_URL)("gravação de checagens: resultados atrasados e concorrentes (PostgreSQL real)", () => {
  let c: Ctx;
  let id: string;
  let url: string;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(async () => {
    await resetDb(c.db);
    const [m] = await mkMonitors(c.db, 1);
    id = m!.id;
    url = m!.url;
  });

  const rec = (o: typeof ok | typeof down, ms: number, u = url) => recordCheck(c.db, id, o, { url: u, startedAt: at(ms) });
  const state = () => c.db.monitor.findUniqueOrThrow({ where: { id } });
  const incidents = () => c.db.incident.findMany({ where: { monitorId: id }, orderBy: { startedAt: "asc" } });

  it("duas falhas abrem UM incidente, com o horário da 2ª falha; um sucesso o resolve com o horário do sucesso", async () => {
    await rec(down, 0);
    expect(await incidents()).toHaveLength(0);
    await rec(down, 1000);
    await rec(down, 2000);
    let inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0]!.startedAt).toEqual(at(1000));
    expect(inc[0]!.resolvedAt).toBeNull();

    await rec(ok, 3000);
    inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0]!.resolvedAt).toEqual(at(3000));
    expect((await state()).status).toBe("OPERATIONAL");
  });

  it("checagem registrada com o horário em que COMEÇOU, não o da gravação", async () => {
    await rec(ok, -60_000);
    const row = await c.db.checkResult.findFirstOrThrow({ where: { monitorId: id } });
    expect(row.checkedAt).toEqual(at(-60_000));
  });

  it("resultado atrasado (mais antigo) entra no histórico mas NÃO altera estado nem reabre incidente", async () => {
    await rec(down, 0);
    await rec(down, 1000); // incidente aberto
    await rec(ok, 5000); // resolvido
    expect(await rec(down, 2000)).toBe("recorded_stale"); // falha antiga chegando tarde

    const s = await state();
    expect(s.status).toBe("OPERATIONAL");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastCheckedAt).toEqual(at(5000));
    const inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0]!.resolvedAt).toEqual(at(5000));
    expect(await c.db.checkResult.count({ where: { monitorId: id } })).toBe(4); // histórico completo
  });

  it("sucesso antigo atrasado não resolve um incidente novo", async () => {
    await rec(down, 1000);
    await rec(down, 2000); // incidente
    expect(await rec(ok, 500)).toBe("recorded_stale");
    expect((await state()).status).toBe("UNAVAILABLE");
    expect((await incidents())[0]!.resolvedAt).toBeNull();
  });

  it("monitor pausado durante a checagem: resultado descartado, sem incidente", async () => {
    await rec(down, 0);
    await c.db.monitor.update({ where: { id }, data: { active: false } });
    expect(await rec(down, 1000)).toBe("discarded");
    expect(await incidents()).toHaveLength(0);
    expect(await c.db.checkResult.count()).toBe(1);
  });

  it("URL editada durante a checagem: resultado da URL antiga é descartado", async () => {
    await c.db.monitor.update({ where: { id }, data: { url: "https://nova.example.com/" } });
    expect(await rec(down, 0, url)).toBe("discarded");
    expect(await c.db.checkResult.count()).toBe(0);
  });

  it("monitor excluído durante a checagem: não lança erro e não grava nada", async () => {
    await c.db.monitor.delete({ where: { id } });
    expect(await rec(down, 0)).toBe("discarded");
    expect(await c.db.checkResult.count()).toBe(0);
  });

  it("falhas concorrentes (checagens do mesmo monitor sobrepostas) nunca geram incidentes duplicados", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => rec(down, i * 100)));
    const inc = await incidents();
    const s = await state();
    expect(await c.db.checkResult.count({ where: { monitorId: id } })).toBe(12);
    expect(inc.length).toBeLessThanOrEqual(1);
    expect(inc.filter((i) => i.resolvedAt === null).length).toBe(s.status === "UNAVAILABLE" ? 1 : 0);
  });

  it("falhas e sucessos concorrentes mantêm o invariante: incidente aberto ⇔ indisponível, no máximo um aberto", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => rec(i % 3 === 0 ? ok : down, i * 50)));
    const s = await state();
    const open = (await incidents()).filter((i) => i.resolvedAt === null);
    expect(open.length).toBeLessThanOrEqual(1);
    expect(open.length === 1).toBe(s.status === "UNAVAILABLE");
  });

  it("o banco recusa dois incidentes abertos para o mesmo monitor", async () => {
    await c.db.incident.create({ data: { monitorId: id } });
    await expect(c.db.incident.create({ data: { monitorId: id } })).rejects.toMatchObject({ code: "P2002" });
  });
});
