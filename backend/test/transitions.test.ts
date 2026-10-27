import { describe, expect, it } from "vitest";
import { nextTransition, type MonitorState } from "../src/domain/transitions.js";

const healthy: MonitorState = { status: "OPERATIONAL", consecutiveFailures: 0, hasOpenIncident: false };

describe("nextTransition", () => {
  it("uma única falha não abre incidente nem muda o estado", () => {
    expect(nextTransition(healthy, false)).toEqual({
      status: "OPERATIONAL",
      consecutiveFailures: 1,
      incident: "none",
    });
  });

  it("a segunda falha consecutiva torna indisponível e abre incidente", () => {
    const afterFirst: MonitorState = { ...healthy, consecutiveFailures: 1 };
    expect(nextTransition(afterFirst, false)).toEqual({
      status: "UNAVAILABLE",
      consecutiveFailures: 2,
      incident: "open",
    });
  });

  it("falhas adicionais não abrem um segundo incidente", () => {
    const down: MonitorState = { status: "UNAVAILABLE", consecutiveFailures: 2, hasOpenIncident: true };
    expect(nextTransition(down, false)).toEqual({
      status: "UNAVAILABLE",
      consecutiveFailures: 3,
      incident: "none",
    });
  });

  it("um sucesso resolve o incidente e volta a operacional", () => {
    const down: MonitorState = { status: "UNAVAILABLE", consecutiveFailures: 5, hasOpenIncident: true };
    expect(nextTransition(down, true)).toEqual({
      status: "OPERATIONAL",
      consecutiveFailures: 0,
      incident: "resolve",
    });
  });

  it("um sucesso entre duas falhas zera a contagem (falhas precisam ser consecutivas)", () => {
    const oneFail: MonitorState = { ...healthy, consecutiveFailures: 1 };
    const recovered = nextTransition(oneFail, true);
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.incident).toBe("none");
    expect(nextTransition({ ...healthy, consecutiveFailures: recovered.consecutiveFailures }, false).incident).toBe("none");
  });

  it("se já está indisponível sem incidente aberto, abre um (auto-correção)", () => {
    const odd: MonitorState = { status: "UNAVAILABLE", consecutiveFailures: 2, hasOpenIncident: false };
    expect(nextTransition(odd, false).incident).toBe("open");
  });
});
