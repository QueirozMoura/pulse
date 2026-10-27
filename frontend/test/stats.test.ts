import { describe, expect, it } from "vitest";
import type { Incident } from "../src/api/types";
import { incidentBands, latencyStats, percentile } from "../src/lib/stats";
import { check, iso } from "./fixtures";

describe("percentis e estatísticas de latência", () => {
  it("percentil por interpolação linear", () => {
    expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(percentile([10, 20], 0.5)).toBe(15);
    expect(percentile([100], 0.95)).toBe(100);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("só checagens bem-sucedidas entram: o tempo até falhar não é latência de resposta", () => {
    const s = latencyStats([check(1000, { latencyMs: 50 }), check(2000, { latencyMs: 70 }), check(3000, { latencyMs: 10_000, success: false, statusCode: null, errorKind: "timeout" }), check(4000, { latencyMs: 90 })]);
    expect(s).toEqual({ samples: 3, median: 70, p95: 88, max: 90 });
  });

  it("sem nenhuma checagem bem-sucedida não há estatística (null, nunca zero)", () => {
    expect(latencyStats([])).toBeNull();
    expect(latencyStats([check(1000, { success: false, statusCode: null, errorKind: "dns" })])).toBeNull();
  });
});

describe("faixas de incidente no gráfico", () => {
  const inc = (id: string, startAgo: number, endAgo: number | null): Incident => ({
    id, monitorId: "m", monitorName: "M", status: endAgo === null ? "open" : "resolved",
    startedAt: iso(startAgo), resolvedAt: endAgo === null ? null : iso(endAgo), durationSeconds: endAgo === null ? null : (startAgo - endAgo) / 1000,
  });
  const from = Date.parse(iso(600_000));
  const to = Date.parse(iso(0));

  it("incidente resolvido dentro da janela vira uma faixa início→fim", () => {
    const [b] = incidentBands([inc("a", 300_000, 240_000)], from, to);
    expect(b).toMatchObject({ start: Date.parse(iso(300_000)), end: Date.parse(iso(240_000)), open: false });
  });
  it("incidente aberto vai até o fim da janela", () => {
    expect(incidentBands([inc("a", 120_000, null)], from, to)[0]).toMatchObject({ end: to, open: true });
  });
  it("recorta o que começou antes da janela e descarta o que ficou fora dela", () => {
    const bands = incidentBands([inc("antes", 900_000, 500_000), inc("fora", 2_000_000, 1_900_000), inc("depois", 0, null)], from, to);
    expect(bands.map((b) => b.incidentId)).toEqual(["antes", "depois"]);
    expect(bands[0]!.start).toBe(from);
  });
});
