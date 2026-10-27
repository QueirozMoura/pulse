import { describe, expect, it } from "vitest";
import { appendOlder, mergeLatest } from "../src/lib/history";
import { errorKindLabel, formatAgo, formatDuration, formatLatency, formatPercent } from "../src/lib/format";
import { check } from "./fixtures";

describe("formatação", () => {
  it.each([[3, "agora mesmo"], [12, "há 12 s"], [75, "há 1 min"], [7200, "há 2 h"], [3 * 86_400, "há 3 d"], [-5, "agora mesmo"]])("formatAgo(%i)", (s, out) => expect(formatAgo(s)).toBe(out));
  it.each([[62, "1 min 2 s"], [45, "45 s"], [7500, "2 h 5 min"]])("formatDuration(%i)", (s, out) => expect(formatDuration(s)).toBe(out));
  it("latência e percentual em pt-BR; null nunca vira número", () => {
    expect(formatLatency(65)).toBe("65 ms");
    expect(formatLatency(1250)).toBe("1,25 s");
    expect(formatPercent(99.98)).toBe("99,98%");
    expect(formatPercent(100)).toBe("100%");
    expect(formatPercent(null)).toBe("Sem dados");
  });
  it("categoria de erro: rótulo humano, desconhecida cai no genérico, null vira vazio", () => {
    expect(errorKindLabel("dns")).toBe("Falha de DNS");
    expect(errorKindLabel("nova-categoria")).toBe("Falha não classificada");
    expect(errorKindLabel(null)).toBe("");
  });
});

describe("histórico paginado", () => {
  const page = (...agos: number[]) => ({ checks: agos.map((a) => check(a)), nextCursor: "c" });
  it("sem estado anterior usa a página recebida", () => {
    expect(mergeLatest(null, page(10, 20)).checks).toHaveLength(2);
  });
  it("novas checagens entram no topo, sem perder as antigas já carregadas e mantendo o cursor das antigas", () => {
    const cur = { checks: [check(30_000), check(60_000), check(90_000), check(120_000)], nextCursor: "antigas" };
    const merged = mergeLatest(cur, { checks: [check(0), check(30_000), check(60_000)], nextCursor: "novo" });
    expect(merged.checks).toHaveLength(5);
    expect(merged.checks[0]!.checkedAt).toBe(check(0).checkedAt);
    expect(merged.nextCursor).toBe("antigas");
  });
  it("sem novidades não duplica", () => {
    const cur = { checks: [check(30_000), check(60_000)], nextCursor: null };
    expect(mergeLatest(cur, { checks: [check(30_000), check(60_000)], nextCursor: null }).checks).toHaveLength(2);
  });
  it("se a página nova não encosta no que já havia (lacuna), recomeça dela para não deixar buraco", () => {
    const cur = { checks: [check(900_000), check(930_000)], nextCursor: "antigas" };
    const latest = { checks: [check(0), check(30_000)], nextCursor: "novo" };
    expect(mergeLatest(cur, latest)).toEqual(latest);
  });
  it("appendOlder acrescenta ao final, sem repetir, e adota o novo cursor", () => {
    const cur = { checks: [check(0), check(30_000)], nextCursor: "a" };
    const out = appendOlder(cur, { checks: [check(30_000), check(60_000)], nextCursor: null });
    expect(out.checks).toHaveLength(3);
    expect(out.nextCursor).toBeNull();
  });
});
