import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { csrf } from "../src/api/client";
import { PublicLayout } from "../src/components/Layouts";
import { useAfter } from "../src/hooks/usePolling";
import { StatusPage } from "../src/pages/public/StatusPage";
import { mockApi } from "./api-mock";
import { NOW, iso, mkMonitor } from "./fixtures";

const noIncidents = { incidents: [], nextCursor: null };

/** Monitor de 15 min (96 checagens em 24 h), checado há `agoMin` minutos. */
const every15 = (agoMin: number, state: "operational" | "unavailable" = "operational") =>
  mkMonitor({
    id: "m1",
    name: "Site principal",
    state,
    monitoringSince: iso(3 * 86_400_000),
    lastCheck: { checkedAt: iso(agoMin * 60_000), success: state === "operational", statusCode: 200, latencyMs: 80, errorKind: null },
    uptime: { last24h: { checks: 96, successfulChecks: 96, percentage: 100 }, last7d: { checks: 672, successfulChecks: 672, percentage: 100 } },
  });

describe("plano gratuito: rodadas de 15 min na página pública", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW }));
  afterEach(() => vi.useRealTimers());

  const renderStatus = (monitors: unknown[], rounds: { everyMinutes: number } | null = { everyMinutes: 15 }) => {
    mockApi({ "GET /public/status": { generatedAt: new Date(NOW).toISOString(), checkRounds: rounds, monitors }, "GET /public/incidents": noIncidents });
    return render(<MemoryRouter><StatusPage /></MemoryRouter>);
  };

  it("explica que as checagens são em rodadas e mostra a idade da checagem mais recente", async () => {
    renderStatus([every15(9)]);
    expect(await screen.findByText(/rodadas agendadas, aproximadamente a cada 15 min/)).toBeInTheDocument();
    expect(screen.getByText(/Checagem mais recente há 9 min/)).toBeInTheDocument();
  });

  it("sem checkRounds (scheduler contínuo) não promete rodadas", async () => {
    renderStatus([every15(1)], null);
    await screen.findByText(/Checagem mais recente/);
    expect(screen.queryByText(/rodadas agendadas/)).toBeNull();
  });

  it("uma rodada atrasada em 20 min NÃO vira 'checagem atrasada' (45 min = 3 rodadas)", async () => {
    renderStatus([every15(35)]);
    expect(await screen.findByRole("heading", { level: 1, name: "Todos os sistemas estão operacionais" })).toBeInTheDocument();
  });

  it("mas 2 h sem checagem num monitor de 15 min é atraso real: nunca 'tudo operacional'", async () => {
    renderStatus([every15(120)]);
    expect(await screen.findByRole("heading", { level: 1, name: "Checagens atrasadas" })).toBeInTheDocument();
    expect(screen.queryByText("Todos os sistemas estão operacionais")).toBeNull();
  });

  it("indisponível, sem dados e atrasadas continuam distintos", async () => {
    renderStatus([every15(5, "unavailable"), mkMonitor({ id: "m2", name: "Novo", state: "no_data" })]);
    expect(await screen.findByRole("heading", { level: 1, name: "1 sistema com problema" })).toBeInTheDocument();
    expect(screen.getAllByText(/Sem dados/i).length).toBeGreaterThan(0);
  });

  it("o rodapé não promete atualização a cada 30 segundos nem detecção em 1 minuto", () => {
    mockApi({});
    render(<MemoryRouter><PublicLayout /></MemoryRouter>);
    const footer = document.querySelector("footer")!.textContent!;
    expect(footer).not.toMatch(/30 segundos|1 minuto|em segundos/);
    expect(footer).toMatch(/rodadas agendadas/);
  });
});

describe("aviso de servidor acordando", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("useAfter só vira true depois da espera e volta a false quando termina de carregar", () => {
    const { result, rerender } = renderHook(({ active }) => useAfter(8000, active), { initialProps: { active: true } });
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(7999));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(2));
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});

describe("painel: intervalos compatíveis com o servidor", () => {
  beforeEach(() => csrf.clear());
  afterEach(() => vi.unstubAllGlobals());

  const SESSION = { username: "admin", csrfToken: "c1", expiresAt: "2026-10-28T00:00:00.000Z" };

  it("com mínimo de 15 min, o seletor não oferece 30 s, 1 min nem 5 min", async () => {
    mockApi({ "GET /auth/session": { ...SESSION, limits: { minIntervalSeconds: 900, maxMonitors: 100 } }, "GET /monitors": { monitors: [] } });
    const ui = userEvent.setup();
    render(<MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter>);
    await ui.click(await screen.findAllByRole("button", { name: "Novo monitor" }).then((b) => b[0]!));
    const select = (await screen.findByLabelText("Intervalo entre checagens")) as HTMLSelectElement;
    const labels = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(labels[0]).toMatch(/15 minutos/);
    expect(labels.join("|")).not.toMatch(/(^|\|)(30 s|1 minuto|2 minutos|5 minutos|10 minutos)(\||$)/);
    expect(Number(select.value)).toBeGreaterThanOrEqual(900);
    expect(screen.getByText(/Menor intervalo aceito: 15 minutos/)).toBeInTheDocument();
  });

  it("sem 'limits' (servidor antigo) mantém os presets curtos", async () => {
    mockApi({ "GET /auth/session": SESSION, "GET /monitors": { monitors: [] } });
    const ui = userEvent.setup();
    render(<MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter>);
    await ui.click((await screen.findAllByRole("button", { name: "Novo monitor" }))[0]!);
    const select = await screen.findByLabelText("Intervalo entre checagens");
    expect(within(select).getAllByRole("option")[0]!.textContent).toMatch(/30/);
  });

  it("a primeira checagem não é prometida 'em poucos segundos'", async () => {
    mockApi({ "GET /auth/session": SESSION, "GET /monitors": { monitors: [] } });
    render(<MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter>);
    expect(await screen.findByText(/próxima rodada do worker/)).toBeInTheDocument();
    expect(screen.queryByText(/poucos segundos/)).toBeNull();
  });
});

describe("VITE_ADMIN_URL (site estático ≠ origem do painel)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const replace = vi.fn();
  beforeEach(() => {
    replace.mockReset();
    vi.stubGlobal("location", { ...window.location, replace });
  });

  it("redireciona /admin* para o painel na API (https) e nunca chama /auth no site estático", async () => {
    vi.stubEnv("VITE_ADMIN_URL", "https://pulse-api.onrender.com/");
    const api = mockApi({});
    render(<MemoryRouter initialEntries={["/admin/monitores"]}><App /></MemoryRouter>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("https://pulse-api.onrender.com/admin/monitores"));
    expect(api.calls).toHaveLength(0);
  });

  it("recusa destinos que não sejam https (ex.: javascript:)", () => {
    vi.stubEnv("VITE_ADMIN_URL", "javascript:alert(1)");
    mockApi({ "GET /auth/session": { username: "a", csrfToken: "c", expiresAt: "2026-10-28T00:00:00.000Z" }, "GET /monitors": { monitors: [] } });
    render(<MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter>);
    expect(replace).not.toHaveBeenCalled();
  });
});
