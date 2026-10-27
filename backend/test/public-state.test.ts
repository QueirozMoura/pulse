import { describe, expect, it } from "vitest";
import { publicState, uptimeWindow } from "../src/domain/public-state.js";
import { cursorSchema, encodeCursor, paginate } from "../src/lib/cursor.js";

const T = new Date();

describe("publicState", () => {
  it.each([
    [{ active: true, lastCheckedAt: T, status: "OPERATIONAL" as const }, "operational"],
    [{ active: true, lastCheckedAt: T, status: "UNAVAILABLE" as const }, "unavailable"],
    [{ active: false, lastCheckedAt: T, status: "OPERATIONAL" as const }, "paused"],
    [{ active: false, lastCheckedAt: T, status: "UNAVAILABLE" as const }, "paused"],
    [{ active: false, lastCheckedAt: null, status: "OPERATIONAL" as const }, "paused"],
    [{ active: true, lastCheckedAt: null, status: "OPERATIONAL" as const }, "no_data"],
  ])("%j → %s", (m, expected) => expect(publicState(m)).toBe(expected));
});

describe("uptimeWindow", () => {
  it("sem checagens: percentual NULO (nunca 0% nem 100%)", () => {
    expect(uptimeWindow(0, 0)).toEqual({ checks: 0, successfulChecks: 0, percentage: null });
  });
  it("calcula com a amostra explícita", () => {
    expect(uptimeWindow(6, 5)).toEqual({ checks: 6, successfulChecks: 5, percentage: 83.33 });
    expect(uptimeWindow(3, 3).percentage).toBe(100);
    expect(uptimeWindow(3, 0).percentage).toBe(0);
  });
});

describe("cursor", () => {
  const id = "3fce024b-dde7-4aa6-9ef9-fd63be37ff98";
  it("ida e volta", () => {
    const c = cursorSchema.parse(encodeCursor(new Date("2026-10-27T01:24:56.461Z"), id));
    expect(c).toEqual({ at: new Date("2026-10-27T01:24:56.461Z"), id });
  });
  it.each(["", "abc", "x".repeat(200), Buffer.from("nao-e-data|" + id).toString("base64url"), Buffer.from("2026-10-27T00:00:00Z|nao-uuid").toString("base64url")])(
    "rejeita cursor inválido %#",
    (raw) => expect(cursorSchema.safeParse(raw).success).toBe(false),
  );
  it("paginate: só há próxima página se sobrou linha além do limite", () => {
    expect(paginate([1, 2, 3], 2, (n) => `c${n}`)).toEqual({ items: [1, 2], nextCursor: "c2" });
    expect(paginate([1, 2], 2, (n) => `c${n}`)).toEqual({ items: [1, 2], nextCursor: null });
    expect(paginate([], 2, () => "x")).toEqual({ items: [], nextCursor: null });
  });
});
