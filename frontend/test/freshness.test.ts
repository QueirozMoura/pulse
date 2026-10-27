import { describe, expect, it } from "vitest";
import { estimateIntervalSeconds, isCheckStale, isFetchStale, summarize } from "../src/lib/freshness";
import { NOW, iso, liveMonitor, mkMonitor } from "./fixtures";

const sum = (monitors: ReturnType<typeof mkMonitor>[] | null, o: Partial<Parameters<typeof summarize>[0]> = {}) =>
  summarize({ monitors, failing: false, fetchStale: false, serverNowMs: NOW, ...o });

describe("frescor das checagens", () => {
  it("estima a cadência pela amostra de 24 h (2880 checagens ≈ 30 s)", () => {
    expect(estimateIntervalSeconds(liveMonitor("operational"), NOW)).toBeCloseTo(30, 0);
  });
  it("sem amostra suficiente não estima", () => {
    expect(estimateIntervalSeconds(mkMonitor({ state: "operational" }), NOW)).toBeNull();
  });
  it("checagem em dia não é atrasada; com 10 min de atraso numa cadência de 30 s é", () => {
    expect(isCheckStale(liveMonitor("operational", 20_000), NOW)).toBe(false);
    expect(isCheckStale(liveMonitor("operational", 600_000), NOW)).toBe(true);
  });
  it("tolera 3 intervalos (mínimo 2 min) antes de acusar atraso", () => {
    expect(isCheckStale(liveMonitor("operational", 100_000), NOW)).toBe(false);
    expect(isCheckStale(liveMonitor("operational", 130_000), NOW)).toBe(true);
  });
  it("sem estimativa, só acusa depois de 1 h (cabem várias rodadas de 15 min, mesmo atrasadas)", () => {
    const m = (agoMs: number) => mkMonitor({ state: "operational", lastCheck: { checkedAt: iso(agoMs), success: true, statusCode: 200, latencyMs: 5, errorKind: null } });
    expect(isCheckStale(m(40 * 60_000), NOW)).toBe(false);
    expect(isCheckStale(m(61 * 60_000), NOW)).toBe(true);
  });
  it("pausado e sem-dados nunca são 'atrasados'", () => {
    expect(isCheckStale(mkMonitor({ state: "paused", lastCheck: { checkedAt: iso(9e8), success: true, statusCode: 200, latencyMs: 1, errorKind: null } }), NOW)).toBe(false);
    expect(isCheckStale(mkMonitor({ state: "no_data" }), NOW)).toBe(false);
  });
  it("busca desatualizada depois de 3 ciclos perdidos", () => {
    expect(isFetchStale(NOW - 60_000, NOW)).toBe(false);
    expect(isFetchStale(NOW - 100_000, NOW)).toBe(true);
    expect(isFetchStale(null, NOW)).toBe(true);
  });
});

describe("resumo geral: 'tudo operacional' só quando é verdade", () => {
  it("carregando e erro inicial", () => {
    expect(sum(null).tone).toBe("loading");
    expect(sum(null, { failing: true }).tone).toBe("error");
  });
  it("lista vazia não é 'operacional'", () => {
    expect(sum([]).tone).toBe("empty");
  });
  it("todos operacionais e frescos → ok", () => {
    expect(sum([liveMonitor("operational"), liveMonitor("operational")])).toMatchObject({ tone: "ok", headline: "Todos os sistemas estão operacionais" });
  });
  it("com pausados, diz 'ativos' e avisa que os pausados não são checados", () => {
    const s = sum([liveMonitor("operational"), mkMonitor({ state: "paused" })]);
    expect(s).toMatchObject({ tone: "ok", headline: "Todos os sistemas ativos estão operacionais" });
    expect(s.detail).toContain("pausado");
  });
  it("qualquer indisponível → down, com contagem", () => {
    expect(sum([liveMonitor("operational"), liveMonitor("unavailable")])).toMatchObject({ tone: "down", headline: "1 sistema com problema" });
    expect(sum([liveMonitor("unavailable"), liveMonitor("unavailable")]).headline).toBe("2 sistemas com problema");
  });
  it("dados desatualizados vencem 'operacional': nunca mostra verde com dado velho", () => {
    const s = sum([liveMonitor("operational")], { fetchStale: true, lastSuccessLabel: "11:55:00" });
    expect(s.tone).toBe("stale");
    expect(s.headline).toBe("Dados desatualizados");
    expect(s.detail).toContain("11:55:00");
  });
  it("dado velho com sistema fora do ar lembra o último estado conhecido", () => {
    expect(sum([liveMonitor("unavailable")], { fetchStale: true }).detail).toContain("Último estado conhecido: 1 sistema com problema");
  });
  it("checagem atrasada → 'late', não 'ok'", () => {
    const s = sum([liveMonitor("operational", 900_000)]);
    expect(s.tone).toBe("late");
    expect(s.detail).toContain("Não dá para afirmar que está tudo bem");
  });
  it("sistema sem dados impede o 'ok'", () => {
    const s = sum([liveMonitor("operational"), mkMonitor({ state: "no_data", name: "Novo" })]);
    expect(s.tone).toBe("partial");
    expect(s.headline).not.toMatch(/Todos/);
  });
  it("só sem-dados/pausados → idle, nunca operacional", () => {
    expect(sum([mkMonitor({ state: "no_data" })]).tone).toBe("idle");
    expect(sum([mkMonitor({ state: "paused" })]).tone).toBe("idle");
    expect(sum([mkMonitor({ state: "paused" })]).headline).toBe("Nenhum sistema está sendo checado");
  });
});
