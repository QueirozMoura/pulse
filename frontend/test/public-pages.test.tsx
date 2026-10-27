import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorPage } from "../src/pages/public/MonitorPage";
import { StatusPage } from "../src/pages/public/StatusPage";
import { apiError, mockApi } from "./api-mock";
import { NOW, check, iso, liveMonitor, mkMonitor } from "./fixtures";

const status = (monitors: unknown[], generatedAt = new Date(NOW).toISOString()) => ({ generatedAt, monitors });
const noIncidents = { incidents: [], nextCursor: null };
const renderStatus = () => render(<MemoryRouter><StatusPage /></MemoryRouter>);

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("página pública: os quatro estados", () => {
  it("mostra operacional, indisponível, pausado e sem dados, cada um com texto próprio (nunca só cor)", async () => {
    mockApi({
      "GET /public/status": status([
        liveMonitor("operational", 5000, { id: "a", name: "Site principal" }),
        liveMonitor("unavailable", 5000, { id: "b", name: "API de pagamentos" }),
        mkMonitor({ id: "c", name: "Painel interno", state: "paused" }),
        mkMonitor({ id: "d", name: "Novo monitor", state: "no_data" }),
      ]),
      "GET /public/incidents": noIncidents,
    });
    renderStatus();
    const rows = await screen.findAllByRole("listitem");
    const row = (name: string) => rows.find((r) => within(r).queryByRole("link", { name }))!;
    expect(within(row("Site principal")).getByText("Operacional")).toBeInTheDocument();
    expect(within(row("API de pagamentos")).getByText("Indisponível")).toBeInTheDocument();
    expect(within(row("Painel interno")).getByText("Pausado")).toBeInTheDocument();
    expect(within(row("Novo monitor")).getAllByText("Sem dados").length).toBeGreaterThanOrEqual(1);
    expect(within(row("Novo monitor")).getByText("Sem dados", { selector: ".badge span" })).toBeInTheDocument();
    expect(within(row("Painel interno")).getByText(/não está sendo checado/)).toBeInTheDocument();
    expect(within(row("Novo monitor")).getByText(/Não sabemos o estado/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("1 sistema com problema");
  });

  it("uptime de 24 h e 7 dias vem com o tamanho da amostra; sem checagens mostra 'Sem dados', nunca 0% nem 100%", async () => {
    mockApi({
      "GET /public/status": status([liveMonitor("operational", 5000, { id: "a", name: "Ativo" }), mkMonitor({ id: "d", name: "Vazio", state: "no_data" })]),
      "GET /public/incidents": noIncidents,
    });
    renderStatus();
    await screen.findByRole("link", { name: "Ativo" });
    const lis = screen.getAllByRole("listitem").filter((li) => li.classList.contains("system"));
    const active = lis.find((li) => li.textContent?.includes("Ativo"))!;
    const empty = lis.find((li) => li.textContent?.includes("Vazio"))!;
    expect(within(active).getAllByText("100%")).toHaveLength(2);
    expect(within(active).getAllByText("de 2880 checagens")).toHaveLength(1);
    expect(within(active).getByText("de 20160 checagens")).toBeInTheDocument();
    expect(within(empty).getAllByText("Sem dados").length).toBeGreaterThanOrEqual(2);
    expect(within(empty).queryByText(/%/)).toBeNull();
  });

  it("mostra a última checagem, a latência e a categoria da falha, sem URL", async () => {
    mockApi({ "GET /public/status": status([liveMonitor("unavailable", 12_000, { id: "b", name: "API" })]), "GET /public/incidents": noIncidents });
    renderStatus();
    await screen.findByRole("link", { name: "API" });
    expect(screen.getByText("há 12 s")).toBeInTheDocument();
    expect(screen.getByText("Falha de DNS")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/https?:\/\//);
    expect(screen.getByText(/Incidente em andamento desde/)).toBeInTheDocument();
  });

  it("tudo operacional e fresco → 'Todos os sistemas estão operacionais'", async () => {
    mockApi({ "GET /public/status": status([liveMonitor("operational", 5000, { id: "a" })]), "GET /public/incidents": noIncidents });
    renderStatus();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Todos os sistemas estão operacionais");
  });

  it("sistema sem dados impede o 'tudo operacional'", async () => {
    mockApi({
      "GET /public/status": status([liveMonitor("operational", 5000, { id: "a" }), mkMonitor({ id: "d", name: "Novo", state: "no_data" })]),
      "GET /public/incidents": noIncidents,
    });
    renderStatus();
    const h1 = await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(h1.textContent).not.toMatch(/Carregando/));
    expect(h1).not.toHaveTextContent(/Todos os sistemas/);
  });

  it("checagem atrasada vira aviso e tira o 'tudo operacional'", async () => {
    mockApi({ "GET /public/status": status([liveMonitor("operational", 20 * 60_000, { id: "a", name: "Atrasado" })]), "GET /public/incidents": noIncidents });
    renderStatus();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Checagens atrasadas");
    expect(screen.getByText(/mais do que o esperado/)).toBeInTheDocument();
    expect(screen.getByText("Operacional, checagem atrasada")).toBeInTheDocument();
  });

  it("lista vazia: mensagem de vazio, não 'operacional'", async () => {
    mockApi({ "GET /public/status": status([]), "GET /public/incidents": noIncidents });
    renderStatus();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Nenhum sistema monitorado ainda");
  });
});

describe("página pública: erro, desatualização e atualização periódica", () => {
  it("erro ao carregar sem dados: estado de erro com 'Tentar de novo', sem afirmar que está tudo bem", async () => {
    const api = mockApi({ "GET /public/status": apiError(500, "internal_error", "Erro interno"), "GET /public/incidents": noIncidents });
    renderStatus();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Não foi possível carregar o estado dos sistemas");
    expect(screen.getByText(/Isso não significa que os sistemas estejam fora do ar/)).toBeInTheDocument();
    api.set("GET /public/status", status([liveMonitor("operational", 5000, { id: "a" })]));
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getAllByRole("button", { name: "Tentar de novo" })[0]!);
    expect(await screen.findByRole("heading", { level: 1, name: /operacionais/ })).toBeInTheDocument();
  });

  it("falha de rede também vira erro (não tela em branco)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderStatus();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Não foi possível carregar");
  });

  it("atualiza sozinho a cada 30 s, sem recarregar a página", async () => {
    const api = mockApi({ "GET /public/status": status([liveMonitor("operational", 5000, { id: "a", name: "Site" })]), "GET /public/incidents": noIncidents });
    renderStatus();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Todos os sistemas estão operacionais");
    expect(api.count("GET /public/status")).toBe(1);
    api.set("GET /public/status", status([liveMonitor("unavailable", 3000, { id: "a", name: "Site" })], new Date(NOW + 30_000).toISOString()));
    await advance(30_500);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("1 sistema com problema"));
    expect(api.count("GET /public/status")).toBe(2);
  });

  it("se a atualização falha, mantém a última leitura com aviso; passados 3 ciclos vira 'Dados desatualizados'", async () => {
    const api = mockApi({ "GET /public/status": status([liveMonitor("operational", 5000, { id: "a", name: "Site" })]), "GET /public/incidents": noIncidents });
    renderStatus();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Todos os sistemas estão operacionais");

    api.set("GET /public/status", apiError(503, "internal_error", "Erro interno"));
    await advance(31_000);
    expect(await screen.findByText("Falha ao atualizar")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Site" })).toBeInTheDocument(); // a leitura anterior continua visível
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Todos os sistemas estão operacionais"); // ainda recente (31 s)

    await advance(120_000);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dados desatualizados"));
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveTextContent(/operacionais/);
    expect(screen.getByText(/pode não refletir a situação atual/)).toBeInTheDocument();
  });

  it("incidentes: lista abertos e resolvidos com a duração, e 'carregar mais' usa o cursor", async () => {
    const page1 = {
      incidents: [
        { id: "i1", monitorId: "a", monitorName: "API", status: "open", startedAt: iso(300_000), resolvedAt: null, durationSeconds: null },
        { id: "i2", monitorId: "b", monitorName: "Blog", status: "resolved", startedAt: iso(9e6), resolvedAt: iso(9e6 - 62_000), durationSeconds: 62 },
      ],
      nextCursor: "CUR1",
    };
    const api = mockApi({
      "GET /public/status": status([liveMonitor("operational", 5000, { id: "a" })]),
      "GET /public/incidents": (c) => (c.query.cursor === "CUR1" ? { incidents: [{ id: "i3", monitorId: "a", monitorName: "Antigo", status: "resolved", startedAt: iso(9e8), resolvedAt: iso(9e8 - 5000), durationSeconds: 5 }], nextCursor: null } : page1),
    });
    renderStatus();
    expect(await screen.findByText("Em andamento")).toBeInTheDocument();
    expect(screen.getByText((_, el) => !!el?.classList.contains("incident__meta") && /durou 1 min 2 s/.test(el.textContent ?? ""))).toBeInTheDocument();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Carregar incidentes mais antigos" }));
    expect(await screen.findByRole("link", { name: "Antigo" })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === "/public/incidents" && c.query.cursor === "CUR1")).toBe(true);
    expect(screen.queryByRole("button", { name: "Carregar incidentes mais antigos" })).toBeNull();
  });

  it("sem incidentes: mensagem de vazio", async () => {
    mockApi({ "GET /public/status": status([liveMonitor("operational", 5000, { id: "a" })]), "GET /public/incidents": noIncidents });
    renderStatus();
    expect(await screen.findByText("Nenhum incidente registrado")).toBeInTheDocument();
  });

  it("rotas públicas não enviam cookie nem token", async () => {
    const api = mockApi({ "GET /public/status": status([]), "GET /public/incidents": noIncidents });
    renderStatus();
    await screen.findByRole("heading", { level: 1 });
    expect(api.calls.every((c) => c.credentials === "omit" && !c.headers["x-csrf-token"])).toBe(true);
  });
});

describe("página de detalhe", () => {
  const renderDetail = (id = "m1") =>
    render(
      <MemoryRouter initialEntries={[`/s/${id}`]}>
        <Routes>
          <Route path="s/:id" element={<MonitorPage />} />
          <Route path="/" element={<p>início</p>} />
        </Routes>
      </MemoryRouter>,
    );
  const page = (...agos: number[]) => agos.map((a) => check(a));

  it("histórico paginado: 'carregar mais' acrescenta as antigas pelo cursor, sem repetir", async () => {
    const api = mockApi({
      "GET /public/monitors/m1": liveMonitor("operational", 5000, { id: "m1", name: "Site" }),
      "GET /public/monitors/m1/history": (c) =>
        c.query.cursor === "OLD" ? { monitorId: "m1", checks: page(120_000, 150_000), nextCursor: null } : { monitorId: "m1", checks: page(5000, 35_000, 65_000, 95_000), nextCursor: "OLD" },
      "GET /public/incidents": noIncidents,
    });
    renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: "Site" })).toBeInTheDocument();
    await screen.findByText("4 carregadas");
    expect(screen.getAllByRole("row")).toHaveLength(1 + 4);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Carregar checagens mais antigas" }));
    await screen.findByText("6 carregadas");
    expect(screen.getAllByRole("row")).toHaveLength(1 + 6);
    expect(api.last("GET /public/monitors/m1/history")?.query.cursor).toBe("OLD");
    expect(screen.queryByRole("button", { name: "Carregar checagens mais antigas" })).toBeNull();
  });

  it("mostra uptime com amostra, última checagem e o gráfico com resumo acessível; incidentes do sistema", async () => {
    mockApi({
      "GET /public/monitors/m1": liveMonitor("operational", 5000, { id: "m1", name: "Site" }),
      "GET /public/monitors/m1/history": { monitorId: "m1", checks: [check(5000), check(35_000, { success: false, statusCode: null, errorKind: "timeout" }), check(65_000)], nextCursor: null },
      "GET /public/incidents": (c) => ({ incidents: c.query.monitorId === "m1" ? [{ id: "i1", monitorId: "m1", monitorName: "Site", status: "resolved", startedAt: iso(9e6), resolvedAt: iso(9e6 - 90_000), durationSeconds: 90 }] : [], nextCursor: null }),
    });
    renderDetail();
    await screen.findByRole("heading", { level: 1, name: "Site" });
    expect(screen.getByText("de 2880 checagens")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Gráfico de latência com 3 checagens, 1 falha/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /2 com sucesso e 1 falha/ })).toBeInTheDocument();
    expect(await screen.findByText((_, el) => !!el?.classList.contains("incident__meta") && /durou 1 min 30 s/.test(el.textContent ?? ""))).toBeInTheDocument();
    expect(screen.getByText("Falha: tempo esgotado")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/https?:\/\//);
  });

  it("sistema pausado e sem dados têm avisos próprios, sem parecer operacionais", async () => {
    mockApi({
      "GET /public/monitors/m1": mkMonitor({ id: "m1", name: "Parado", state: "paused" }),
      "GET /public/monitors/m1/history": { monitorId: "m1", checks: [], nextCursor: null },
      "GET /public/incidents": noIncidents,
    });
    renderDetail();
    expect(await screen.findByText("Sistema pausado")).toBeInTheDocument();
    expect(await screen.findByText("Sem checagens registradas")).toBeInTheDocument();
  });

  it("sem dados: aviso 'Ainda sem checagens'", async () => {
    mockApi({
      "GET /public/monitors/m1": mkMonitor({ id: "m1", name: "Novo", state: "no_data" }),
      "GET /public/monitors/m1/history": { monitorId: "m1", checks: [], nextCursor: null },
      "GET /public/incidents": noIncidents,
    });
    renderDetail();
    expect(await screen.findByText("Ainda sem checagens")).toBeInTheDocument();
    expect(screen.getAllByText("Sem dados").length).toBeGreaterThan(0);
  });

  it("sistema inexistente (404): mensagem clara e link de volta", async () => {
    mockApi({
      "GET /public/monitors/zzz": apiError(404, "not_found", "Monitor não encontrado"),
      "GET /public/monitors/zzz/history": apiError(404, "not_found", "Monitor não encontrado"),
      "GET /public/incidents": noIncidents,
    });
    renderDetail("zzz");
    expect(await screen.findByText("Sistema não encontrado")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /sistemas/i }).length).toBeGreaterThan(0);
  });

  it("falha ao carregar (rede): erro com nova tentativa, sem dizer que o sistema caiu", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderDetail();
    expect(await screen.findByText("Não foi possível carregar este sistema")).toBeInTheDocument();
    expect(screen.getByText(/não significa que ele esteja fora do ar/)).toBeInTheDocument();
  });
});
